"""网格掩码编辑器 · ComfyUI 节点包。

① **节点** `GridMaskEditor`（`nodes.py`）：文本规格 → 硬边涂色网格 **IMAGE** ⇒ 直连 `MaskFromRGBCMYBW+`。
② **前端**（`js/`，`WEB_DIRECTORY`）：右下角「🧩 网格工具」按钮，内嵌我们自己的绘制器（:8765）。
"""
from .nodes import NODE_CLASS_MAPPINGS as _N, NODE_DISPLAY_NAME_MAPPINGS as _D

WEB_DIRECTORY = "js"
NODE_CLASS_MAPPINGS = dict(_N)
NODE_DISPLAY_NAME_MAPPINGS = dict(_D)
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
