"""GridMaskEditor —— 把"网格涂色"做成**纯节点**（2026-10-13 用户要求）。

为什么：我们的绘制器是独立网页、只能输出文件（cells.json → PNG），**没有输出插槽可以连线**。
这个节点让"网格"以 **IMAGE** 形式直接出现在图里 ⇒ 直连 `MaskFromRGBCMYBW+`，零文件、零服务器往返。

规格文本（`regions`）——**每个主体一行/一段**，分号分隔：
    red 1 2 4 9 ; green 6 2 9 9
含义：`颜色 列起 行起 列止 行止`（**列/行从 0 开始，半开区间** ⇒ 4 表示"到第 4 列之前"）。
颜色**必须**取自 `MaskFromRGBCMYBW+` 的固定顺序，否则拆不出来：
    red green blue cyan magenta yellow black white
"""
import numpy as np
import torch

#: ⚠️ 与 `ComfyUI_essentials/mask.py` 的 `RETURN_NAMES` **严格一致**（那是拆色的依据）
COLORS = {
    "red": (255, 0, 0), "green": (0, 255, 0), "blue": (0, 0, 255), "cyan": (0, 255, 255),
    "magenta": (255, 0, 255), "yellow": (255, 255, 0), "black": (0, 0, 0), "white": (255, 255, 255),
}
ORDER = ["red", "green", "blue", "cyan", "magenta", "yellow", "black", "white"]

#: 宽高预设 —— **与项目别处（Pipe 的 ASPECTS）逐字一致**，别各写一套
ASPECTS = {
    "16:9": (1344, 768), "3:2": (1216, 832), "4:3": (1152, 896), "1:1": (1024, 1024),
    "3:4": (896, 1152), "2:3": (832, 1216), "9:16": (768, 1344),
}


def parse_regions(spec):
    """`"red 1 2 4 9; green 6 2 9 9"` → `[("red",1,2,4,9), …]`（坏行直接跳过，不炸）。"""
    out = []
    for part in str(spec or "").replace("\n", ";").split(";"):
        toks = part.replace(",", " ").split()
        if len(toks) < 5:
            continue
        name = toks[0].strip().lower()
        if name not in COLORS:
            continue
        try:
            nums = [int(round(float(x))) for x in toks[1:5]]
        except Exception:
            continue
        out.append((name, *nums))
    return out


