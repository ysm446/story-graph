"""設定資料の正本・索引・AI参照境界を検証する。"""
import sqlite3

import pytest
from pydantic import ValidationError

import db
import embed
import setting_documents as documents
from store import Store
import chat_agent


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    monkeypatch.setattr(embed, "available", lambda: False)
    connection = db.connect(":memory:")
    yield Store(connection)
    connection.close()


def create(store, **data):
    return store.save_setting_document({"title": "王都の食糧事情", "body": "穀物不足で配給制度がある。", **data})


def test_crud_revision_and_index_replace(store):
    original = create(store)
    assert original["status"] == "draft" and original["ai_mode"] == "search"
    assert documents.search(store.conn, "配給制度")[0]["document_id"] == original["id"]
    updated = store.save_setting_document({"title": "新制度", "body": "自由市場に移行する。"}, original["id"], original["revision"])
    assert updated["revision"] == 2 and updated["created_at"] == original["created_at"]
    assert not documents.search(store.conn, "配給制度")
    assert documents.search(store.conn, "自由市場")
    with pytest.raises(documents.RevisionConflict):
        store.save_setting_document({"title": "古い編集"}, original["id"], 1)
    with pytest.raises(documents.RevisionConflict):
        store.delete_setting_document(original["id"], 1)
    assert store.get_setting_document(original["id"])["title"] == "新制度"
    store.delete_setting_document(original["id"], 2)
    assert store.list_setting_documents() == []
    assert not documents.search(store.conn, "自由市場")
    assert store.conn.execute("SELECT COUNT(*) FROM setting_documents_fts").fetchone()[0] == 0
    assert store.conn.execute("SELECT COUNT(*) FROM setting_document_chunks").fetchone()[0] == 0


@pytest.mark.parametrize("data", [{"title": "  "}, {"title": "x", "status": "invalid"}, {"title": "x", "ai_mode": "invalid"}, {"title": "x", "unexpected": "value"}])
def test_invalid_input_does_not_write(store, data):
    with pytest.raises((ValueError, ValidationError)):
        store.save_setting_document(data)
    assert not store.list_setting_documents()


def test_long_document_is_not_truncated_and_metadata_is_searchable(store):
    body = "前半の記述" * 900 + "\n\n終端の固有設定"
    doc = create(store, body=body, category="魔法技術", scope="開始時点の北部のみ")
    assert store.get_setting_document(doc["id"])["body"] == body
    hits = documents.search(store.conn, "終端の固有設定")
    assert any("終端の固有設定" in hit["content"] for hit in hits)
    assert all(hit["scope"] == "開始時点の北部のみ" for hit in hits)
    assert documents.search(store.conn, "魔法技術")
    assert documents.search(store.conn, "王都")


def test_ai_modes_and_character_boundary(store):
    always = create(store, title="常時資料", ai_mode="always", status="confirmed")
    hidden = create(store, title="非公開資料", ai_mode="never", body="秘密制度の原文")
    draft = create(store, title="構想資料", status="draft")
    context = documents.context(store.conn)
    assert always["title"] in context and always["body"] in context
    assert hidden["title"] not in context and hidden["body"] not in context
    assert draft["title"] not in context
    assert documents.dispatch(store.conn, "read_setting_document", {"id": hidden["id"]}).get("error")
    assert not documents.search(store.conn, "秘密制度")
    assert "常時資料" in chat_agent.build_system(store, [], "all")
    names = {tool["function"]["name"] for tool in chat_agent.build_tools()}
    assert {"search_setting_documents", "read_setting_document"} <= names
    character_names = {tool["function"]["name"] for tool in chat_agent.build_character_tools()}
    assert not names.intersection(character_names) & {"search_setting_documents", "read_setting_document"}
    result = chat_agent.dispatch_tool(store, "read_setting_document", {"id": draft["id"]}, [], "upto")
    assert result["status"] == "draft"


def test_semantic_search_repairs_pending_vectors_and_excludes_hidden(store, monkeypatch):
    first = create(store, title="穀倉地帯", body="穀物の生産が減少している")
    create(store, title="軍事", body="軍の装備")
    hidden = create(store, title="食べ物", ai_mode="never")
    calls = []
    def document_vector(text):
        calls.append(text)
        return [1.0, 0.0] if "穀物" in text else [0.0, 1.0]
    monkeypatch.setattr(embed, "available", lambda: True)
    monkeypatch.setattr(embed, "embed_document", document_vector)
    monkeypatch.setattr(embed, "embed_query", lambda text: [1.0, 0.0])
    hits = documents.search(store.conn, "食べ物の不足")
    assert hits[0]["document_id"] == first["id"]
    assert all(hit["document_id"] != hidden["id"] for hit in hits)
    assert len(calls) == 2
    documents.search(store.conn, "食べ物の不足")
    assert len(calls) == 2
    store.save_setting_document({"title": "軍事", "body": "軍の装備"}, first["id"], first["revision"])
    documents.search(store.conn, "食べ物の不足")
    assert len(calls) == 3


def test_embedding_failure_keeps_keyword_results(store, monkeypatch):
    doc = create(store)
    monkeypatch.setattr(embed, "available", lambda: True)
    def fail(text):
        raise RuntimeError("offline")
    monkeypatch.setattr(embed, "embed_query", fail)
    assert documents.search(store.conn, "配給制度")[0]["document_id"] == doc["id"]


def test_schema_upgrade_and_database_copy(tmp_path, monkeypatch):
    monkeypatch.setattr(embed, "is_ready", lambda: False)
    path = tmp_path / "story-graph.db"
    conn = db.connect(path)
    document = documents.save_document(conn, {"title": "保存する設定", "body": "本文"})
    copied_path = tmp_path / "copy.db"
    with sqlite3.connect(copied_path) as copied:
        conn.backup(copied)
    conn.close()
    restored = db.connect(copied_path)
    assert documents.get_document(restored, document["id"])["body"] == "本文"
    db.init_schema(restored)
    assert len(documents.list_documents(restored)) == 1
    restored.close()


def test_api_crud_and_conflict(store, monkeypatch):
    import app
    from fastapi.testclient import TestClient
    monkeypatch.setattr(app, "store", store)
    monkeypatch.setattr(app.production_agent.gate, "active", False)
    client = TestClient(app.app)
    response = client.post("/setting-documents", json={"title": "API資料"})
    assert response.status_code == 200
    doc = response.json()
    payload = {key: doc[key] for key in documents.FIELDS}
    payload.update(body="保存した本文", revision=doc["revision"])
    assert client.put(f"/setting-documents/{doc['id']}", json=payload).status_code == 200
    assert client.put(f"/setting-documents/{doc['id']}", json=payload).status_code == 409
    assert client.post("/setting-documents", json={"title": "x", "ai_mode": "bad"}).status_code == 422
    monkeypatch.setattr(app.production_agent.gate, "active", True)
    assert client.post("/setting-documents", json={"title": "x"}).status_code == 409
    monkeypatch.setattr(app.production_agent.gate, "active", False)
    assert client.delete(f"/setting-documents/{doc['id']}?revision=2").status_code == 200
    assert client.get("/setting-documents").json() == []
