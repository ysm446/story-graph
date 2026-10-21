"""別章への貼り付け、コピー時点の保持、イベント参照、原子的な失敗を検証。"""
import asyncio

import httpx
import pytest

import db
import embed
import node_clipboard as clipboard
from store import Store


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "available", lambda: False)
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    s = Store(db.connect(":memory:"))
    s.create_character({"id": "aya", "name": "アヤ"})
    s.append_node({"id": "a", "title": "出発", "beat": "村を出る", "cast": ["aya"]}, [
        {"id": "memory", "type": "memory_add", "payload": {"char": "aya", "content": "約束"}}])
    s.append_node({"id": "b", "title": "帰還", "beat": "村に戻る", "cast": ["aya"]}, [
        {"id": "compressed", "type": "memory_compress", "payload": {"char": "aya", "content": "約束を果たす", "replaces": ["memory"]}}])
    s.append_node({"id": "branch", "beat": "別の道"}, parent_id="a", force_draft=True)
    yield s
    s.conn.close()


def copied(store, group_id=None):
    nodes = [store.get_node(nid) for nid in ["a", "b", "branch"]]
    for i, n in enumerate(nodes):
        n.update(pos_x=i * 360, pos_y=i * 20)
    ids = {n["id"] for n in nodes}
    return clipboard.PasteIn(library_root=store.root, nodes=nodes,
        edges=[e for e in store.graph()["edges"] if e["from_node"] in ids and e["to_node"] in ids],
        group_id=group_id, x=100, y=200)


def test_paste_into_other_chapter_preserves_original_and_remaps_memories(store):
    store.create_group("元の章", ["a", "b", "branch"])
    destination = store.create_group("貼り付け先", [])
    body = copied(store, destination["id"])
    before, canon = store.graph(), store.canon_path()
    ids = clipboard.paste(store, body)["node_ids"]
    a, b, branch = [store.get_node(nid) for nid in ids]
    assert a["beat"] == "村を出る" and b["beat"] == "村に戻る"
    assert a["group_id"] == b["group_id"] == branch["group_id"] == destination["id"]
    assert a["pos_x"] == 100 and b["pos_x"] == 460 and b["pos_y"] == 220
    assert store.parent_of(a["id"]) is None
    assert store.parent_of(b["id"]) == store.parent_of(branch["id"]) == a["id"]
    assert b["events"][0]["payload"]["replaces"] == [a["events"][0]["id"]]
    assert a["events"][0]["id"] != "memory"
    assert store.get_state(b["id"])["chars"]["aya"]["memories"] == [b["events"][0]["id"]]
    assert all(store.get_node(n["id"]) == n for n in before["nodes"])
    assert store.canon_path() == canon
    assert all(e in store.graph()["edges"] for e in before["edges"])


def test_snapshot_survives_source_edit_delete_and_repeated_paste(store):
    body = copied(store)
    store.update_node("a", {"beat": "編集後"})
    store.delete_node("b")
    first = clipboard.paste(store, body)["node_ids"]
    second = clipboard.paste(store, body)["node_ids"]
    assert not set(first) & set(second)
    assert store.get_node(first[0])["beat"] == store.get_node(second[0])["beat"] == "村を出る"
    assert store.get_node(first[1])["beat"] == "村に戻る"


@pytest.mark.parametrize("invalid", ["cycle", "external_edge", "group", "library", "duplicate", "character"])
def test_invalid_paste_rolls_back(store, invalid):
    body = copied(store)
    if invalid == "cycle":
        body.edges.append(clipboard.CopiedEdge(from_node="b", to_node="a"))
    elif invalid == "external_edge":
        body.edges.append(clipboard.CopiedEdge(from_node="b", to_node="missing"))
    elif invalid == "group":
        body.group_id = "missing"
    elif invalid == "library":
        body.library_root = "other"
    elif invalid == "duplicate":
        body.nodes.append(body.nodes[0])
    elif invalid == "character":
        body.nodes[-1].cast = ["missing"]
    before = store.graph()
    with pytest.raises((ValueError, KeyError)):
        clipboard.paste(store, body)
    assert store.graph() == before


def test_api_paste_and_production_lock(store, monkeypatch):
    import app as api
    async def snapshot(*args):
        pass
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api.snapshots, "auto", snapshot)
    monkeypatch.setattr(api.production_agent.gate, "active", False)
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            body = copied(store).model_dump()
            response = await client.post("/nodes/paste", json=body)
            assert response.status_code == 200
            assert len(response.json()["node_ids"]) == 3
            before = store.graph()
            body["nodes"][0]["kind"] = "ending"
            assert (await client.post("/nodes/paste", json=body)).status_code == 422
            body["nodes"][0]["kind"] = None
            api.production_agent.gate.active = True
            assert (await client.post("/nodes/paste", json=body)).status_code == 409
            assert store.graph() == before
    asyncio.run(check())


