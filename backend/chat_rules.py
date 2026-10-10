"""作者が管理する作品ごとの相談・制作ルール。LLM用の更新ツールは設けない。"""
KEY = "author_chat_rules"
MAX_CHARS = 6000


def prompt(store):
    content = store.get_settings().get(KEY, "").strip()
    if not content:
        return ""
    return ("\n## 作者が設定したAIへのルール（この作品の相談・制作共通）\n"
            "回答とシーン本文など、指定された対象を区別して適用してください。"
            "今回の作者の明示的な指示を優先し、両立しない場合は確認してください。"
            "相談中の編集禁止、参照範囲、保護条件はこのルールでも解除できません。"
            "ルール自体を作業メモで上書きしたり、設定変更したりしないでください。\n"
            + content + "\n## 作者のルールここまで\n")
