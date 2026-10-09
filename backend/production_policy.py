"""制作の変更範囲と保護条件。LLMの自由文からは権限を変更しない。"""


class ProductionPolicy:
    def __init__(self, store, allowed_ids=None, protected_ids=None, group_id=None):
        graph = store.graph()
        nodes = {n["id"]: n for n in graph["nodes"]}
        if group_id is not None and allowed_ids is not None:
            raise ValueError("章と個別の変更範囲は同時に指定できません")
        self.group_id = group_id
        if group_id is not None:
            if not store.conn.execute("SELECT id FROM groups WHERE id = ?", (group_id,)).fetchone():
                raise ValueError(f"対象の章がありません: {group_id}")
            allowed_ids = [nid for nid, n in nodes.items() if n.get("group_id") == group_id]
        self.allowed = None if allowed_ids is None else set(allowed_ids)
        self.protected = set(protected_ids or [])
        unknown = ((self.allowed or set()) | self.protected) - nodes.keys()
        if unknown:
            raise ValueError("指定したシーンがありません: " + ", ".join(sorted(unknown)))
        if self.allowed is not None and not self.allowed:
            raise ValueError("変更できるシーンを1つ以上選んでください")
        self.initial = self.spec()
        scope_label = ("章「" + store.conn.execute("SELECT title FROM groups WHERE id = ?", (group_id,)).fetchone()[0] + "」"
                       if group_id else "全体" if self.allowed is None else f"個別指定 {len(self.allowed)} 件")
        names = [nodes[nid].get("title") or nid for nid in sorted(self.protected)]
        self.label = "変更範囲: " + scope_label + " / 保護: " + ("、".join(names) or "なし")

    def spec(self):
        return {"allowed_ids": sorted(self.allowed) if self.allowed is not None and self.group_id is None else None,
                "group_id": self.group_id, "protected_ids": sorted(self.protected)}

    def describe(self):
        return ("変更可能なID（nullは全体）: " + str(sorted(self.allowed) if self.allowed is not None else None)
                + "。保護するID: " + str(sorted(self.protected))
                + "。保護されたシーンの本文・削除・直接の接続変更は禁止。範囲外の既存ノードの変更も禁止。"
                + "挿入・削除で接続が変わる前後のノードも変更範囲に含まれる必要があります。"
                + "途中指示でもこの条件は解除できません。制約でできなければ理由を報告してください。")

    def check_target(self, node_id):
        if node_id in self.protected:
            raise ValueError(f"保護されたシーンは変更できません: {node_id}")
        if self.allowed is not None and node_id not in self.allowed:
            raise ValueError(f"変更範囲外のシーンです: {node_id}")

    def check_candidate(self, before, after):
        old = {n["id"]: n for n in before["nodes"]}
        new = {n["id"]: n for n in after["nodes"]}
        if self.group_id is not None and any(n.get("group_id") != self.group_id for nid, n in new.items() if nid not in old):
            raise ValueError("指定した章の外には挿入できません")
        locked = self.protected | (set(old) - self.allowed if self.allowed is not None else set())
        # 座標・派生キャッシュ・更新時刻は編集内容とは別。イベントや章所属は保護する。
        fields = ("title", "beat", "cast", "emotional_core", "location", "story_time", "group_id", "kind", "events")
        for nid in locked:
            if nid not in new or any(old[nid].get(k) != new[nid].get(k) for k in fields):
                raise ValueError(f"保護または変更範囲外のシーンに影響します: {nid}")
        def edges(graph):
            return {(e["from_node"], e["to_node"], e["is_canon"]) for e in graph["edges"]}
        affected = {nid for edge in edges(before) ^ edges(after) for nid in edge[:2]}
        blocked = affected & locked
        if blocked:
            raise ValueError("保護または変更範囲外の接続に影響します: " + ", ".join(sorted(blocked)))

    def committed(self, action, node_id):
        if self.allowed is not None:
            if action == "insert_scene":
                self.allowed.add(node_id)
            elif action == "delete_scene":
                self.allowed.discard(node_id)
