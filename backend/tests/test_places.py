"""場所(places)— 登録・実効ロケーション・移行(docs/design/places.md)。"""

import sqlite3

import pytest

import db
import generation
from store import Store


@pytest.fixture
def store():
    return Store(db.connect(":memory:"))


def _chars(store):
    store.create_character({"name": "アヤ", "id": "aya"})


def test_place_crud(store):
    place = store.create_place({"name": "港町", "description": "潮の匂いがする交易港"})
    assert store.get_place(place["id"])["name"] == "港町"
    store.update_place(place["id"], {"atmosphere": "騒がしい"})
    assert store.get_place(place["id"])["atmosphere"] == "騒がしい"
    store.delete_place(place["id"])
    assert store.get_place(place["id"]) is None


def test_delete_place_clears_node_reference(store):
    _chars(store)
    place = store.create_place({"name": "港町"})
    node = store.append_node({"beat": "到着", "cast": ["aya"], "location": place["id"]})
    store.delete_place(place["id"])
    assert store.get_node(node["id"])["location"] is None


def test_effective_location_inherits_from_parent(store):
    _chars(store)
    port = store.create_place({"name": "港町"})
    bridge = store.create_place({"name": "石橋"})
    n1 = store.append_node({"beat": "到着", "cast": ["aya"], "location": port["id"]})
    n2 = store.append_node({"beat": "待つ", "cast": ["aya"]})  # 空欄 = 引き継ぐ
    n3 = store.append_node({"beat": "移動", "cast": ["aya"], "location": bridge["id"]})
    n4 = store.append_node({"beat": "対峙", "cast": ["aya"]})

    assert store.effective_location(n1["id"]) == (port["id"], False)
    assert store.effective_location(n2["id"]) == (port["id"], True)
    assert store.effective_location(n3["id"]) == (bridge["id"], False)
    assert store.effective_location(n4["id"]) == (bridge["id"], True)


def test_effective_location_none_when_never_set(store):
    _chars(store)
    n1 = store.append_node({"beat": "はじまり", "cast": ["aya"]})
    n2 = store.append_node({"beat": "つづき", "cast": ["aya"]})
    assert store.effective_location(n2["id"]) == (None, False)
    assert store.location_context(n2["id"]) is None


def test_effective_location_follows_branch_parent(store):
    """分岐ノードは自分の祖先から引き継ぐ(正史パスではない)。"""
    _chars(store)
    port = store.create_place({"name": "港町"})
    bridge = store.create_place({"name": "石橋"})
    n1 = store.append_node({"beat": "到着", "cast": ["aya"], "location": port["id"]})
    n2 = store.append_node({"beat": "橋へ", "cast": ["aya"], "location": bridge["id"]})
    # n1 からの分岐(正史は n2 側)。分岐先は n1 の場所を引き継ぐ
    branch = store.append_node({"beat": "what-if", "cast": ["aya"]}, parent_id=n1["id"], force_draft=True)
    assert store.effective_location(branch["id"]) == (port["id"], True)
    assert store.effective_location(n2["id"]) == (bridge["id"], False)


def test_detached_island_has_no_inherited_location(store):
    _chars(store)
    port = store.create_place({"name": "港町"})
    n1 = store.append_node({"beat": "到着", "cast": ["aya"], "location": port["id"]})
    n2 = store.append_node({"beat": "つづき", "cast": ["aya"]})
    assert store.effective_location(n2["id"]) == (port["id"], True)
    store.detach_node(n2["id"])
    assert store.effective_location(n2["id"]) == (None, False)


def test_place_name_falls_back_to_id(store):
    assert store.place_name(None) is None
    assert store.place_name("unknown-id") == "unknown-id"  # 移行漏れでも表示は壊さない
    place = store.create_place({"name": "港町"})
    assert store.place_name(place["id"]) == "港町"


def test_location_context_reports_inheritance(store):
    _chars(store)
    port = store.create_place({"name": "港町", "description": "交易港", "atmosphere": "騒がしい"})
    n1 = store.append_node({"beat": "到着", "cast": ["aya"], "location": port["id"]})
    n2 = store.append_node({"beat": "つづき", "cast": ["aya"]})
    assert store.location_context(n1["id"])["inherited"] is False
    ctx = store.location_context(n2["id"])
    assert ctx["name"] == "港町" and ctx["inherited"] is True
    assert ctx["description"] == "交易港"


