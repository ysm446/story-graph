"""GGUF のメタデータ(ヘッダー)だけを読み、VRAM の目安に使う値を出す。

モデル本体(テンソル)は読まない。llama-server を全層 GPU(`--n-gpu-layers 999`)・
KV キャッシュ f16 で起動する前提で、

    VRAM ≈ 重み(ファイルの大きさ) + KV キャッシュ + 作業領域

の KV キャッシュを、コンテキスト長に比例する部分と比例しない部分に分けて返す。
画面(設定の Context Length)はこの値にコンテキスト長を掛けて目安を出す。

KV を持つ層の決め方(llama.cpp に合わせる):
- `attention.sliding_window_pattern` が True の層はスライディングウィンドウ層。
  直近 `sliding_window` トークンぶんしか持たないので、コンテキスト長に比例しない
- `attention.shared_kv_layers`(Gemma の E 系): 末尾の N 層は前の層の KV を使い回すので数えない
- `full_attention_interval`(Qwen3.5 系のハイブリッド): その間隔の層だけが通常の注意層で、
  ほかは状態が一定の層(SSM)。状態の大きさはおおよそで見積もる
- `nextn_predict_layers`: 末尾の先読み用の層は KV を持たないものとして数えない
"""
from __future__ import annotations

import struct
from pathlib import Path
from typing import Any, BinaryIO

_SCALAR = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
_STRING = 8
_ARRAY = 9
# 層ごとの値(head_count_kv など)は層の数ぶんの短い配列。語彙のような長い配列は読み飛ばす
_ARRAY_KEEP_MAX = 4096
_F16 = 2  # KV キャッシュは f16(llama-server の既定)
_F32 = 4  # SSM の状態は f32


def _read_str(f: BinaryIO) -> str:
    (n,) = struct.unpack("<Q", f.read(8))
    return f.read(n).decode("utf-8", "replace")


def _skip_str(f: BinaryIO) -> None:
    (n,) = struct.unpack("<Q", f.read(8))
    f.seek(n, 1)


def _read_value(f: BinaryIO, vtype: int) -> Any:
    if vtype in _SCALAR:
        fmt = _SCALAR[vtype]
        return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]
    if vtype == _STRING:
        return _read_str(f)
    if vtype == _ARRAY:
        (itype,) = struct.unpack("<I", f.read(4))
        (n,) = struct.unpack("<Q", f.read(8))
        if itype in _SCALAR and n <= _ARRAY_KEEP_MAX:
            return [_read_value(f, itype) for _ in range(n)]
        if itype in _SCALAR:
            f.seek(struct.calcsize(_SCALAR[itype]) * n, 1)
        elif itype == _STRING:
            for _ in range(n):
                _skip_str(f)
        else:
            for _ in range(n):
                _read_value(f, itype)
        return None
    raise ValueError(f"GGUF の値の型が分かりません: {vtype}")


def read_header(path: str | Path) -> tuple[dict[str, Any], dict[str, int]]:
    """GGUF のメタデータ(キーと値)と、テンソルごとのバイト数を読む。
    長い配列(語彙など)と文字列の配列は None にする。テンソルの大きさは、データ領域の中の
    オフセットの差から出す(量子化の型ごとの表を持たずに済む)"""
    p = Path(path)
    with open(p, "rb") as f:
        if f.read(4) != b"GGUF":
            raise ValueError(f"GGUF ファイルではありません: {path}")
        version, tensor_count, kv_count = struct.unpack("<IQQ", f.read(20))
        if version < 2:
            raise ValueError(f"古い GGUF(v{version})には対応していません: {path}")
        meta: dict[str, Any] = {}
        for _ in range(kv_count):
            key = _read_str(f)
            (vtype,) = struct.unpack("<I", f.read(4))
            meta[key] = _read_value(f, vtype)
        offsets: list[tuple[int, str]] = []
        for _ in range(tensor_count):
            name = _read_str(f)
            (n_dims,) = struct.unpack("<I", f.read(4))
            f.seek(8 * n_dims, 1)
            _ttype, offset = struct.unpack("<IQ", f.read(12))
            offsets.append((offset, name))
        alignment = int(meta.get("general.alignment", 32) or 32)
        data_start = (f.tell() + alignment - 1) // alignment * alignment
    data_size = p.stat().st_size - data_start
    offsets.sort()
    sizes: dict[str, int] = {}
    for i, (offset, name) in enumerate(offsets):
        end = offsets[i + 1][0] if i + 1 < len(offsets) else data_size
        sizes[name] = max(0, end - offset)
    return meta, sizes


def read_metadata(path: str | Path) -> dict[str, Any]:
    return read_header(path)[0]


def _per_layer(value: Any, n_layer: int, default: int) -> list[int]:
    if isinstance(value, list) and value:
        return [int(v) for v in value[:n_layer]] + [int(value[-1])] * max(0, n_layer - len(value))
    return [int(value if value is not None else default)] * n_layer


