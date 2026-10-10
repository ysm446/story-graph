"""LLMがJSON内で二重エスケープした、散文の改行表記を補正する。"""
import re


# コードとWindowsの絶対パスは表記そのものとして保持する。
# unicode_escapeで本文全体をデコードすると日本語や他のエスケープまで壊れるため使わない。
_BREAKS = re.compile(r'```[\s\S]*?```|`[^`\n]*`|(?:[A-Za-z]:\\|\\\\)[^\s「」『』<>"。]+|(?<!\\)\\(?:r\\n|n|r)')


def normalize_scene_text(text: str) -> str:
    return _BREAKS.sub(lambda m: "\n" if m.group() in (r"\n", r"\r", r"\r\n") else m.group(), text)
