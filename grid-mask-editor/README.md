# GridMaskEditor — paint region masks by grid, inside ComfyUI

A single ComfyUI custom node: **draw a grid with your mouse, get a hard-edged colour map, wire it straight into `MaskFromRGBCMYBW+`** to obtain one mask per subject — no files, no server round-trip.

![concept](https://img.shields.io/badge/ComfyUI-custom%20node-blue)

## Why

Regional / multi-subject generation needs **N masks**. The usual routes are painful: a separate mask-painting website, exporting `cells.json`, a script that turns it into PNGs, then `LoadImageMask` … This node collapses all of that into the graph.

The colours are **not arbitrary**: `MaskFromRGBCMYBW+` (from [ComfyUI_essentials](https://github.com/cubiq/ComfyUI_essentials)) splits an image by thresholds in a **fixed order**:

| paint | → mask | use |
|---|---|---|
| `red` | mask0 | subject 1 |
| `green` | mask1 | subject 2 |
| `blue` | mask2 | subject 3 |
| `cyan` | mask3 | subject 4 |
| `magenta` | mask4 | subject 5 |
| `yellow` | mask5 | subject 6 |
| `black` | mask6 | ⚠️ use for "nothing / background" |
| `white` | mask7 | ⚠️ canvas background — do **not** use for a subject |

## Features

- **Mouse painting** on a grid inside the node (left = paint, right / Shift = erase).
- **Grid resolution**: `256 / 128 / 64 / 32 / 16 / 8` px per cell (default 128). Picking a finer grid **keeps what you already painted** (coarse → refine).
- **Undo**: one continuous drag = one step (button + `Ctrl+Z`).
- **Aspect presets**: `16:9 3:2 4:3 1:1 3:4 2:3 9:16`.
- **Import a background**: upload an image, it becomes the canvas backdrop, and **width/height snap to that image** (never stretched) so you can trace it.
- **Semi-transparent overlay** on screen, but the emitted image is **hard-edged and opaque** (thresholoding needs exact colours).
- **`regions` text is the single source of truth** — you can also type it:
  `"red 1 2 4 9 ; green 6 2 9 9"` = `colour col_start row_start col_end row_end`, half-open, 0-based.

## Install

```bash
cd <ComfyUI>/custom_nodes
git clone <this repo> grid-mask-editor
# restart ComfyUI
```

Then add **GridMaskEditor → MaskFromRGBCMYBW+** (ComfyUI_essentials) and feed the masks to your regional conditioning (e.g. `DenseDiffusionAddCondNode`, which needs **1 base + 4 subject** regions).

## Notes / limits

- Only useful together with `MaskFromRGBCMYBW+` (or any node that thresholds exact colours).
- Keep painting **hard-edged** (no soft brush): anti-aliased pixels blend channels and break thresholding.
- Verified on ComfyUI 0.38 (WSL2). The mouse handling is a litegraph-native canvas widget (same mechanism as PainterNode).