def kv_profile(meta: dict[str, Any]) -> dict[str, Any]:
    """KV キャッシュの大きさを決める値。

    kv_bytes_per_token: 通常の注意層の、1 トークンあたりの KV(コンテキスト長に比例)
    swa_bytes_per_token: スライディングウィンドウ層の、1 トークンあたりの KV
                         (sliding_window トークンぶんまでしか増えない)
    state_bytes: SSM 層の状態(コンテキスト長によらない一定量。おおよそ)
    """
    arch = str(meta.get("general.architecture") or "")

    def get(name: str, default: Any = None) -> Any:
        return meta.get(f"{arch}.{name}", default)

    n_layer = int(get("block_count", 0))
    n_embd = int(get("embedding_length", 0))
    head_count = _per_layer(get("attention.head_count"), n_layer, 1)
    head_count_kv = _per_layer(get("attention.head_count_kv"), n_layer, head_count[0] if head_count else 1)
    head_dim_default = n_embd // head_count[0] if n_layer and head_count[0] else 0
    k_len = int(get("attention.key_length", head_dim_default))
    v_len = int(get("attention.value_length", head_dim_default))
    k_len_swa = int(get("attention.key_length_swa", k_len))
    v_len_swa = int(get("attention.value_length_swa", v_len))
    window = int(get("attention.sliding_window", 0) or 0)
    pattern = get("attention.sliding_window_pattern")
    shared = int(get("attention.shared_kv_layers", 0) or 0)
    nextn = int(get("nextn_predict_layers", 0) or 0)
    interval = int(get("full_attention_interval", 0) or 0)

    kv_layers = max(0, n_layer - shared - nextn)
    kv_full = 0
    kv_swa = 0
    recurrent_layers = 0
    for i in range(kv_layers):
        if interval > 1 and (i + 1) % interval != 0:
            recurrent_layers += 1
            continue
        is_swa = window > 0 and isinstance(pattern, list) and i < len(pattern) and bool(pattern[i])
        if is_swa:
            kv_swa += head_count_kv[i] * (k_len_swa + v_len_swa) * _F16
        else:
            kv_full += head_count_kv[i] * (k_len + v_len) * _F16

    # SSM 層の状態: 畳み込みの状態 + 状態行列(どちらも f32)。llama.cpp の実装に依らない粗い目安
    state = 0
    if recurrent_layers:
        conv_kernel = int(get("ssm.conv_kernel", 0) or 0)
        state_size = int(get("ssm.state_size", 0) or 0)
        inner = int(get("ssm.inner_size", 0) or 0)
        groups = int(get("ssm.group_count", 0) or 0)
        per_layer = max(0, conv_kernel - 1) * (inner + 2 * groups * state_size) + inner * state_size
        state = recurrent_layers * per_layer * _F32

    return {
        "architecture": arch,
        "layers": n_layer,
        "context_length": int(get("context_length", 0) or 0),
        "kv_bytes_per_token": kv_full,
        "swa_bytes_per_token": kv_swa,
        "sliding_window": window if kv_swa else 0,
        "state_bytes": state,
    }


# ---- VRAM の目安 ---------------------------------------------------------
#
# llama-server(b10430)を全層 GPU・flash-attn・KV f16 で起動したときの実測から決めた係数
# (2026-10-18。gemma-4-E2B / E4B の 16K・64K で、目安と実測の差は 2〜3%):
# - llama-server は既定で 4 本を同時に処理する(n_seq_max = 4、KV は共有)。通常の層の KV は
#   コンテキスト長ぶん、ウィンドウ層の KV は「ウィンドウ × 4 + 512(ubatch)」トークンぶん
# - 作業領域(compute buffer)は FFN の幅 × 512 トークン × 約 20 バイトに、
#   マスク(コンテキスト長 × 512 × f16)が乗る
# - CUDA の起動などの固定費が約 360 MiB
N_SEQ = 4
UBATCH = 512
OVERHEAD_BYTES = 360 * 1024 * 1024
COMPUTE_BYTES_PER_FFN = UBATCH * 20
COMPUTE_BYTES_PER_TOKEN = UBATCH * _F16
# GPU に載らない重み: 入力の埋め込みは CPU に置かれる。出力層が埋め込みと共有(output.weight が無い)
# なら GPU に出力用の複製が載るので差し引かない。Gemma の E 系の層別の埋め込みも CPU
_CPU_TENSORS = ("per_layer_token_embd.weight",)


def gpu_weight_bytes(sizes: dict[str, int]) -> int:
    total = sum(sizes.values())
    total -= sum(sizes.get(name, 0) for name in _CPU_TENSORS)
    if "output.weight" in sizes:
        total -= sizes.get("token_embd.weight", 0)
    return total


def _ffn_width(meta: dict[str, Any]) -> int:
    arch = str(meta.get("general.architecture") or "")
    ffn = meta.get(f"{arch}.feed_forward_length", 0)
    width = max(ffn) if isinstance(ffn, list) and ffn else int(ffn or 0)
    expert_ffn = int(meta.get(f"{arch}.expert_feed_forward_length", 0) or 0)
    expert_used = int(meta.get(f"{arch}.expert_used_count", 0) or 0)
    return max(width, expert_ffn * expert_used)


def model_profile(path: str | Path) -> dict[str, Any]:
    """設定画面の VRAM の目安に使う値。estimate_bytes にコンテキスト長と一緒に渡す"""
    meta, sizes = read_header(path)
    profile = kv_profile(meta)
    profile["file_bytes"] = Path(path).stat().st_size
    profile["weights_bytes"] = gpu_weight_bytes(sizes)
    profile["compute_base_bytes"] = _ffn_width(meta) * COMPUTE_BYTES_PER_FFN
    return profile


def estimate_bytes(profile: dict[str, Any], ctx: int) -> dict[str, int]:
    """コンテキスト長 ctx で起動したときの VRAM の目安(バイト)。内訳も返す"""
    swa_cells = min(ctx, profile["sliding_window"] * N_SEQ + UBATCH) if profile["sliding_window"] else 0
    kv = ctx * profile["kv_bytes_per_token"] + swa_cells * profile["swa_bytes_per_token"]
    kv += profile["state_bytes"] * N_SEQ
    compute = profile["compute_base_bytes"] + ctx * COMPUTE_BYTES_PER_TOKEN + OVERHEAD_BYTES
    weights = profile["weights_bytes"]
    return {"ctx": ctx, "weights": weights, "kv": kv, "compute": compute, "total": weights + kv + compute}
