"""キャラクターカードの書き出し(docs/design/character-card.md)。

ある時点のキャラクターを、ほかのアプリへ渡すための zip にする。形式の正本は
docs/reference/character-card-format.md。読み取り専用で、物語のデータには何も書かない。

材料と知識の境界はキャラ会話(chat_agent.build_character_system)と同じにする。
文字で話した相手と、カードで渡す相手を食い違わせないため、言葉の選び方は chat_agent の関数を使う。
"""
from __future__ import annotations

import json
import os
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import chat_agent
from backup import safe_name
from store import Store

FORMAT = "story-graph-character-card"
VERSION = 1
APP_NAME = "story-graph"
CARD_NAME = "card.json"
FILE_NAME_MAX = 80  # 既定のファイル名の長さ(拡張子を除く)


@dataclass
class CardFile:
    arcname: str  # zip の中の相対パス
    source: Path  # ライブラリの中の実ファイル


@dataclass
class CardBuild:
    card: dict[str, Any]
    files: list[CardFile] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)  # 作者に知らせること(声が無い、ファイルが無いなど)
    scene_title: str = ""

    def summary(self) -> dict[str, Any]:
        """確認ダイアログに出す内訳。"""
        card = self.card
        voice = card.get("voice") or {}
        return {
            "name": card["name"],
            "label": card["source"]["label"],
            "suggested_name": suggested_name(self),
            "counts": {
                "situation": len(card.get("situation") or []),
                "world": len(card.get("world") or []),
                "relationships": len(card.get("relationships") or []),
                "memories": len(card.get("memories") or []),
                "images": len(card.get("images") or []),
                "voice_refs": len(voice.get("refs") or []),
            },
            "has_voice": bool(voice),
            "notes": self.notes,
        }


def _prune(value: Any) -> Any:
    """形式の「無ければ項目ごと省く」を守る。None・空文字・空の配列・空のオブジェクトを落とす
    (0 や False は値なので残す)。"""
    if isinstance(value, dict):
        cleaned = {k: _prune(v) for k, v in value.items()}
        return {k: v for k, v in cleaned.items() if v not in (None, "", [], {})}
    if isinstance(value, list):
        return [v for v in (_prune(item) for item in value) if v not in (None, "", [], {})]
    if isinstance(value, str):
        return value.strip()
    return value


def _path_for(store: Store, anchor: str | None) -> list[str]:
    """畳み込む道。キャラ会話でアンカーを指定したときと同じ(マーカーはシーンではないので除く)。"""
    if anchor is None:
        return store.canon_path()
    if store.get_node(anchor) is None:
        raise ValueError(f"シーンが見つかりません: {anchor}")
    return [nid for nid in store.path_to(anchor) if store._node_kind(nid) is None]


def _facts(facts: dict[str, Any] | None) -> list[str]:
    return [f"{key}: {value}" for key, value in (facts or {}).items()]


def _relationships(store: Store, rels: dict[str, Any]) -> list[dict[str, Any]]:
    """気持ちの強い順(好悪どちらでも)。数値は読む側に意味が伝わらないので言葉だけ渡す。"""
    items = []
    for target, rel in rels.items():
        other = store.get_character(target)
        if other is None:
            continue  # 削除済みの相手。ID だけ渡しても意味を持たない
        score = float(rel.get("score") or 0.0)
        label = f"「{rel['label']}」" if rel.get("label") else ""
        items.append((abs(score), {
            "name": other["name"],
            "appearance": chat_agent.appearance_hint(other),
            "feeling": chat_agent.describe_score(score) + label,
        }))
    items.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in items]


def _memories(store: Store, path: list[str], memory_ids: list[str]) -> list[dict[str, Any]]:
    rows = chat_agent.memories_by_priority(store, memory_ids)
    when = chat_agent.memory_ages(store, path, rows)
    return [{"text": r["content"], "when": when.get(r["id"])} for r in rows]


def _asset(store: Store, sub: str, value: str | None) -> Path | None:
    """DB が指すファイルの実パス。無ければ None(フォルダは作らない)。"""
    if not value or not store.root:
        return None
    path = Path(store.root) / "assets" / sub / Path(value).name
    return path if path.is_file() else None


def _images(store: Store, char: dict[str, Any], build: CardBuild) -> list[dict[str, str]]:
    images = []
    for role, column in (("avatar", "portrait_path"), ("reference", "ref_image_path")):
        if not char.get(column):
            continue
        source = _asset(store, "images", char[column])
        if source is None:
            build.notes.append(f"画像のファイルが見つからないため入れません: {Path(char[column]).name}")
            continue
        arcname = f"images/{role}{source.suffix.lower()}"
        build.files.append(CardFile(arcname, source))
        images.append({"file": arcname, "role": role})
    if not images:
        build.notes.append("画像がありません(画像なしで書き出します)")
    return images


