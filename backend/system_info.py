"""システムリソース(CPU / RAM / GPU / VRAM)とモデル一覧。

GPU は pynvml(NVIDIA)。無ければ None を返す(lm-chat の psutil/pynvml 構成)。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import psutil

log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent
# 設定(settings の models_dir)が空のときに使う既定のモデル置き場
DEFAULT_MODELS_DIR = REPO_ROOT / "models"

_nvml_handle = None
_nvml_failed = False

# cpu_percent は前回呼び出しからの差分で計算されるため、起動時に一度呼んで初期化する
psutil.cpu_percent(interval=None)


def _get_nvml_handle():
    global _nvml_handle, _nvml_failed
    if _nvml_handle is not None or _nvml_failed:
        return _nvml_handle
    try:
        import pynvml

        pynvml.nvmlInit()
        _nvml_handle = pynvml.nvmlDeviceGetHandleByIndex(0)
    except Exception:  # noqa: BLE001
        log.info("NVML が利用できません(GPU 情報なしで続行)")
        _nvml_failed = True
    return _nvml_handle


def resources() -> dict[str, Any]:
    ram = psutil.virtual_memory()
    result: dict[str, Any] = {
        "cpu_usage": round(psutil.cpu_percent(interval=None)),
        "ram_used": ram.used,
        "ram_total": ram.total,
        "gpu_usage": None,
        "vram_used": None,
        "vram_total": None,
    }
    handle = _get_nvml_handle()
    if handle is not None:
        try:
            import pynvml

            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            result["gpu_usage"] = int(util.gpu)
            result["vram_used"] = int(mem.used)
            result["vram_total"] = int(mem.total)
        except Exception:  # noqa: BLE001
            pass
    return result


def resolve_models_dir(models_dir: str | None = None) -> Path:
    """GGUF を探すフォルダ。設定(models_dir)が空なら既定の models/ を使う。"""
    if models_dir and models_dir.strip():
        return Path(models_dir.strip())
    return DEFAULT_MODELS_DIR


def list_models(models_dir: str | None = None) -> list[dict[str, Any]]:
    """モデルフォルダ配下の GGUF を列挙する(mmproj は Vision 用なので除外)。"""
    root = resolve_models_dir(models_dir)
    if not root.exists():
        return []
    models = []
    try:
        paths = sorted(root.rglob("*.gguf"))
    except OSError:  # ネットワークドライブが切れている等
        log.warning("モデルフォルダを読めません: %s", root)
        return []
    for path in paths:
        if path.name.lower().startswith("mmproj"):
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue  # 列挙後に消えたファイル(ダウンロード中断の削除等)
        models.append(
            {
                "name": path.stem,
                "path": str(path),
                "size": size,
            }
        )
    return models
