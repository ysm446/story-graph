import pytest

from fold import empty_state, fold, apply_event, state_hash, events_hash, input_hash


def ev(event_id, etype, **payload):
    return {"id": event_id, "type": etype, "payload": payload}


def test_memory_add_appends_event_id():
    state = fold(empty_state(), [
        ev("e1", "char_introduce", char="aya"),
        ev("e2", "memory_add", char="aya", content="橋で裏切りを知った", emotion=-0.8, importance=0.9, refs=["ken"]),
    ])
    assert state["chars"]["aya"]["memories"] == ["e2"]


def test_memory_compress_replaces():
    state = fold(empty_state(), [
        ev("e1", "memory_add", char="aya", content="a"),
        ev("e2", "memory_add", char="aya", content="b"),
        ev("e3", "memory_compress", char="aya", replaces=["e1", "e2"], summary="要約", importance=0.5),
    ])
    assert state["chars"]["aya"]["memories"] == ["e3"]


def test_relationship_update_clamps_and_records_reasons():
    state = fold(empty_state(), [
        ev("e1", "relationship_update", char="aya", target_type="char", target="ken", delta=0.7, reason="助けられた"),
        ev("e2", "relationship_update", char="aya", target_type="char", target="ken", delta=0.7, reason="さらに"),
    ])
    rel = state["chars"]["aya"]["relationships"]["ken"]
    assert rel["score"] == 1.0  # clamp(-1, 1)
    assert rel["reasons"] == ["e1", "e2"]


def test_relationship_set_overrides():
    state = fold(empty_state(), [
        ev("e1", "relationship_update", char="aya", target="ken", delta=0.5, reason="r1"),
        ev("e2", "relationship_set", char="aya", target="ken", value=-0.9, reason="裏切り発覚"),
    ])
    assert state["chars"]["aya"]["relationships"]["ken"]["score"] == -0.9


def test_fact_set_world_and_char_last_wins():
    state = fold(empty_state(), [
        ev("e1", "fact_set", scope="world", key="weather", value="雨"),
        ev("e2", "fact_set", scope="char", char="aya", key="location", value="橋"),
        ev("e3", "fact_set", scope="char", char="aya", key="location", value="城"),
    ])
    assert state["world"]["facts"]["weather"] == "雨"
    assert state["chars"]["aya"]["facts"]["location"] == "城"


def test_fact_set_world_time():
    state = fold(empty_state(), [ev("e1", "fact_set", scope="world", key="time", value="3日目の夜")])
    assert state["world"]["time"] == "3日目の夜"


def test_char_retire_and_reintroduce():
    state = fold(empty_state(), [
        ev("e1", "char_introduce", char="ken"),
        ev("e2", "char_retire", char="ken", reason="death"),
    ])
    assert state["chars"]["ken"]["status"] == "retired"
    assert state["chars"]["ken"]["retire_reason"] == "death"


def test_manual_override_sets_path():
    state = fold(empty_state(), [
        ev("e1", "char_introduce", char="aya"),
        ev("e2", "manual_override", path="chars.aya.facts.items", value=["短剣"], note="手動修正"),
    ])
    assert state["chars"]["aya"]["facts"]["items"] == ["短剣"]


def test_fold_is_pure():
    parent = empty_state()
    fold(parent, [ev("e1", "char_introduce", char="aya")])
    assert parent["chars"] == {}  # 親 state は不変


def test_unknown_event_type_raises():
    with pytest.raises(ValueError):
        apply_event(empty_state(), ev("e1", "nonsense", char="aya"))


def test_hashes_are_deterministic():
    events = [ev("e1", "fact_set", scope="world", key="day", value=1)]
    s1 = fold(empty_state(), events)
    s2 = fold(empty_state(), events)
    assert state_hash(s1) == state_hash(s2)
    assert events_hash(events) == events_hash(events)
    assert input_hash("a", "b") != input_hash("a", "c")
