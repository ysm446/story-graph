"""この PC のアプリ単位の設定(環境設定)。

設定は長くライブラリ(ルートフォルダ)の DB の settings 表だけに置いていたので、モデルの場所や
接続先のような PC に依存する値まで、ライブラリを切り替えるたびに設定し直すことになっていた
(別の PC へ持っていくと前の PC のパスが付いてきて、スナップショットを復元すると昔の値へ戻った)。
PC に依存する値はここ(アプリのユーザーデータの settings.json)に置き、作品に依存する値は
ライブラリに残す(2026-10-13 ユーザー判断: LLM・ComfyUI・TTS の環境はアプリ単位。
ComfyUI はチェックポイントや生成パラメータも含めてアプリ単位。バックアップの保存先はライブラリ単位)。

呼び出し側は今までどおり Store.get_settings / set_settings を使う。どちらに置くかはキーで決まる。

- 保存先は環境変数 STORY_GRAPH_APP_DATA(Electron の userData)。未設定(テスト、バックエンド単体の
  起動)では無効で、すべてライブラリの DB に置く従来の動作になる
- 移行: アプリの設定にまだ無いキーは、開いているライブラリの値を引き継いで保存する。
  ライブラリ側の値は消さない(読まなくなるだけ。古い版のアプリでもそのまま動く)
"""

from __future__ import annotations

import json
import os
from pathlib import Path

FILE_NAME = "settings.json"

# アプリ単位にするキー。ここに無いキーはライブラリ単位
APP_KEYS = frozenset({
    # LLM(llama.cpp)
    "models_dir", "llm_model_path", "llama_server_path", "llm_base_url", "llm_ctx_size",
    # TTS(サーバーとエンジン。声の割り当てや読みの辞書は作品ごとなのでライブラリ)
    "tts_base_url", "tts_models_dir", "tts_engine", "tts_extra_body",
    # 画面の好み
    "chat_dynamic_suggestions",
})
# ComfyUI は接続先・モデル・生成パラメータ・ネガティブプロンプトまで、すべてアプリ単位
APP_PREFIXES = ("comfy_",)


def is_app_key(key: str) -> bool:
    return key in APP_KEYS or key.startswith(APP_PREFIXES)


def path() -> Path | None:
    root = os.environ.get("STORY_GRAPH_APP_DATA")
    return Path(root) / FILE_NAME if root else None


def enabled() -> bool:
    return path() is not None


def load() -> dict[str, str]:
    target = path()
    if target is None:
        return {}
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(raw, dict) else {}


def save(values: dict[str, str]) -> None:
    target = path()
    if target is None:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    # 書きかけで落ちても前の設定を壊さないよう、別名で書いてから差し替える
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, target)


def update(values: dict[str, str]) -> None:
    if values:
        save({**load(), **values})


def merge(library: dict[str, str]) -> dict[str, str]:
    """ライブラリの設定に、アプリ単位の値を重ねて返す。

    アプリの設定にまだ無いキーは、ライブラリの値を引き継いで保存する(初回の移行)。
    """
    if not enabled():
        return library
    stored = load()
    adopted = {k: v for k, v in library.items() if is_app_key(k) and k not in stored}
    if adopted:
        stored = {**stored, **adopted}
        save(stored)
    return {**library, **stored}
