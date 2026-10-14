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


def half_up(x):
    """`int(x + 0.5)` —— **必须**与前端 JS 的 `Math.floor(x + 0.5)` 同式。

    为什么不能用 python 内置 `round()`：它是银行家舍入（round(0.5)=0、round(1.5)=2、
    round(2.5)=2），而 JS 的 `Math.round` 是 half-up ⇒ 格线/色块边界会差 1px，
    用户拿到的 mask 边缘就会和画布上看到的差一格像素。
    """
    return int(x + 0.5)


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
    """白底上按格涂硬边色块 ⇒ 输出一张图像，直接喂 `MaskFromRGBCMYBW+`。

    ⚠️ 底图（`background` / `background_file`）**只作参考、只用来定宽高**，
    **不会**出现在输出里 —— 底图像素会污染按阈值拆色的 8 个通道。详见 `draw()`。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1216, "min": 64, "max": 4096, "step": 32}),
                "height": ("INT", {"default": 704, "min": 64, "max": 4096, "step": 32}),
                "cell": ([32, 64, 96, 128, 192, 256],
                         {"default": 128,
                          "tooltip": "格边长（像素）⇒ 格数 = 宽/格、高/格，自动尽量正方形"}),
                "regions": ("STRING", {"multiline": True, "default": "red 1 2 4 9 ; green 6 2 9 9",
                                       "tooltip": "颜色 列起 行起 列止 行止（半开区间）· 颜色见节点说明"}),
                "show_grid": ("BOOLEAN", {"default": True, "tooltip": "画浅灰格子线（只为好看，不影响拆色）"}),
                "background_file": ("STRING", {"default": "", "tooltip": "底图文件名（ComfyUI input 目录里）—— widget 里'上传底图'会自动填。**仅作参考并决定宽高，不进输出**"}),
            },
            "optional": {"background": ("IMAGE", {"tooltip": "想照着描就接进来（只作参考 + 决定宽高，**不会**出现在输出里）"})},
        }

    #: ⭐ 顺带把**实际用到的**宽高当 INT 吐出来（2026-10-14 用户要求："我们不是有画幅大小吗，
    #:    直接把数字连给 latent 不就行了"）—— 这样 `EmptyLatentImage` 的 width/height 直接连
    #:    这两个输出即可，不用再挂 `GetImageSize+` 反推。
    #: 注意这两个是**权威值**：`background_file` / `background` 命中时，尺寸是从底图量出来的
    #: （节点上的 width/height widget 那时会被底图尺寸覆盖），所以连它们比连 widget 更可靠。
    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("grid", "width", "height")
    FUNCTION = "draw"
    CATEGORY = "mask/grid"
    DESCRIPTION = ("网格涂色 → 输出 IMAGE（硬边、按格对齐）⇒ 直连 MaskFromRGBCMYBW+；"
                   "另有两个 INT 输出 width/height，直接连 EmptyLatentImage 的宽高。"
                   "颜色顺序固定：red green blue cyan magenta yellow black white")

    def draw(self, width, height, cell, regions, show_grid=True,
             background_file="", background=None):
        """输出 = **纯硬边色块图**（白底 + 涂的格子）。

        ⚠️ 底图（`background` 输入 / `background_file`）**只用来定尺寸**，绝不进输出。
        为什么：`MaskFromRGBCMYBW+` 是按阈值拆色的 —— 白 = mask7、黑 = mask6，
        其余 6 个通道各有自己的阈值；把底图铺进去，底图像素会**随机落进这些通道**
        （深色头发 → black 档、亮背景 → white 档），等于凭空多出一堆假 mask。
        底图仅在**节点画布上**做半透明参考，方便你照着描。
        """
        width, height, cell = int(width), int(height), max(8, int(cell))
        #: ① `background` 输入（IMAGE）⇒ 只用它自己的尺寸（不拉伸），内容**不参与**输出
        if background is not None:
            _, hh, ww, _ = background[:1].shape
            width, height = int(ww), int(hh)
        #: ② `background_file`（节点"上传底图"写进去的文件名）⇒ 同样只取尺寸
        elif str(background_file or "").strip():
            try:
                import os
                from PIL import Image
                import folder_paths
                fp = os.path.join(folder_paths.get_input_directory(),
                                  os.path.basename(str(background_file).strip()))
                if os.path.exists(fp):
                    with Image.open(fp) as im:
                        width, height = im.size
                    print("[GridMaskEditor] 底图 %s ⇒ 尺寸改为 %dx%d（不拉伸；底图仅作参考，不进输出）"
                          % (os.path.basename(fp), width, height))
            except Exception as exc:
                print("[GridMaskEditor] 读底图失败:", type(exc).__name__)
        #: ⚠️ 这里**不再看 aspect**（2026-10-13 修的 bug A）：宽高以 `width/height` 为准，
        #: 预设按钮只由**节点的画布 widget** 负责改这两个值 —— 否则手改宽高会被预设悄悄改回去。
        #: 格数四舍五入用 **half-up**（int(x+0.5)），与前端 JS 的 Math.floor(x+0.5) 逐格一致；
        #: python 的 round() 是银行家舍入 —— round(1344/128)=round(10.5)=10，而前端画 11 列 ⇒ 错位
        cols, rows = max(1, int(width / cell + 0.5)), max(1, int(height / cell + 0.5))
        #: ⭐ 底色**恒为白**：白 = mask7，是"什么都没画"的基准档，不会给拆色添假 mask
        canvas = np.full((height, width, 3), 255, dtype=np.uint8)
        for name, c0, r0, c1, r1 in parse_regions(regions):
            x0, x1 = sorted((max(0, min(cols, c0)), max(0, min(cols, c1))))
            y0, y1 = sorted((max(0, min(rows, r0)), max(0, min(rows, r1))))
            if x1 <= x0 or y1 <= y0:
                continue
            #: 按格对齐、**硬边**填充（不羽化 —— 拆色是按阈值比三通道的）
            #: ⭐ 边界与前端逐像素一致：JS 的 `Math.round` 是 half-up（0.5 进位），
            #:    python 的 `round` 是银行家舍入（round(0.5)=0、round(2.5)=2）⇒ 会差 1px。
            #:    实测 case(64,3): 前端格线在 352，python 原本画在 349.5→350（差 2px）。
            px0, px1 = half_up(x0 * width / cols), half_up(x1 * width / cols)
            py0, py1 = half_up(y0 * height / rows), half_up(y1 * height / rows)
            canvas[py0:py1, px0:px1] = COLORS[name]
        if show_grid:                                   # 格线 **纯白**：白色是"没涂"的基准档
            #: ⚠️ 曾经用 (210,210,210)：它本身不落在 black/white 任一档（阈值 0.15 ⇒ 需要 ≤38 或 ≥217），
            #:    但格线是**后画**的、会从色块里抠掉 1px 宽的缝 ⇒ 抠出来的缝算进 white 档，
            #:    用户拿到的 mask 边缘就带一圈白色小孔。改成纯白后格线与白底同档，缝不再"凭空出现"。
            for c in range(1, cols):
                canvas[:, min(width - 1, half_up(c * width / cols))] = (255, 255, 255)
            for r in range(1, rows):
                canvas[min(height - 1, half_up(r * height / rows)), :] = (255, 255, 255)
        t = torch.from_numpy(canvas.astype(np.float32) / 255.0).unsqueeze(0)
        print("[GridMaskEditor] %dx%d · %d×%d 格 · 涂了 %d 段" % (width, height, cols, rows,
                                                                  len(parse_regions(regions))))
        #: width/height 是**这张图实际的像素尺寸**（可能来自底图，而不是 widget 里的值）
        return (t, int(width), int(height))


NODE_CLASS_MAPPINGS = {"GridMaskEditor": GridMaskEditor}
NODE_DISPLAY_NAME_MAPPINGS = {"GridMaskEditor": "网格涂色 → 图像（接 MaskFromRGB…）"}