def test_beat_schema_location_enum(store):
    schema = generation.beat_schema(["aya"], ["port", "bridge"])
    assert schema["properties"]["location"] == {"type": "string", "enum": ["port", "bridge"]}
    assert "location" in schema["required"]


def test_beat_schema_omits_location_without_places():
    """場所が未登録なら location を出させない(自由テキストとの混在を防ぐ)。"""
    schema = generation.beat_schema(["aya"], [])
    assert "location" not in schema["properties"]
    assert "location" not in schema["required"]


def test_render_prompt_includes_place_and_inherits(store):
    """清書プロンプトに固定設定が載り、空欄のシーンは引き継いだ場所名になる。"""
    import rendering

    _chars(store)
    port = store.create_place({"name": "港町", "description": "交易港", "atmosphere": "潮の匂い"})
    store.append_node({"beat": "到着", "cast": ["aya"], "location": port["id"]})
    n2 = store.append_node({"beat": "待つ", "cast": ["aya"]})  # 空欄 = 引き継ぐ
    preset = store.list_presets()[0]

    messages = rendering.build_render_messages(store, store.get_node(n2["id"]), preset, None, None)
    text = messages[-1]["content"]
    assert "## 場所" in text
    assert "港町" in text and "交易港" in text and "潮の匂い" in text
    assert "場所: 不明" not in text


def test_render_prompt_place_unknown_without_places(store):
    import rendering

    _chars(store)
    node = store.append_node({"beat": "はじまり", "cast": ["aya"]})
    preset = store.list_presets()[0]
    text = rendering.build_render_messages(store, store.get_node(node["id"]), preset, None, None)[-1]["content"]
    assert "## 場所" not in text
    assert "場所: 不明" in text


def test_migration_converts_free_text_locations():
    """旧データ(location が自由テキスト)を places に登録して ID 参照へ。"""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA user_version = 1")
    conn.executescript(
        """
        CREATE TABLE nodes(id TEXT PRIMARY KEY, title TEXT, beat TEXT NOT NULL,
          emotional_core TEXT, cast TEXT NOT NULL, location TEXT, story_time TEXT,
          status TEXT, created_at TEXT, updated_at TEXT);
        INSERT INTO nodes(id, beat, cast, location) VALUES
          ('n1', 'a', '[]', '港町'), ('n2', 'b', '[]', '港町'),
          ('n3', 'c', '[]', '石橋'), ('n4', 'd', '[]', NULL), ('n5', 'e', '[]', '');
        """
    )
    db.init_schema(conn)

    places = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM places")}
    assert set(places) == {"港町", "石橋"}
    rows = {r["id"]: r["location"] for r in conn.execute("SELECT id, location FROM nodes")}
    assert rows["n1"] == places["港町"] and rows["n2"] == places["港町"]  # 同じ文字列は 1 つに
    assert rows["n3"] == places["石橋"]
    assert rows["n4"] is None and rows["n5"] == ""
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION

    # 冪等: もう一度走らせても場所は増えない
    db.init_schema(conn)
    assert conn.execute("SELECT COUNT(*) FROM places").fetchone()[0] == 2


def test_update_place_stales_renders_including_inherited(store):
    """場所の説明を変えると、直接参照ノードと引き継ぎ子孫の清書が stale になる。"""
    _chars(store)
    port = store.create_place({"name": "港町"})
    n1 = store.append_node({"beat": "到着", "cast": ["aya"], "location": port["id"]})
    n2 = store.append_node({"beat": "散策", "cast": ["aya"]})  # location 空欄 = 引き継ぎ
    store.seed_presets()
    store.save_render(n1["id"], "default-third", None, "散文1")
    store.save_render(n2["id"], "default-third", None, "散文2")
    store.update_place(port["id"], {"description": "夜は静かな港"})
    stales = {
        r["node_id"]: r["stale"]
        for r in store.conn.execute("SELECT node_id, stale FROM renders")
    }
    assert stales[n1["id"]] == 1
    assert stales[n2["id"]] == 1
    # 色だけの変更ではプロンプトが変わらないので stale にしない
    store.save_render(n1["id"], "default-third", None, "散文3")
    store.update_place(port["id"], {"color": "#123456"})
    latest = store.latest_render(n1["id"], "default-third", None)
    assert latest["stale"] == 0