class GridMaskEditor:
    """白底（或你给的背景图）上按格涂硬边色块 ⇒ 输出一张图像，直接喂 `MaskFromRGBCMYBW+`。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1216, "min": 64, "max": 4096, "step": 32}),
                "height": ("INT", {"default": 704, "min": 64, "max": 4096, "step": 32}),
                "cell": ("INT", {"default": 128, "min": 8, "max": 512,
                                 "tooltip": "格边长（像素）⇒ 格数 = 宽/格、高/格，自动尽量正方形"}),
                "regions": ("STRING", {"multiline": True, "default": "red 1 2 4 9 ; green 6 2 9 9",
                                       "tooltip": "颜色 列起 行起 列止 行止（半开区间）· 颜色见节点说明"}),
                "show_grid": ("BOOLEAN", {"default": True, "tooltip": "画浅灰格子线（只为好看，不影响拆色）"}),
                "background_file": ("STRING", {"default": "", "tooltip": "底图文件名（ComfyUI input 目录里）—— widget 里'上传底图'会自动填；留空=白底"}),
            },
            "optional": {"background": ("IMAGE", {"tooltip": "想参考真实图就接进来（会铺在底下，网格涂在上面）"})},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("grid",)
    FUNCTION = "draw"
    CATEGORY = "mask/grid"
    DESCRIPTION = ("网格涂色 → 输出 IMAGE（硬边、按格对齐）⇒ 直连 MaskFromRGBCMYBW+。"
                   "颜色顺序固定：red green blue cyan magenta yellow black white")

    def draw(self, width, height, cell, regions, show_grid=True,
             background_file="", background=None):
        width, height, cell = int(width), int(height), max(8, int(cell))
        bg = None
        if background is not None:                        #: ② 有底图 ⇒ **用底图自己的尺寸**（不拉伸）
            bg = background[:1]
            _, hh, ww, _ = bg.shape
            width, height = int(ww), int(hh)
        elif str(background_file or "").strip():
            try:
                import os
                from PIL import Image
                import folder_paths
                fp = os.path.join(folder_paths.get_input_directory(),
                                  os.path.basename(str(background_file).strip()))
                if os.path.exists(fp):
                    im = Image.open(fp).convert("RGB")
                    width, height = im.size                #: ② 同上：按底图尺寸
                    bg = torch.from_numpy(np.asarray(im, dtype=np.float32) / 255.0).unsqueeze(0)
                    print("[GridMaskEditor] 底图 %s ⇒ 尺寸改为 %dx%d（不拉伸）" % (os.path.basename(fp), width, height))
            except Exception as exc:
                print("[GridMaskEditor] 读底图失败:", type(exc).__name__)
        #: ⚠️ 这里**不再看 aspect**（2026-10-13 修的 bug A）：宽高以 `width/height` 为准，
        #: 预设按钮只由**节点的画布 widget** 负责改这两个值 —— 否则手改宽高会被预设悄悄改回去。
        if background is None and str(background_file or "").strip():
            try:                                      #: 从 ComfyUI input 目录读底图（"导入底图"那条路）
                import os
                from PIL import Image
                import folder_paths
                fp = os.path.join(folder_paths.get_input_directory(), os.path.basename(str(background_file).strip()))
                if os.path.exists(fp):
                    arr = np.asarray(Image.open(fp).convert("RGB"), dtype=np.float32) / 255.0
                    background = torch.from_numpy(arr).unsqueeze(0)
                    print("[GridMaskEditor] 底图: %s (%dx%d)" % (os.path.basename(fp), arr.shape[1], arr.shape[0]))
            except Exception as exc:
                print("[GridMaskEditor] 读底图失败:", type(exc).__name__)
        cols, rows = max(1, round(width / cell)), max(1, round(height / cell))
        canvas = np.full((height, width, 3), 255, dtype=np.uint8)
        if bg is not None:                              #: 底图 1:1 铺底 —— **绝不缩放**（尺寸已按底图设好）
            canvas = (bg[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8).copy()
        for name, c0, r0, c1, r1 in parse_regions(regions):
            x0, x1 = sorted((max(0, min(cols, c0)), max(0, min(cols, c1))))
            y0, y1 = sorted((max(0, min(rows, r0)), max(0, min(rows, r1))))
            if x1 <= x0 or y1 <= y0:
                continue
            #: 按格对齐、**硬边**填充（不羽化 —— 拆色是按阈值比三通道的）
            px0, px1 = round(x0 * width / cols), round(x1 * width / cols)
            py0, py1 = round(y0 * height / rows), round(y1 * height / rows)
            canvas[py0:py1, px0:px1] = COLORS[name]
        if show_grid:                                   # 浅灰格线（离黑/白/纯色都够远，不影响阈值）
            for c in range(1, cols):
                canvas[:, min(width - 1, round(c * width / cols))] = (210, 210, 210)
            for r in range(1, rows):
                canvas[min(height - 1, round(r * height / rows)), :] = (210, 210, 210)
        t = torch.from_numpy(canvas.astype(np.float32) / 255.0).unsqueeze(0)
        print("[GridMaskEditor] %dx%d · %d×%d 格 · 涂了 %d 段" % (width, height, cols, rows,
                                                                  len(parse_regions(regions))))
        return (t,)


NODE_CLASS_MAPPINGS = {"GridMaskEditor": GridMaskEditor}
NODE_DISPLAY_NAME_MAPPINGS = {"GridMaskEditor": "网格涂色 → 图像（接 MaskFromRGB…）"}
