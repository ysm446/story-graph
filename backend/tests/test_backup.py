"""外部バックアップ(zip 書き出し・自動バックアップ・復元。docs/design/backup.md)。"""

import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import backup
import db
from store import Store


@pytest.fixture
def store(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    s = Store(db.connect(root / "story-graph.db"), root=str(root))
    s.create_character({"name": "アヤ", "id": "aya"})
    s.append_node({"beat": "橋の上で出会う", "cast": ["aya"]})
    return s


def _asset(store, name: str, data: bytes = b"png-data") -> None:
    (Path(store.assets_dir()) / name).write_bytes(data)


def test_export_contains_db_and_assets(store, tmp_path):
    _asset(store, "a.png")
    dest = tmp_path / "out" / "backup.zip"
    result = backup.export_zip(store, str(dest))

    assert dest.exists()
    assert result["assets"] == 1
    with zipfile.ZipFile(dest) as zf:
        names = zf.namelist()
        assert backup.DB_NAME in names
        assert "assets/images/a.png" in names
        assert backup.MANIFEST_NAME in names
        # 画像は無圧縮格納、DB は圧縮
        assert zf.getinfo("assets/images/a.png").compress_type == zipfile.ZIP_STORED
        assert zf.getinfo(backup.DB_NAME).compress_type == zipfile.ZIP_DEFLATED
    # 書き出した DB はそのまま開ける(VACUUM INTO の整合コピー)
    with zipfile.ZipFile(dest) as zf:
        (tmp_path / "extracted.db").write_bytes(zf.read(backup.DB_NAME))
    conn = db.connect(tmp_path / "extracted.db")
    assert {r["id"] for r in conn.execute("SELECT id FROM characters")} == {"aya"}


def test_export_adds_zip_suffix_without_eating_the_name(store, tmp_path):
    result = backup.export_zip(store, str(tmp_path / "私の物語 v1.2"))
    assert Path(result["path"]).name == "私の物語 v1.2.zip"


def test_export_excludes_snapshots_by_default(store, tmp_path):
    import snapshots

    snapshots.create(store, "テスト")
    plain = backup.export_zip(store, str(tmp_path / "plain.zip"))
    with_snaps = backup.export_zip(store, str(tmp_path / "full.zip"), include_snapshots=True)

    assert plain["includes_snapshots"] is False
    assert with_snaps["includes_snapshots"] is True
    with zipfile.ZipFile(tmp_path / "plain.zip") as zf:
        assert not [n for n in zf.namelist() if n.startswith("snapshots/")]
    with zipfile.ZipFile(tmp_path / "full.zip") as zf:
        assert [n for n in zf.namelist() if n.startswith("snapshots/")]


def test_export_leaves_no_partial_file_on_failure(store, tmp_path):
    dest = tmp_path / "sub" / "backup.zip"
    with pytest.raises(OSError):
        # ディレクトリを zip の名前で作っておくと os.replace で失敗する
        dest.parent.mkdir(parents=True)
        dest.mkdir()
        backup.export_zip(store, str(dest))
    assert not (dest.parent / (dest.name + ".part")).exists()


def test_restore_into_new_library(store, tmp_path):
    _asset(store, "a.png", b"image-bytes")
    zip_path = tmp_path / "backup.zip"
    backup.export_zip(store, str(zip_path))

    info = backup.inspect(str(zip_path))
    assert info["has_db"] and info["assets"] == 1 and info["kind"] == "manual"

    dest = tmp_path / "restored"
    result = backup.restore(str(zip_path), str(dest))
    assert result["root"] == str(dest)
    assert (dest / "story-graph.db").exists()
    assert (dest / "assets" / "images" / "a.png").read_bytes() == b"image-bytes"
    assert not (dest / backup.MANIFEST_NAME).exists()  # マニフェストは持ち込まない

    restored = Store(db.connect(dest / "story-graph.db"), root=str(dest))
    assert restored.known_char_ids() == {"aya"}


def test_restore_refuses_existing_library(store, tmp_path):
    zip_path = tmp_path / "backup.zip"
    backup.export_zip(store, str(zip_path))
    with pytest.raises(FileExistsError):
        backup.restore(str(zip_path), store.root)


def test_restore_rejects_non_backup_zip(tmp_path):
    bogus = tmp_path / "bogus.zip"
    with zipfile.ZipFile(bogus, "w") as zf:
        zf.writestr("readme.txt", "hello")
    with pytest.raises(ValueError):
        backup.restore(str(bogus), str(tmp_path / "out"))


def test_restore_ignores_zip_slip_entries(store, tmp_path):
    zip_path = tmp_path / "evil.zip"
    src = tmp_path / "src.zip"
    backup.export_zip(store, str(src))
    with zipfile.ZipFile(src) as original, zipfile.ZipFile(zip_path, "w") as evil:
        for info in original.infolist():
            evil.writestr(info.filename, original.read(info.filename))
        evil.writestr("../escaped.txt", "should not be written")
        evil.writestr("/absolute.txt", "should not be written")

    dest = tmp_path / "restored"
    backup.restore(str(zip_path), str(dest))
    assert not (tmp_path / "escaped.txt").exists()
    assert not (dest.parent / "escaped.txt").exists()
    assert (dest / "story-graph.db").exists()


def test_config_defaults_and_update(store):
    config = backup.get_config(store)
    assert config["enabled"] is False  # 既定は無効(勝手に外へファイルを作らない)
    assert config["keep"] == backup.DEFAULT_KEEP
    assert config["dir"].endswith("lib")  # <ドキュメント>/story-graph-backups/<ライブラリ名>
    assert config["last_at"] is None

    updated = backup.set_config(store, enabled=True, dir="D:/backups", keep=3)
    assert updated == {
        **config,
        "enabled": True,
        "dir": "D:/backups",
        "outside_dir": "D:/backups",
        "keep": 3,
    }
    assert backup.get_config(store)["enabled"] is True


def test_place_inside_library(store, tmp_path):
    """「ライブラリの中」はパスを覚えず root から導くので、切り替えても付いてくる。"""
    backup.set_config(store, dir=str(tmp_path / "outside"))
    assert backup.get_config(store)["inside"] is False

    config = backup.set_config(store, inside=True)
    assert config["inside"] is True
    assert config["dir"] == str(Path(store.root) / backup.INSIDE_DIR)
    assert config["outside_dir"] == str(tmp_path / "outside")  # 外のパスは覚えたまま

    # 実際に書けて、zip は自分自身を飲み込まない(入るのは db と assets/ だけ)
    backup.set_config(store, enabled=True)
    plan = backup.plan_auto(store)
    assert plan["dest"].startswith(str(Path(store.root) / backup.INSIDE_DIR))
    result = backup.export_zip(store, plan["dest"], kind="auto")
    second = backup.export_zip(store, str(Path(plan["dir"]) / "second.zip"))
    with zipfile.ZipFile(second["path"]) as zf:
        assert not [n for n in zf.namelist() if n.startswith(f"{backup.INSIDE_DIR}/")]
    assert Path(result["path"]).exists()

    # 戻すと、選んであった外のフォルダに帰る
    assert backup.set_config(store, inside=False)["dir"] == str(tmp_path / "outside")


def test_choosing_a_folder_turns_inside_off(store, tmp_path):
    backup.set_config(store, inside=True)
    config = backup.set_config(store, dir=str(tmp_path / "elsewhere"))
    assert config["inside"] is False  # フォルダを選んだ = 外に置く、という意思表示
    assert config["dir"] == str(tmp_path / "elsewhere")


def test_plan_auto_respects_interval_and_switch(store, tmp_path):
    # 既定はオフ。手動実行(force)だけは設定に関わらず走る
    assert backup.plan_auto(store) is None
    assert backup.plan_auto(store, force=True) is not None

    backup.set_config(store, enabled=True, dir=str(tmp_path / "dest"))
    plan = backup.plan_auto(store)
    assert plan is not None and plan["dest"].endswith(".zip")
    assert backup.AUTO_MARK in plan["dest"]

    # 直近に取っていればスキップ、24 時間経っていれば取る
    store.set_settings({"backup_last_at": datetime.now(timezone.utc).isoformat()})
    assert backup.plan_auto(store) is None
    assert backup.plan_auto(store, force=True) is not None
    old = datetime.now(timezone.utc) - timedelta(hours=backup.INTERVAL_HOURS + 1)
    store.set_settings({"backup_last_at": old.isoformat()})
    assert backup.plan_auto(store) is not None

    # オフなら取らない
    backup.set_config(store, enabled=False)
    assert backup.plan_auto(store) is None
    assert backup.plan_auto(store, force=True) is not None  # 手動実行は設定を無視する


def test_plan_auto_skips_empty_library(tmp_path):
    root = tmp_path / "empty"
    root.mkdir()
    empty = Store(db.connect(root / "story-graph.db"), root=str(root))
    backup.set_config(empty, enabled=True)
    assert backup.plan_auto(empty) is None  # シーンが 1 つも無い


def test_rotate_keeps_recent_autos_only(store, tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    name = backup.library_name(store.root)
    for i in range(4):
        (dest / f"{name}{backup.AUTO_MARK}2026080{i}-000000.zip").write_bytes(b"x")
    manual = dest / f"{name}-20260801-000000.zip"
    manual.write_bytes(b"x")
    other = dest / f"other{backup.AUTO_MARK}20260801-000000.zip"
    other.write_bytes(b"x")

    removed = backup.rotate(str(dest), name, keep=2)
    assert sorted(removed) == [
        f"{name}{backup.AUTO_MARK}20260800-000000.zip",
        f"{name}{backup.AUTO_MARK}20260801-000000.zip",
    ]
    assert manual.exists()  # 手動書き出しは巻き込まない
    assert other.exists()  # 別のライブラリのものも触らない


def test_record_auto_updates_last_at(store, tmp_path):
    backup.set_config(store, enabled=True, dir=str(tmp_path / "dest"), keep=1)
    plan = backup.plan_auto(store)
    result = backup.export_zip(store, plan["dest"], kind="auto")
    backup.record_auto(store, plan, result)

    config = backup.get_config(store)
    assert config["last_at"] is not None
    assert config["last_path"] == result["path"]
    assert backup.plan_auto(store) is None  # 直後は間隔でスキップされる

    entries = backup.list_backups(plan["dir"])
    assert len(entries) == 1 and entries[0]["kind"] == "auto"