def _voice(store: Store, char: dict[str, Any], build: CardBuild) -> dict[str, Any]:
    profile = store.get_voice_profile(char["voice_profile_id"]) if char.get("voice_profile_id") else None
    if profile is None:
        build.notes.append("声が割り当てられていません(声なしで書き出します)")
        return {}
    refs = []
    for name in profile.get("ref_paths") or []:
        source = _asset(store, "voices", name)
        if source is None:
            build.notes.append(f"参照音声のファイルが見つからないため入れません: {Path(name).name}")
            continue
        arcname = f"voice/ref{len(refs) + 1}{source.suffix.lower()}"
        build.files.append(CardFile(arcname, source))
        refs.append(arcname)
    caption = (profile.get("caption") or "").strip()
    if not caption and not refs:
        # preset(エンジン側の声 ID)しか無い声。エンジンに依存するのでカードには入れない
        build.notes.append(
            f"声「{profile['name']}」には説明も参照音声も無いため、声なしで書き出します"
        )
        return {}
    return {"caption": caption, "seed": profile.get("seed"), "refs": refs}


def default_label(title: str | None) -> str:
    return f"「{title.strip()}」の直後" if title and title.strip() else "(無題)の直後"


def build_card(
    store: Store,
    char_id: str,
    anchor: str | None,
    label: str | None = None,
    now: datetime | None = None,
) -> CardBuild:
    """card.json の中身、同梱するファイル、作者への注意書きを作る。"""
    char = store.get_character(char_id)
    if char is None:
        raise KeyError(f"キャラクターが見つかりません: {char_id}")
    path = _path_for(store, anchor)
    if not path:
        raise ValueError("シーンが 1 つも無いため書き出せません")
    node = store.get_node(path[-1]) or {}
    state = store.get_state(path[-1])
    cs = state["chars"].get(char_id) or {}

    build = CardBuild(card={}, scene_title=(node.get("title") or "").strip())
    card = {
        "format": FORMAT,
        "version": VERSION,
        "language": "ja",
        "source": {
            "app": APP_NAME,
            "app_version": os.environ.get("STORY_GRAPH_APP_VERSION"),
            "character_id": char_id,
            "node_id": path[-1],
            "library": Path(store.root).name if store.root else None,
            "label": (label or "").strip() or default_label(node.get("title")),
            "exported_at": (now or datetime.now()).strftime("%Y-%m-%d %H:%M"),
        },
        "name": char["name"],
        "reading": char.get("reading"),
        "profile": char.get("profile"),
        "appearance": char.get("appearance"),
        "speech": char.get("voice"),  # 列の名前は voice だが口調のこと。カードの voice は声(音)
        "situation": _facts(cs.get("facts")),
        # world facts は「誰もが知っている公のこと」という規約なので本人に渡してよい
        "world": _facts(state["world"]["facts"]),
        "relationships": _relationships(store, cs.get("relationships") or {}),
        "memories": _memories(store, path, list(cs.get("memories") or [])),
        "images": _images(store, char, build),
        "voice": _voice(store, char, build),
    }
    build.card = _prune(card)
    return build


def suggested_name(build: CardBuild) -> str:
    """保存ダイアログの既定のファイル名。<名前>@<シーンのタイトル>.zip"""
    stem = safe_name(f"{build.card['name']}@{build.scene_title or '無題'}")
    return stem[:FILE_NAME_MAX].rstrip(". ") + ".zip"


def write_zip(dest: str, card: dict[str, Any], files: list[CardFile]) -> dict[str, Any]:
    """zip を書く(SQLite には触らないのでスレッドで実行できる)。
    途中で失敗した zip を残さないよう <dest>.part に書いてから置き換える。"""
    dest_path = Path(dest)
    if dest_path.suffix.lower() != ".zip":
        dest_path = dest_path.with_name(dest_path.name + ".zip")
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    part = dest_path.with_name(dest_path.name + ".part")
    try:
        with zipfile.ZipFile(part, "w", zipfile.ZIP_STORED) as zf:
            zf.writestr(
                CARD_NAME,
                json.dumps(card, ensure_ascii=False, indent=2),
                compress_type=zipfile.ZIP_DEFLATED,
            )
            for item in files:  # 画像・音声は圧縮済みなのでそのまま入れる
                zf.write(item.source, item.arcname)
        os.replace(part, dest_path)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return {"path": str(dest_path), "size": dest_path.stat().st_size}


def export_card(store: Store, char_id: str, anchor: str | None, dest: str, label: str | None = None) -> dict[str, Any]:
    """同期版(テスト用)。API は build_card をループ上で、write_zip をスレッドで呼ぶ。"""
    build = build_card(store, char_id, anchor, label)
    return {**write_zip(dest, build.card, build.files), **build.summary()}
