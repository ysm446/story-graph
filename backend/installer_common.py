"""自動インストーラー(llama_installer / comfy_installer / tts_installer)が共有するフォルダ操作。

どれも runtime/ の下に置いたフォルダを、使用中なら壊さずに失敗させてから消す・置き換える。
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path


def dir_size(path: Path) -> int:
    """フォルダ配下のファイルサイズ合計(消したときに空く量の表示用)。シンボリックリンクは数えない。"""
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                total += p.stat().st_size
        except OSError:
            continue
    return total


def remove_by_rename(target: Path, error_message: str, trash_dir: Path | None = None) -> Path:
    """target を別名へ rename してから消す。退かした先(消し切れなければ残る)を返す。

    使用中(exe や DLL をロック中)なら rename の時点で失敗するので、中身の一部だけ消えた
    壊れたフォルダを残さずに済む。失敗は `{error_message}: {OSError}` の RuntimeError。
    残骸(.removing-*)は llama_installer.cleanup_leftovers が次回起動時に回収する。
    """
    trash = (trash_dir or target.parent) / f".removing-{uuid.uuid4().hex}"
    try:
        target.rename(trash)
    except OSError as e:
        raise RuntimeError(f"{error_message}: {e}") from e
    shutil.rmtree(trash, ignore_errors=True)
    return trash


def swap_into_place(staging: Path, dest_dir: Path, busy_hint: str) -> None:
    """展開の済んだ staging を dest_dir へ置き換える。

    既存の dest_dir は先に rename で退かす。使用中なら rename の時点で失敗し、既存の
    インストールは無傷のまま残る。busy_hint は失敗の理由の推測(「ComfyUI が起動中」など)。
    """
    if dest_dir.exists():
        remove_by_rename(
            dest_dir, f"既存のインストール先を置き換えられませんでした({busy_hint}の可能性があります): {dest_dir}"
        )
    staging.rename(dest_dir)
