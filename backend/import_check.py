"""取り込み JSON の検査コマンド(docs/reference/import-format.md)。取り込みはせず、誤りだけを返す。

    .venv/Scripts/python.exe backend/import_check.py 作品.json

外部の LLM が「書く → 検査する → 直す」を自分で繰り返すためのもの。画面の取り込みと同じ検査を使う。
誤りが無ければ終了コード 0、あれば 1。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import importer


def main(argv: list[str]) -> int:
    # Windows のコンソールでも日本語のメッセージが化けないようにする
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    if len(argv) != 2:
        print("使い方: python backend/import_check.py <取り込み JSON のパス>", file=sys.stderr)
        return 2
    path = Path(argv[1])
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except OSError as error:
        print(f"ファイルを読めません: {error}", file=sys.stderr)
        return 2
    except ValueError as error:
        print(f"JSON として読めません: {error}")
        return 1
    result = importer.validate(data)
    for message in result["errors"]:
        print(f"誤り: {message}")
    for message in result["warnings"]:
        print(f"注意: {message}")
    summary = result["summary"]
    counts = (f"キャラクター {summary['characters']} / 場所 {summary['places']} / 設定資料 {summary['documents']} / "
              f"章 {summary['chapters']} / シーン {summary['scenes']} / イベント {summary['events']}")
    if result["errors"]:
        print(f"誤りが {len(result['errors'])} 件あります。直してから、もう一度検査してください。({counts})")
        return 1
    print(f"問題ありません。取り込めます。({counts})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
