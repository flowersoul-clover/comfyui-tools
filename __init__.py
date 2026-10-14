"""comfyui-tools · ComfyUI 节点集合包。

ComfyUI 只扫描 custom_nodes 的第一层目录，而本仓库的节点包在子目录里；
这个根 __init__.py 把子包转发出来，让整个仓库 clone 进 custom_nodes 就能直接用。
"""
import importlib.util
import os
import sys

_ROOT = os.path.dirname(os.path.realpath(__file__))


def _load_subpackage(dir_name):
    init_py = os.path.join(_ROOT, dir_name, "__init__.py")
    spec = importlib.util.spec_from_file_location(
        dir_name.replace("-", "_"), init_py,
        submodule_search_locations=[os.path.dirname(init_py)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module   #: 子包内的相对导入（from .nodes import ...）需要父包已在 sys.modules
    spec.loader.exec_module(module)
    return module


_grid_mask_editor = _load_subpackage("grid-mask-editor")

NODE_CLASS_MAPPINGS = dict(_grid_mask_editor.NODE_CLASS_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS = dict(_grid_mask_editor.NODE_DISPLAY_NAME_MAPPINGS)
#: WEB_DIRECTORY 相对模块目录（= 仓库根）解析，必须带上子目录前缀
WEB_DIRECTORY = "grid-mask-editor/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
