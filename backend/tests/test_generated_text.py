import pytest

from generated_text import normalize_scene_text


@pytest.mark.parametrize("text, expected", [
    (r"第一段落。\n\n第二段落。\n台詞。", "第一段落。\n\n第二段落。\n台詞。"),
    (r"前半。\r\n\r\n後半。", "前半。\n\n後半。"),
    ("通常の\n\n改行。", "通常の\n\n改行。"),
    (r"日本語・絵文字🌸と\tや\u3042", r"日本語・絵文字🌸と\tや\u3042"),
    (r"ファイルはC:\new\notes.txt。\n次の文。", "ファイルはC:\\new\\notes.txt。\n次の文。"),
    (r"共有は\\nas\new\notes.txt。\n次。", "共有は\\\\nas\\new\\notes.txt。\n次。"),
    (r"`\n`は改行表記。\n本文。", "`\\n`は改行表記。\n本文。"),
    ("```text\n\\n\\n\n```\\n次。", "```text\n\\n\\n\n```\n次。"),
])
def test_only_generated_line_breaks_are_decoded(text, expected):
    assert normalize_scene_text(text) == expected
    assert normalize_scene_text(expected) == expected