def _chapters_with_extras(store):
    """第1章 = a, b(+ 分岐 branch)、第2章 = c。清書・挿絵のストック・まとめ・表紙を付ける。"""
    store.append_node({"id": "c", "beat": "次の章"})
    first = store.create_group("第1章", ["a", "b", "branch"])
    store.create_group("第2章", ["c"])
    store.conn.execute("INSERT INTO renders(id, node_id, preset_id, prose, created_at) VALUES('r1', 'b', 'p', '清書', 'now')")
    store.conn.execute("INSERT INTO media(id, owner_type, owner_id, path, created_at) VALUES('m1', 'node', 'a', 'a.png', 'now')")
    store.conn.execute("UPDATE nodes SET image_path = 'a.png' WHERE id = 'a'")
    store.update_group(first["id"], {"cover_node_id": "a"})
    store.save_group_digest(first["id"], [{"id": "d1", "type": "memory_compress",
        "payload": {"char": "aya", "summary": "旅のまとめ", "replaces": ["memory", "compressed"]}}])
    store.conn.commit()
    return store.get_group(first["id"])


def test_duplicate_chapter_branches_from_the_same_parent(store):
    original = _chapters_with_extras(store)
    before, canon = store.graph(), store.canon_path()
    copy = clipboard.duplicate_group(store, original["id"], "第1章のコピー", 40, 600)
    assert copy["title"] == "第1章のコピー" and not copy["on_canon"] and copy["warning"] is None
    assert (copy["pos_x"], copy["pos_y"]) == (40, 600)
    assert len(copy["node_ids"]) == 3 and not set(copy["node_ids"]) & set(original["node_ids"])
    a, b = [store.get_node(n) for n in copy["route"]]
    assert (a["beat"], b["beat"]) == ("村を出る", "村に戻る")
    assert a["image_path"] == "a.png" and copy["cover_node_id"] == a["id"]
    # 入口は元の章と同じ親から生え、出口の先(後ろの章)にはつながない
    assert store.parent_of(copy["in_id"]) == store.parent_of(original["in_id"])
    assert not [e for e in store.graph()["edges"] if e["from_node"] == copy["out_id"]]
    assert store.get_node(copy["in_id"])["title"] == "第1章のコピー 入口"
    # 元の章・正史は変わらない
    assert store.canon_path() == canon
    after = {n["id"]: n for n in store.graph()["nodes"]}
    assert all(after[n["id"]] == n for n in before["nodes"])
    assert all(e in store.graph()["edges"] for e in before["edges"])
    # 記憶の参照は複製した記憶へ。状態も前提から同じに流れる
    assert b["events"][0]["payload"]["replaces"] == [a["events"][0]["id"]]
    assert store.get_state(b["id"])["chars"]["aya"]["memories"] == [b["events"][0]["id"]]
    # 清書・挿絵のストック・まとめも写る(まとめは中身が同じなので古い扱いにしない)
    assert store.conn.execute("SELECT prose FROM renders WHERE node_id = ?", (b["id"],)).fetchone()["prose"] == "清書"
    assert store.conn.execute("SELECT path FROM media WHERE owner_id = ?", (a["id"],)).fetchone()["path"] == "a.png"
    digest = copy["digest_events"][0]
    assert digest["id"] != "d1" and digest["payload"]["replaces"] == [a["events"][0]["id"], b["events"][0]["id"]]
    assert copy["digest_stale"] == 0
    assert store.conn.execute("SELECT content FROM memories WHERE id = ?", (digest["id"],)).fetchone()["content"] == "旅のまとめ"
    # 複製を書き換えても元の章のまとめは古くならない
    store.update_node(b["id"], {"beat": "書き換え"})
    store.replace_events(b["id"], [])
    assert store.get_group(original["id"])["digest_stale"] == 0
    assert store.get_group(copy["id"])["digest_stale"] == 1


def test_duplicate_keeps_references_to_memories_before_the_chapter(store):
    group = store.create_group("帰還の章", ["b"])
    copy = clipboard.duplicate_group(store, group["id"], "帰還の章のコピー")
    b = store.get_node(copy["route"][0])
    assert b["events"][0]["payload"]["replaces"] == ["memory"]
    assert store.get_state(b["id"])["chars"]["aya"]["memories"] == [b["events"][0]["id"]]
    assert copy["pos_x"] is None


def test_api_duplicate_chapter(store, monkeypatch):
    import app as api
    async def snapshot(*args):
        pass
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api.snapshots, "auto", snapshot)
    monkeypatch.setattr(api.production_agent.gate, "active", False)
    group = store.create_group("第1章", ["a", "b", "branch"])
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as client:
            response = await client.post(f"/groups/{group['id']}/duplicate", json={"title": "案2", "x": 0, "y": 300})
            assert response.status_code == 200 and response.json()["title"] == "案2"
            assert (await client.post("/groups/missing/duplicate", json={"title": "案3"})).status_code == 404
            assert (await client.post(f"/groups/{group['id']}/duplicate", json={"title": " "})).status_code == 400
            before = store.graph()
            api.production_agent.gate.active = True
            assert (await client.post(f"/groups/{group['id']}/duplicate", json={"title": "案4"})).status_code == 409
            assert store.graph() == before
    asyncio.run(check())
