"""GGUF のヘッダーから VRAM の目安を出す(gguf_info)のテスト。

実物のモデルは大きいので、ヘッダーだけの小さな GGUF をその場で書いて確かめる。
係数そのもの(作業領域・固定費)は実測で決めた値なので、ここでは KV の数え方と重みの差し引きを見る。
"""
import asyncio
import struct

import httpx
import pytest

import db
import embed
import gguf_info
from store import Store


def _str(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack("<Q", len(b)) + b


def _kv(key: str, value) -> bytes:
    out = _str(key)
    if isinstance(value, bool):
        return out + struct.pack("<I?", 7, value)
    if isinstance(value, int):
        return out + struct.pack("<II", 4, value)
    if isinstance(value, str):
        return out + struct.pack("<I", 8) + _str(value)
    if isinstance(value, list) and value and isinstance(value[0], bool):
        return out + struct.pack("<IIQ", 9, 7, len(value)) + b"".join(struct.pack("<?", v) for v in value)
    if isinstance(value, list) and value and isinstance(value[0], str):
        return out + struct.pack("<IIQ", 9, 8, len(value)) + b"".join(_str(v) for v in value)
    if isinstance(value, list):
        return out + struct.pack("<IIQ", 9, 4, len(value)) + b"".join(struct.pack("<I", v) for v in value)
    raise TypeError(value)


def write_gguf(path, meta: dict, tensors: dict[str, int]) -> None:
    """tensors はテンソル名 → バイト数。中身は 0 で埋める"""
    body = b"".join(_kv(k, v) for k, v in meta.items())
    infos = b""
    offset = 0
    for name, size in tensors.items():
        infos += _str(name) + struct.pack("<I", 1) + struct.pack("<Q", size) + struct.pack("<IQ", 0, offset)
        offset += (size + 31) // 32 * 32
    header = b"GGUF" + struct.pack("<IQQ", 3, len(tensors), len(meta)) + body + infos
    header += b"\0" * ((32 - len(header) % 32) % 32)
    data = b""
    for size in tensors.values():
        data += b"\0" * ((size + 31) // 32 * 32)
    path.write_bytes(header + data)


GEMMA_LIKE = {
    "general.architecture": "gemma4",
    "gemma4.block_count": 6,
    "gemma4.context_length": 131072,
    "gemma4.embedding_length": 64,
    "gemma4.feed_forward_length": 256,
    "gemma4.attention.head_count": 4,
    # 層ごと(全体を見る層は KV ヘッドが少ない)
    "gemma4.attention.head_count_kv": [2, 2, 1, 2, 2, 1],
    "gemma4.attention.key_length": 32,
    "gemma4.attention.value_length": 32,
    "gemma4.attention.key_length_swa": 16,
    "gemma4.attention.value_length_swa": 16,
    "gemma4.attention.sliding_window": 128,
    "gemma4.attention.sliding_window_pattern": [True, True, False, True, True, False],
    # 末尾 1 層は前の層の KV を使い回す
    "gemma4.attention.shared_kv_layers": 1,
    # 語彙のような長い文字列の配列は読み飛ばす
    "tokenizer.ggml.tokens": [f"t{i}" for i in range(5000)],
}


def test_kv_profile_counts_window_and_shared_layers(tmp_path):
    path = tmp_path / "gemma.gguf"
    write_gguf(path, GEMMA_LIKE, {"token_embd.weight": 1000, "blk.0.ffn_up.weight": 4000})
    profile = gguf_info.model_profile(path)
    # 共有の 1 層(末尾)を除いた 5 層のうち、全体を見るのは 2 番目の 1 層だけ(5 番目は共有で数えない)
    assert profile["kv_bytes_per_token"] == 1 * (32 + 32) * 2
    # ウィンドウ層は 0, 1, 3, 4 の 4 層
    assert profile["swa_bytes_per_token"] == (2 + 2 + 2 + 2) * (16 + 16) * 2
    assert profile["sliding_window"] == 128
    assert profile["context_length"] == 131072
    # 出力層が埋め込みと共有(output.weight が無い)なので、埋め込みは GPU に複製が載る扱いで引かない
    assert profile["weights_bytes"] == 1024 + 4000  # 埋め込みは 32 バイト境界まで詰め物が入る


def test_estimate_caps_window_cells_and_scales_with_context(tmp_path):
    path = tmp_path / "gemma.gguf"
    write_gguf(path, GEMMA_LIKE, {"token_embd.weight": 1000})
    profile = gguf_info.model_profile(path)
    small = gguf_info.estimate_bytes(profile, 4096)
    large = gguf_info.estimate_bytes(profile, 65536)
    swa_cells = 128 * gguf_info.N_SEQ + gguf_info.UBATCH
    assert small["kv"] == 4096 * profile["kv_bytes_per_token"] + swa_cells * profile["swa_bytes_per_token"]
    # ウィンドウ層はコンテキスト長を伸ばしても増えない。増えるのは通常の層とマスクだけ
    assert large["kv"] - small["kv"] == (65536 - 4096) * profile["kv_bytes_per_token"]
    assert large["compute"] - small["compute"] == (65536 - 4096) * gguf_info.COMPUTE_BYTES_PER_TOKEN
    assert large["total"] == large["weights"] + large["kv"] + large["compute"]


def test_hybrid_model_counts_only_full_attention_layers(tmp_path):
    path = tmp_path / "qwen.gguf"
    meta = {
        "general.architecture": "qwen35",
        "qwen35.block_count": 9,
        "qwen35.embedding_length": 64,
        "qwen35.feed_forward_length": 128,
        "qwen35.attention.head_count": 4,
        "qwen35.attention.head_count_kv": 2,
        "qwen35.attention.key_length": 16,
        "qwen35.attention.value_length": 16,
        "qwen35.full_attention_interval": 4,
        "qwen35.nextn_predict_layers": 1,
        "qwen35.ssm.conv_kernel": 4,
        "qwen35.ssm.state_size": 8,
        "qwen35.ssm.inner_size": 32,
        "qwen35.ssm.group_count": 2,
    }
    # 出力層が別にあるときは、入力の埋め込み(CPU に置かれる)を引く
    write_gguf(path, meta, {"token_embd.weight": 2048, "output.weight": 2048, "blk.0.attn_q.weight": 512})
    profile = gguf_info.model_profile(path)
    # 先読みの 1 層を除いた 8 層のうち、4 層ごとの 3・7 番目(0 始まり)だけが通常の注意層
    assert profile["kv_bytes_per_token"] == 2 * 2 * (16 + 16) * 2
    assert profile["swa_bytes_per_token"] == 0
    assert profile["state_bytes"] == 6 * ((4 - 1) * (32 + 2 * 2 * 8) + 32 * 8) * 4
    assert profile["weights_bytes"] == 2048 + 512


def test_rejects_non_gguf(tmp_path):
    path = tmp_path / "x.gguf"
    path.write_bytes(b"NOPE" + b"\0" * 64)
    with pytest.raises(ValueError):
        gguf_info.model_profile(path)


def test_vram_estimate_endpoint(tmp_path, monkeypatch):
    import app as api
    import system_info

    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    monkeypatch.setattr(system_info, "resources", lambda: {"vram_total": 48 * 1024**3, "vram_used": 0})
    store = Store(db.connect(":memory:"))
    monkeypatch.setattr(api, "store", store)
    path = tmp_path / "gemma.gguf"
    write_gguf(path, GEMMA_LIKE, {"token_embd.weight": 1000})

    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as c:
            r = await c.get("/llm/vram_estimate", params={"model": str(path), "ctx": "4096,16384"})
            assert r.status_code == 200
            body = r.json()
            assert [e["ctx"] for e in body["estimates"]] == [4096, 16384]
            assert body["estimates"][1]["total"] > body["estimates"][0]["total"]
            assert body["vram_total"] == 48 * 1024**3
            assert (await c.get("/llm/vram_estimate", params={"model": str(tmp_path / "none.gguf"), "ctx": "4096"})).status_code == 404
            assert (await c.get("/llm/vram_estimate", params={"model": str(path), "ctx": "abc"})).status_code == 400

    asyncio.run(check())
    store.conn.close()
