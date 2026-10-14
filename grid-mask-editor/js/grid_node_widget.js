/* GridMaskEditor 画布 widget —— litegraph 原生 canvas widget（draw + mouse）
 * ============================================================================
 * 机制（读的是本机前端 comfyui-frontend-package==1.53.10 的实际代码）：
 *
 * ① 渲染有两条路径，都由前端直接调 `widget.draw(ctx, node, width, y, height)`：
 *    - 经典 canvas（LGraphNode.drawWidgets）：ctx 只平移到**节点左上角**，
 *      y = 本 widget 顶边在节点体内的偏移 ⇒ draw 必须自己 `translate(0, y)`。
 *      行高用我们 computeSize()[1] 声明的值（传进来的 height 恒为 20，不能信）。
 *    - Vue 节点模式（WidgetLegacy.vue，Comfy Desktop 默认开）：widget 是一个独立
 *      DOM <canvas>，ctx 只 scale(2,2)，y 恒为 1。它传的 width 是
 *      `getBoundingClientRect().width`（视觉宽，随 zoom 变）——**不能直接用**，
 *      否则元素 CSS 高度 = 布局宽×(高/宽) 会随 zoom 拉伸。改用
 *      `ctx.canvas.clientWidth`（布局宽，与 zoom 无关），并把 backing store
 *      钉成 clientWidth×(total+2)，任何 zoom 下都不变形。
 * ② 鼠标：点击落在 widget 区域时**两种模式都只调 widget.mouse(e, pos, node)**——
 *    `node.onMouseDown` 在经典模式是"没命中任何 widget"的 else 分支，Vue 模式下
 *    `_processNodeClick` 开头直接 return（节点级回调整条不派发）。所以本文件只有
 *    widget.mouse 一个入口：
 *    - Vue：pos 是元素局部 CSS 像素（元素随 zoom 有拉伸 ⇒ 按元素实际尺寸换回
 *      绘制坐标）；up 事件的 pos 是节点体坐标（前端 quirk），但 up 不用坐标。
 *    - 经典：pos 是节点体坐标 ⇒ 减行顶 widget.last_y 成行内坐标。
 * ③ 重绘：Vue 模式下 setDirtyCanvas 碰不到 DOM canvas，必须调 WidgetLegacy 挂上来的
 *    `widget.triggerDraw()`；经典模式靠 setDirtyCanvas(true)。repaint() 两个都调。
 *    ⚠️ 绝不能再拿 app.canvas.ctx 直接画 —— Vue 模式下那会画到图原点的空白处
 *    （实测就是"整块灰色盖在画布上"的来源）。
 * ④ 同步：Vue 模式下 onDrawForeground 不会被调 ⇒ width/height/cell/background_file
 *    的"外部改动"靠包 widget.callback；工作流载入靠 onConfigure 后的 __gridRefresh。
 *
 * 功能：颜色（与 MaskFromRGBCMYBW+ 固定顺序）、撤销（一次拖动=一步，栈深 100）、
 * 宽高预设、上传底图（按底图实际尺寸、不拉伸）、半透明显示+格线在下、regions 双向
 * 同步、拖动只重绘松手才写文本、状态行。详细注释见下面各段。
 */
import { app } from "/scripts/app.js";

//: 构建标记 —— 只用来在浏览器里确认"磁盘上的新版真的被加载了"（缓存/旧副本排查）
const GRID_BUILD = "2026-10-14-fit-v3";

/* ───────────────────────────── 常量 ───────────────────────────── */

//: 必须与 MaskFromRGBCMYBW+ 的固定顺序**逐字一致**（mask 序号 = 此数组下标）
const COLORS = ["red", "green", "blue", "cyan", "magenta", "yellow", "black", "white"];
const RGB = {
  red: "#ff0000", green: "#00ff00", blue: "#0000ff", cyan: "#00ffff",
  magenta: "#ff00ff", yellow: "#ffff00", black: "#000000", white: "#ffffff",
};
const MASKIDX = {}; COLORS.forEach((c, i) => (MASKIDX[c] = i));

const DEFAULT_CELL = 128;

//: 宽高预设 —— 与 nodes.py 的 ASPECTS **逐字一致**（只改 width/height 两个 widget 的值）
const ASPECTS = [["16:9", 1344, 768], ["3:2", 1216, 832], ["4:3", 1152, 896],
                 ["1:1", 1024, 1024], ["3:4", 896, 1152], ["2:3", 832, 1216],
                 ["9:16", 768, 1344]];

//: 画布**兜底宽度**（只在还没画过 / 传入宽度非法时用）；真实宽度一律取宿主传进来的
const BASE_W = 560;
//: 最小宽度：比这个更窄时把节点撑住，否则控件会互相挤
const MIN_W = 640;
const ROW_GAP = 2;
const INFO_H = 26;        //: 状态行（两行小字）
const MAX_CANVAS = 2048; //: 画布边长上限（能包容 2048×2048 底图；竖图超限时格边长被压低、画布在行内居中）

/* ───────────────────── 纯数据层：regions ⇄ cells ───────────────────── */
/* regions 是**唯一真源**；cells 只是它的可视化解码。 */

function parseRegions(s) {
  const out = [];
  String(s || "").replace(/\n/g, ";").split(";").forEach((part) => {
    const t = part.replace(/,/g, " ").trim().split(/\s+/);
    if (t.length < 5 || !COLORS.includes(t[0].toLowerCase())) return;
    const n = t.slice(1, 5).map((x) => parseInt(x, 10));
    if (n.some((x) => Number.isNaN(x))) return;
    out.push({ color: t[0].toLowerCase(), c0: n[0], r0: n[1], c1: n[2], r1: n[3] });
  });
  return out;
}

//: 半开区间 [c0,c1) × [r0,r1)，**按行合并成段** ⇒ 细格时字符串才不会爆掉
function toRegions(cells, cols, rows) {
  const segs = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const col = cells[c + "," + r];
      if (!col) { c++; continue; }
      let e = c + 1;
      while (e < cols && cells[e + "," + r] === col) e++;
      segs.push(`${col} ${c} ${r} ${e} ${r + 1}`);
      c = e;
    }
  }
  return segs.join(" ; ");
}

function cellsFromText(txt, cols, rows) {
  const cells = {};
  parseRegions(txt).forEach(({ color, c0, r0, c1, r1 }) => {
    for (let r = Math.max(0, r0); r < Math.min(rows, r1); r++)
      for (let c = Math.max(0, c0); c < Math.min(cols, c1); c++) cells[c + "," + r] = color;
  });
  return cells;
}

/* ───────────────── 数值健壮性（这一节是"NaN 疫情"的疫苗） ─────────────────
 * 实测踩到（用户工作流 grid_node_to_masks_ui.json 直接复现）：
 *   那个工作流存的是**旧版的 6 个 widgets_values**（第一位是已删掉的 `aspect`="自定义"）。
 *   ComfyUI 按位置灌值 ⇒ `width` 拿到字符串 "自定义"、`regions` 拿到 "red 29 2 …"、
 *   `background_file` 拿到 `true`，**整体错位一格**。
 *   于是 `Number("自定义")/…` ⇒ NaN，而 **`Math.max(1, NaN)` 仍然是 NaN（不是 1！）**，
 *   一路传染到 Math.round / ctx.fillText / computeSize() ⇒ 画布整块画不出来、
 *   界面上写出 `NaN` 和 `NaN-768`。
 *   ⇒ **每个数值入口都必须配 Number.isFinite 兜底**，只靠 Math.max/Math.round 夹取是不够的。
 */
const DEFAULT_W = 1216, DEFAULT_H = 704;
const asFinite = (v, d) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : d;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return d;
};
//: 夹取也要防 NaN/Infinity：非法 ⇒ 先取默认值，再夹
const clampFinite = (v, lo, hi, d) => {
  const n = asFinite(v, d);
  return Math.min(hi, Math.max(lo, n));
};
//: 保证返回有限正整数（computeSize 的返回必须扛得住这个）
const finiteInt = (v, d, lo, hi) => Math.max(lo, Math.round(clampFinite(v, lo, hi, d)));

function widgetStore() {
  try {
    const S = globalThis.comfyAPI?.app?.widgets;
    if (S) return S();
  } catch (e) {}
  return null;
}

/* ── 老格式工作流修正（关键：必须在 onConfigure **之前**跑，值才会正确落位） ──
 * 实测：`grid_node_to_masks_ui.json` 存的是**旧版 widgets_values**，
 * 多出一个已删除的 `aspect`（中文界面下是 "自定义"）⇒ 按位置灌值整体错位一格：
 *   width="自定义" · height=1216 · cell=1536 · regions=<颜色格式串> · show_grid=<颜色格式串> · background_file=true
 * 判据用**位置**（`info.widgets_values[0]` 是不是数值）—— 这是唯一可靠的信号：
 * 正确格式下第一位一定是 `width`（INT）。命中后在原数组上**原地**把值改对，
 * 这样无论后续按位置还是按名字落位，读到的都是好值。
 * ⚠️ `regions` 必须清空而不是"向后挪一格"：挪过来的 `red 29 2 44 3`（格格式）会被新版
 *    解析器当成"列起 行起 列止 行止" ⇒ 生成几千格、直接卡死；实测画一格就把它覆盖成
 *    `red 0 0 1 1`，等于把用户原来画的图形整块丢掉。
 * 正常数据一个字节都不动。 */
function repairLegacyWidgets(nodeData, info, node) {
  try {
    if (nodeData?.name !== "GridMaskEditor") return;
    const wv = info && info.widgets_values;
    const S = widgetStore();
    let vals = Array.isArray(wv) ? wv : (Array.isArray(node?.widgets) ? node.widgets.map((w) => w.value) : null);
    if (!vals || vals[0] === undefined) return;
    if (typeof vals[0] === "number") return;              //: 第一位是数值 ⇒ 格式正常
    console.warn("[grid_node_widget] 检测到旧格式工作流（widget 值错位）；修正前 widgets_values =",
      JSON.stringify(vals.slice(0, 6)) + (vals.length > 6 ? " …" : ""));
    const fixed = { width: DEFAULT_W, height: DEFAULT_H, cell: DEFAULT_CELL, show_grid: true };
    if (Array.isArray(wv)) {
      //: 原地改对：这样后续无论按位置灌还是按名字灌，读到的都是好值
      wv[0] = fixed.width; wv[1] = fixed.height; wv[2] = fixed.cell;
      wv[3] = "";                                        //: regions：旧颜色格式，拿不准就清空
      wv[4] = true;                                      //: show_grid
      //: 剩下第 6 位本来该是 background_file；老数据里可能是 show_grid 被挤过来的 true ⇒ 清掉
      if (typeof wv[5] !== "string") wv[5] = "";
    }
    const apply = (k, v) => {
      const w = node && (node.widgets || []).find((x) => x.name === k);
      if (w) w.value = v;
      if (S) { try { S.setWidgetValue(nodeData.name, k, v); } catch (e) {} }
    };
    for (const k in fixed) apply(k, fixed[k]);
    apply("regions", "");
    apply("background_file", "");
    console.warn("[grid_node_widget] 修正后：width/height/cell/show_grid 归位、regions 已清空（原值是旧颜色格式，无法安全转换）");
  } catch (e) {
    console.warn("[grid_node_widget] 旧格式修正失败（不影响加载）:", e && e.message);
  }
}

/* ───────────────────── 单个 GridMaskEditor 节点的画布 ───────────────────── */

function buildGridCanvasWidget(node) {
  /* ── widget 取值/写值：与 nodes.py 的 width / height / cell / background_file / regions 打通 ── */
  const find = (k) => (node.widgets || []).find((w) => w.name === k);
  //: ⚠️ 读值必须过 asFinite：老工作流错位后这里可能是 "自定义" / true / undefined
  const W = (k, d) => { const w = find(k); return w ? asFinite(w.value, d) : d; };
  //: 我们自己的写入**不触发 callback**：回调里包了"外部改动"处理（remap/重载底图），会重复跑
  const setWidget = (k, v) => {
    const w = find(k); if (!w) return;
    w.value = v;
  };
  const getRegionsText = () => { const w = find("regions"); return w ? String(w.value || "") : ""; };
  //: 不直接触发 regions 的 callback（它是 python 侧文本框，回调可能重入）
  const setRegionsTextQuiet = (v) => { const w = find("regions"); if (w) w.value = v; };

  /* ── 状态 ── */
  const state = {
    active: "red",
    cells: {},
    cols: 1, rows: 1,
    bgImg: null,
    painting: false,
    hover: null,
    erase: false,
    layout: null,
  };
  //: 最近一次真实绘制用的宽度（0 = 还没画过）。computeSize 与它共用 ⇒ 声明宽度==绘制宽度
  let lastDrawnW = 0;
  //: 行宽本来就等于节点宽 ⇒ 以 node.size[0] 为准，lastDrawnW 只作兜底
  const widthSource = () => {
    const nw = Number((node && node.size && node.size[0]) || 0);
    return Math.max(MIN_W, nw || 0, lastDrawnW || 0);
  };
  let lastDrawArgs = null;      //: 最近一次 draw 收到的 (width, y, height) 与我们的总高

  /* ── 网格几何：cols/rows 由 width/height/cell 决定（下面多处要用，先定义） ── */
  /* `grid()` 必须与 `fit()` 用**同一个 cell** 推导格数，否则网格与画布对不齐。
   * 为什么不能直接用 widget 里的 cell：`fit()` 会在下面两种情况下压低格边长 ——
   *   ① 画布边长上限 MAX_CANVAS（2048）；② 节点太窄（临时）。
   * 若 grid() 读的是原始 cell、fit() 读的是压低后的 cell，就会 9 列 vs 10 列地错开。 */
  function grid() {
    const f = naturalCanvas();
    return { cols: f.cols, rows: f.rows };
  }
  const syncGrid = () => { const g = grid(); state.cols = g.cols; state.rows = g.rows; };
  //: 当前实际生效的格边长（= 用户选的档位，被 MAX_CANVAS 压过；不含"按行宽缩小"那一段）
  const cellPx = () => naturalCanvas().naturalCell;

  /* ── ⭐ 唯一的格子几何计算（2026-10-14 重构） ─────────────────────────────
   * 全文件只此一处推导格子/画布尺寸，避免"网格用一套 cell、画布用另一套"的错位。
   *
   * 两个概念必须分开（这是之前反复修不好的根源）：
   *   ① **格数 cols/rows** —— 用户的 cell 档位 + width/height 决定，**永远不变**。
   *      它同时是 python 侧 `int(width/cell+0.5)` 的结果，两边必须逐格一致。
   *   ② **画出来的 cell** —— 格数不变，但画布可以在**给我们的那一行**里等比缩小
   *      （节点被拖窄 / 侧边参数面板只有 ~190px）。缩小只影响显示，不影响格数。
   *
   * ⚠️ 这里**绝不**读 node.size —— 那会造成"节点高 ⇒ 格子小 ⇒ 声明行高小 ⇒ 节点矮"
   *    的滞后回环：底图换尺寸后画布永远差一帧（用户报的"上传底图完全没修复"）。
   *    `availW`/`availH` 是**宿主这一次调用**传进来的可用绘制区域。
   *
   * 格数用 half-up（int(x+0.5)），与 nodes.py 的 `int(width/cell + 0.5)` 同式；
   * python 的 round() 是银行家舍入（round(10.5)=10）会让 10.5 格变 10 列而前端画 11 列。 */
  const MIN_CELL = 4;
  const halfUp = (x) => Math.floor(x + 0.5);
  function fit(prefCell, availW, availH) {
    const w = Math.max(1, W("width", DEFAULT_W)), h = Math.max(1, W("height", DEFAULT_H));
    const pref = Math.max(MIN_CELL, asFinite(prefCell, DEFAULT_CELL));
    const cols = Math.max(1, halfUp(w / pref));
    const rows = Math.max(1, halfUp(h / pref));
    //: ① 自然格：保留用户档位；只有画布超过 MAX_CANVAS 才**等比**压到上限内（两个方向都满足）。
    //:    ⚠️ 缩放因子必须按 cols/rows 反推：只按 max(w,h)/MAX 缩，宽图仍会超上限
    //:    （实测 4096×1024 会给出 8192×2048 的画布）。
    const cap = Math.min(MAX_CANVAS / (cols * pref), MAX_CANVAS / (rows * pref), 1);
    const nCell = Math.max(MIN_CELL, pref * cap);
    const nW = Math.round(nCell * cols), nH = Math.round(nCell * rows);
    //: ② 这次真正画多大：给的空间不够就等比缩（格数不变，只改每格像素）
    let cell = nCell;
    const aw = Number(availW), ah = Number(availH);
    if (Number.isFinite(aw) && aw > 40 && aw < nW) cell = Math.min(cell, (aw - 4) / cols);
    if (Number.isFinite(ah) && ah < 1e8 && ah < nH) cell = Math.min(cell, (ah - 4) / rows);
    cell = Math.max(MIN_CELL, cell);
    return { cols, rows, cell, canvasW: Math.round(cell * cols), ch: Math.round(cell * rows),
             naturalCell: nCell, naturalW: nW, naturalH: nH };
  }
  //: 自然（不被节点边界夹）画布尺寸 —— 节点边界就贴它
  function naturalCanvas() { return fit(W("cell", DEFAULT_CELL), 0, 1e9); }
  //: ⚠️ computeSize()/Vue 的容器高 直接吃这个 ⇒ 必须保证是有限正整数
  const contentH = () => {
    try {
      const n = naturalCanvas();
      return finiteInt(2 + n.ch + ROW_GAP + INFO_H + 2, 64, 64, 16384);
    } catch (e) { return 600; }
  };

  /* ── 自愈：老工作流按位置灌错值 ⇒ 把坏掉的数值 widget 归位 ──
   * 只在"确实不是有限数"时才写，绝不覆盖合法值。不这么做的话画布虽然能画了，
   * 但用户一保存工作流，坏值还会被写回去（等于没修）。 */
  function healNumericWidgets() {
    const rules = [["width", DEFAULT_W, 64, 4096], ["height", DEFAULT_H, 64, 4096], ["cell", DEFAULT_CELL, 8, 512]];
    const bad = [];
    for (const [k, d, lo, hi] of rules) {
      const w = find(k); if (!w) continue;
      if (!Number.isFinite(Number(w.value))) {        //: Number("自定义") / Number(true) ⇒ NaN
        w.value = finiteInt(d, d, lo, hi);
        bad.push(k);
      }
    }
    if (bad.length) console.warn("[grid_node_widget] 工作流里的数值 widget 坏了，已按默认值修复：", bad.join(", "));
  }

  /* ── 撤销：**一次连续拖动 = 一步**（按下时入栈，拖动过程中不再入） ── */
  const undoStack = [];
  const pushUndo = () => {
    undoStack.push(JSON.stringify(state.cells));
    if (undoStack.length > 100) undoStack.shift();     //: 栈深 100
  };
  const undo = () => {
    if (!undoStack.length) return;
    try { state.cells = JSON.parse(undoStack.pop()) || {}; } catch (e) { return; }
    setRegionsTextQuiet(toRegions(state.cells, grid().cols, grid().rows));  //: 撤销要落盘
    repaint();
  };

  //: 老格子 → 新格子的**整块**映射（按比例铺满）：粗选 → 细化不丢
  function remapCells(from, to) {
    if (from.cols === to.cols && from.rows === to.rows) return state.cells;
    const nc = {};
    const sx = to.cols / from.cols, sy = to.rows / from.rows;
    for (const k in state.cells) {
      const [c, r] = k.split(",").map(Number);
      const c0 = Math.round(c * sx), c1 = Math.max(c0 + 1, Math.round((c + 1) * sx));
      const r0 = Math.round(r * sy), r1 = Math.max(r0 + 1, Math.round((r + 1) * sy));
      for (let cc = c0; cc < c1; cc++)
        for (let rr = r0; rr < r1; rr++) nc[cc + "," + rr] = state.cells[k];
    }
    return nc;
  }

  /* ── 写回 / 读回（regions 双向） ── */
  function push() {   //: 松手时才调用 —— 细格时 toRegions 字符串几千段，不能每帧跑
    setRegionsTextQuiet(toRegions(state.cells, grid().cols, grid().rows));
    repaint();
  }

  function pull() {   //: 手改 regions 文本 → 画布重画回来
    const g = grid();
    const t = getRegionsText();
    if (t === lastPushedText) return;
    lastPushedText = t;
    const c = cellsFromText(t, g.cols, g.rows);
    if (JSON.stringify(c) !== JSON.stringify(state.cells)) { state.cells = c; repaint(); }
  }
  let lastPushedText = "";

  /* ── 尺寸变化（改 width/height widget 的值，不碰 node.setSize） ── */
  function applySize(w, h) {
    const from = { cols: state.cols, rows: state.rows };
    setWidget("width", Math.round(w));
    setWidget("height", Math.round(h));
    syncGrid();
    refreshAspect();
    state.cells = remapCells(from, { cols: state.cols, rows: state.rows });   //: 换尺寸不丢画
    push();
    fitNode();   //: ⭐ 画布变宽/变高 ⇒ 节点边界跟着收放（上传底图走的就是这条路）
  }

  /* ── 底图 ── */
  const loadBg = (name, adapt) => {
    if (!name) { state.bgImg = null; repaint(); return; }
    const img = new Image();
    img.onload = () => {
      state.bgImg = img;
      if (adapt) applySize(img.naturalWidth, img.naturalHeight);   //: 手填/上传底图 ⇒ 画布跟着底图走
      else repaint();   //: 工作流还原时不动已保存的宽高
    };
    img.onerror = () => { state.bgImg = null; };
    img.src = "/view?filename=" + encodeURIComponent(name) + "&type=input";
  };

  //: 上传：POST /upload/image（FormData: image, overwrite=true）→ 文件名写进 background_file
  //:     ⇒ 并且**按底图实际尺寸**改 width/height（绝不拉伸底图）
  function pickAndUpload() {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.className = "grid-mask-editor-upload";   //: 只为可定位/可测试，无样式含义
    inp.style.cssText = "position:fixed;left:-10000px;top:0";
    document.body.appendChild(inp);
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      try { if (inp.parentNode) inp.parentNode.removeChild(inp); } catch (e) {}
      if (!f) return;
      const fd = new FormData();
      fd.append("image", f);
      fd.append("overwrite", "true");
      try {
        const r = await fetch("/upload/image", { method: "POST", body: fd });
        const j = await r.json();
        const nm = (j && (j.name || j.filename)) || "";
        if (!nm) throw new Error("服务器没返回文件名");
        setWidget("background_file", nm);
        const probe = new Image();
        probe.onload = () => {
          state.bgImg = probe;
          applySize(probe.naturalWidth, probe.naturalHeight);   //: 按底图尺寸，不拉伸
        };
        probe.onerror = () => { status2 = "底图加载失败：" + nm; repaint(); };
        probe.src = "/view?filename=" + encodeURIComponent(nm) + "&type=input";
        status2 = "已上传：" + nm;
      } catch (e) {
        status2 = "上传失败：" + (e && e.message);
        repaint();
      }
    };
    inp.click();
  }

  //: regions 文本编辑器（双向：手改 regions → 画布重画）
  function editRegions() {
    const ta = document.createElement("textarea");
    ta.value = getRegionsText();
    ta.style.cssText = "width:min(760px,80vw);height:min(420px,50vh);font:12px monospace;" +
      "background:#141418;color:#ddd;border:1px solid #555;border-radius:6px;padding:8px;white-space:pre";
    const apply = document.createElement("button");
    apply.textContent = "应用到画布";
    apply.style.cssText = "padding:4px 12px;border-radius:6px;cursor:pointer";
    const cancel = document.createElement("button");
    cancel.textContent = "关闭";
    cancel.style.cssText = "padding:4px 12px;border-radius:6px;cursor:pointer";
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:8px;background:rgba(0,0,0,0.6)";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:8px";
    bar.append(apply, cancel);
    wrap.append(ta, bar);
    const close = () => { try { wrap.remove(); } catch (e) {} };
    apply.onclick = () => {
      const t = ta.value;
      lastPushedText = t;
      setRegionsTextQuiet(t);
      const g = grid();
      state.cells = cellsFromText(t, g.cols, g.rows);
      close(); repaint();
    };
    cancel.onclick = close;
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    document.body.appendChild(wrap);
  }

  let status2 = "";

  /* ─────────────────────────── 绘制 ─────────────────────────── */

  /* ⚠️ `total` 是**纯行高**（这一行自己有多高），**不含**任何绝对 y。
   *    litegraph 只把 `computeSize()[1]` 当行高用（行顶 y 由它自己累加），
   *    所以这里绝不能把 y0 混进 total。 */

  function layout(width, height) {
    const w = finiteInt(width, BASE_W, 160, 8192);
    /* ⭐ 正方形格；宽高比严格 == width:height ⇒ 底图 contain 恰好铺满。
     *    可用绘制区域 = 宿主分配给我们的那一行（宽 × 高）。
     *    `height` 为假值（经典路径的 draw 只传 height=20，不能信）⇒ 高度不限，
     *    也就是**按自然尺寸画**，节点边界由 fitNode()/_arrangeWidgets 贴上来。 */
    const roomH = (Number.isFinite(Number(height)) && Number(height) > 60) ? Number(height) : 1e9;
    const f = fit(W("cell", DEFAULT_CELL), w, roomH);
    const canvasW = f.canvasW, ch = f.ch;
    const x0 = Math.max(2, Math.round((w - canvasW) / 2));   //: 比行宽窄时（竖图）居中
    const yCv = 2;                                   //: **行内**坐标（行顶 = 0）
    const yInfo = yCv + ch + ROW_GAP;
    return {
      w, ch, canvasW, x0, yCv, yInfo, showInfo: true,
      cols: f.cols, rows: f.rows, cell: f.cell,
      naturalW: f.naturalW, naturalH: f.naturalH,
      total: yInfo + INFO_H + 2,
    };
  }

  function drawGrid(ctx, L) {
    const x0 = L.x0, y0 = L.yCv;
    const cols = Math.max(1, L.cols), rows = Math.max(1, L.rows);
    const cw = L.canvasW / cols, chh = L.ch / rows;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, L.canvasW, L.ch); ctx.clip();
    ctx.fillStyle = "#ffffff"; ctx.fillRect(x0, y0, L.canvasW, L.ch);
    //: 底图（按自身比例 contain，**不拉伸**）
    const img = state.bgImg;
    if (img && img.complete && img.naturalWidth) {
      const s = Math.min(L.canvasW / img.naturalWidth, L.ch / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      try { ctx.drawImage(img, x0 + (L.canvasW - dw) / 2, y0 + (L.ch - dh) / 2, dw, dh); } catch (e) {}
    }
    //: ⭐ 先画格线、**再**画色块 ⇒ 色块上不会被打出 1px 洞（洞会让 mask 出现缝）
    //:   且格线颜色全部 < 127（阈值 0.5×255）⇒ 不会被 MaskFromRGBCMYBW+ 判成 white 那档
    const boldEvery = finiteInt(64 / Math.max(0.5, asFinite(cw, 64)), 1, 1, 10000);   //: 格越细粗线间隔自动放大
    ctx.lineWidth = 1;
    for (let c = 1; c < cols; c++) {
      const x = Math.round(x0 + c * cw) + 0.5;
      ctx.strokeStyle = (c % boldEvery === 0) ? "#3a3a3a" : "#6a6a6a";
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + L.ch); ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      const y = Math.round(y0 + r * chh) + 0.5;
      ctx.strokeStyle = (r % boldEvery === 0) ? "#3a3a3a" : "#6a6a6a";
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + L.canvasW, y); ctx.stroke();
    }
    //: ⭐ 色块半透明（约 0.45）⇒ 能看清底图；**只影响显示**，生成给拆色的图仍由 python 侧画
    ctx.globalAlpha = 0.45;
    for (const k in state.cells) {
      const i = k.indexOf(",");
      const c = +k.slice(0, i), r = +k.slice(i + 1);
      ctx.fillStyle = RGB[state.cells[k]] || "#ffffff";
      ctx.fillRect(x0 + c * cw, y0 + r * chh, Math.ceil(cw), Math.ceil(chh));
    }
    ctx.globalAlpha = 1;
    if (state.hover && !state.painting) {   //: 悬停格提示（画布坐标 → 格）
      const { c, r } = state.hover;
      if (c >= 0 && c < cols && r >= 0 && r < rows) {
        ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 2;
        ctx.strokeRect(x0 + c * cw, y0 + r * chh, Math.ceil(cw), Math.ceil(chh));
      }
    }
    ctx.restore();
  }

  function drawInfo(ctx, L) {
    if (L && L.showInfo === false) return;   //: 高度不够 ⇒ 宁可裁掉状态行，也不溢出行外
    const used = {};
    for (const k in state.cells) used[state.cells[k]] = (used[state.cells[k]] || 0) + 1;
    const parts = Object.keys(used).sort((a, b) => MASKIDX[a] - MASKIDX[b])
      .map((c) => `${c}→mask${MASKIDX[c]}(${used[c]})`).join(" ");
    ctx.save();
    ctx.font = "10px system-ui"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = "#9a9aa5";
    ctx.fillText(`${state.cols}×${state.rows} 格（${cellPx()}px/格）`, 4, L.yInfo + 1);
    //: 提示文案跟着交互改：**点击切换**（右键被 ComfyUI 上下文菜单占了，不再提"右键擦"）
    const line = parts || "还没涂（单击涂 / 再点一下取消，可拖动连涂或连擦，Shift=擦）";
    ctx.fillStyle = parts ? "#cfc" : "#777";
    ctx.fillText(line.length > 88 ? line.slice(0, 87) + "…" : line, 4, L.yInfo + 13);
    if (status2) {   //: 上传等操作的临时状态（只在右侧补一句，不覆盖格数统计）
      const txt = status2.length > 34 ? status2.slice(0, 33) + "…" : status2;
      ctx.fillStyle = "#fc8"; ctx.textAlign = "right";
      ctx.fillText(txt, L.w - 6, L.yInfo + 13);
    }
    ctx.restore();
  }

  /* 真正的绘制入口。两条路径（见文件头注释）：
   *   Vue 模式：y 恒为 1，ctx 来自 WidgetLegacy 的独立 <canvas>。它传的 width 随 zoom
   *     变（boundingRect 视觉宽）⇒ 改用 ctx.canvas.clientWidth（布局宽，zoom 无关），
   *     并把 backing store 钉成 clientWidth×(total+2) —— 否则元素 CSS 高度随 zoom 拉伸，
   *     画布会溢出节点、命中也偏。
   *   经典模式：y = 本行顶边在节点体内的偏移，ctx 只平移到节点左上角
   *     ⇒ 必须自己 translate(0, y)（这版 litegraph 不会替 widget 平移）。
   * ⭐ 第三个调用方（2026-10-14 实测根因）：选中节点后右侧参数面板也会用 WidgetLegacy
   *   画这个 widget（面板宽 ~190px）。WidgetLegacy.draw 会把**视觉宽**写进 widget.width，
   *   而经典 drawWidgets 用 `widget.width || renderingSize[0]` 当行宽 ⇒ 面板画过一次后，
   *   节点体的经典绘制就收到小宽度（画布缩成左上角一小块、下面大片空白）。对策：
   *   - 经典路径：传入宽度比节点窄时以节点宽为准；
   *   - 面板绘制（元素宽明显比节点窄）：照画（面板里留个迷你预览），但**不覆盖**命中布局。 */
  function draw(ctx, n, width, y, drawH) {
    if (!ctx) return 0;
    const isVue = Number.isFinite(y) && y <= 2;
    const el = ctx.canvas;
    const nodeW = Math.round(Number(n && n.size && n.size[0]) || 0);
    let wDraw = finiteInt(width, BASE_W, 160, 8192);
    let hAvail = 0;                       //: 0 = 高度不限（按自然尺寸画）
    let panelDraw = false;
    if (isVue && el) {
      const cw = Math.round(Number(el.clientWidth) || 0);
      const chh = Math.round(Number(el.clientHeight) || 0);
      if (cw >= 160) wDraw = cw;
      else if (nodeW >= 160) wDraw = nodeW;   //: 元素还没排版好时，别用随 zoom 变的视觉宽
      panelDraw = nodeW > 0 && cw >= 160 && cw < nodeW - 40;
      if (chh > 60 && !panelDraw) hAvail = chh;
      const L0 = layout(wDraw, hAvail);
      const bw = Math.round(wDraw * 2), bh = Math.round((L0.total + 2) * 2);   //: scaleFactor=2（同 WidgetLegacy）
      if (el.width !== bw || el.height !== bh) { el.width = bw; el.height = bh; }
      ctx.setTransform(2, 0, 0, 2, 0, 0);   //: 改 width/height 会重置 ctx 状态 ⇒ 每次都重设
    } else if (!isVue && nodeW > wDraw) {
      wDraw = nodeW;   //: widget.width 被面板污染时经典路径会收到小宽度 ⇒ 以节点宽为准
    }
    /* ⭐ 第四坑（2026-10-14 实测）：前端命中判定 `getWidgetOnPos` 里宽度取
     *    `u = widget.width || node.size[0]`。选中节点后右侧参数面板会用 WidgetLegacy 画一次
     *    这个 widget，把**面板的视觉宽**（实测 274.8px）写进 `widget.width`；节点体的经典路径
     *    虽然收到了正确的行宽，`widget.width` 却留在 274.8 ⇒ 命中矩形宽度只有 275px，
     *    画布右半边的点击全部落空（实测表现：点左边第一格能中，点右边一律没反应）。
     *    对策：**经典路径**（行宽 ≥ 节点宽，说明画的就是节点体）把它清成 null，让前端退回节点宽；
     *    面板自己也照常重写一次，面板里的迷你预览不受影响。 */
    if (!isVue && wDraw >= nodeW) { try { widget.width = null; } catch (e) {} }
    const yTop = isVue ? 0 : (Number.isFinite(y) && y >= 0 ? Math.round(y) : 0);
    const L = layout(wDraw, hAvail);
    if (!panelDraw) {   //: 面板的迷你预览不覆盖节点体的命中布局（否则点击全点歪）
      lastDrawnW = L.w;
      lastDrawArgs = { width: L.w, y: yTop, height: drawH, total: L.total, vue: isVue };
      state.layout = L;
    }
    ctx.save();
    ctx.translate(0, yTop);
    ctx.beginPath(); ctx.rect(0, 0, L.w, L.total); ctx.clip();   //: 只在分配给我们的行内绘制
    ctx.fillStyle = "#1e1e22";
    ctx.fillRect(0, 0, L.w, L.total);
    drawGrid(ctx, L);
    drawInfo(ctx, L);
    ctx.restore();
    return L.total;
  }

  /* ── 重绘（派生状态变了就调这个；不碰 node.setSize） ── */
  function repaint() {
    syncGrid();
    //: 行高随宽高比变化时同步给宿主（经典 _arrangeWidgets 和 Vue 的容器高都吃 computedHeight）
    try { widget.computedHeight = contentH(); } catch (e) {}
    //: ⭐ Vue 模式下 widget 是独立 DOM canvas：setDirtyCanvas 碰不到它，必须调
    //:    WidgetLegacy 挂上来的 triggerDraw()。经典模式没有它，靠 setDirtyCanvas。
    if (typeof widget.triggerDraw === "function") { try { widget.triggerDraw(); } catch (e) {} }
    try { node.graph && node.graph.setDirtyCanvas(true, true); } catch (e) {}
    fitNode();   //: 画布变宽后节点必须跟着变宽，否则视觉上被裁掉（幂等，宽度已对时直接返回）
  }

  /* ── 命中所用坐标的最近一次记录（只读诊断） ── */
  let lastHit = null;

  /* ── 命中判断 ──
   * 事件坐标统一由 widget.mouse 换成"行内绘制坐标"（行顶 = 0），这里只信
   * **最近一次真实绘制**的 state.layout（Vue 模式宽度随元素走，缓存别的宽度会点歪）。 */
  //: ⚠️ 必须同步 `last_y`（不是只给 `y`）：本机前端的命中判定 `getWidgetOnPos` 用的是
  //:    `e.last_y`，而这一版 litegraph 只让 `_arrangeWidgets` 写 `e.y`、`drawWidgets` 才写
  //:    `last_y`。实测两者会差 26px 且**永不收敛**（节点定高后 `_arrangeWidgets` 不再跑），
  //:    于是点击落到画布时会按错位的矩形判定 —— 表现就是"涂到上面几行去了"。
  const rowTop = () => {
    const w = find("grid_canvas");
    if (!w) return 0;
    const y = (w.last_y !== undefined && w.last_y !== null) ? w.last_y : w.y;
    return Number.isFinite(y) && y >= 0 ? Math.round(y) : 0;
  };

  function hitCanvas(x, yL) {
    const L = state.layout || layout(widthSource());   //: 还没画过时的兜底
    if (yL < L.yCv || yL > L.yCv + L.ch) return null;
    if (x < L.x0 || x > L.x0 + L.canvasW) return null;
    const c = Math.floor((x - L.x0) / (L.canvasW / state.cols));
    const r = Math.floor((yL - L.yCv) / (L.ch / state.rows));
    if (c < 0 || c >= state.cols || r < 0 || r >= state.rows) return null;
    return { c, r };
  }

  /* ─────────────────── 鼠标处理（入口只有 widget.mouse，见下面注册处） ─────────────────── */
  /* ── 空闲收笔（不依赖 onMouseUp！） ──
   * 实测：up 事件在两条渲染路径上都可能不派发/坐标系不同，
   * 所以"松手才写 regions"不能指望它。改成：
   *   按下 ⇒ 当场涂/擦并**立即提交**（单击永远可用）；
   *   拖动 ⇒ 只重绘 + 节流提交；
   *   连续 220ms 没有新的 move ⇒ 视为收笔 ⇒ 提交一次并结束这一笔。 */
  const IDLE_MS = 220;
  const THROTTLE_MS = 150;
  let idleTimer = null, lastCommit = 0;
  function commitStroke() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!state.painting) return;
    state.painting = false;
    lastCommit = 0;
    try { push(); } catch (e) {}
  }
  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; commitStroke(); }, IDLE_MS);
  }
  function throttleCommit() {
    const now = Date.now();
    if (now - lastCommit >= THROTTLE_MS) {
      lastCommit = now;
      try { setRegionsTextQuiet(toRegions(state.cells, grid().cols, grid().rows)); } catch (e) {}
    }
  }

  function handleMouse(type, x, y, e) {
    lastHit = { type, x, y };
    if (type === "pointerdown" || type === "mousedown") {
      //: 画布区：开始一笔（**此时入栈**，拖动过程中不再入 ⇒ 一次连续拖动 = 一步）
      const p = hitCanvas(x, y);
      if (!p) return false;               //: 点在 widget 上但不是画布 ⇒ 放行
      state.painting = true;
      pushUndo();
      const k = p.c + "," + p.r;
      /* ⭐ 交互（用户 2026-10-13 要求）：**点击切换**，右键在 ComfyUI 里被上下文菜单占了。
       *   - Shift 按住 ⇒ 强制擦除（保留的快捷方式）
       *   - 起始格**已经是当前颜色** ⇒ 整笔擦除；否则整笔涂色
       *   ⇒ 这样既能拖着一片涂，也能从已涂的格开始拖着一片擦，且拖动中模式**不变**（不闪）。 */
      const forceErase = !!e.shiftKey || e.button === 2 || e.which === 3;
      state.erase = forceErase || state.cells[k] === state.active;
      if (state.erase) delete state.cells[k]; else state.cells[k] = state.active;
      //: ⭐ **按下即提交**：单击永远生效，不需要 onMouseUp
      setRegionsTextQuiet(toRegions(state.cells, grid().cols, grid().rows));
      lastCommit = Date.now();
      armIdle();
      repaint();   //: 拖动中**只重绘**；regions 走节流/空闲提交
      return true;
    }

    if (type === "pointermove" || type === "mousemove") {
      if (!state.painting && !hitCanvas(x, y)) return false;   //: 没在画、也不在画布上 ⇒ 放行
      if (state.painting) {
        const p = hitCanvas(x, y);
        if (p) {
          if (state.erase) delete state.cells[p.c + "," + p.r];
          else state.cells[p.c + "," + p.r] = state.active;
          repaint();
          throttleCommit();   //: 拖动中节流写 regions（细格时字符串几千段，别每像素写）
        }
        armIdle();            //: 有新移动 ⇒ 重新计时（空闲 220ms 才算收笔）
      } else {
        const p = hitCanvas(x, y);
        const same = (p && state.hover && p.c === state.hover.c && p.r === state.hover.r) || (!p && !state.hover);
        state.hover = p;
        if (!same) repaint();
      }
      return true;
    }

    if (type === "pointerup" || type === "mouseup" || type === "pointercancel") {
      //: 有 up 就用它作为额外提交点；但**功能不依赖它**（空闲定时器已经保证了）
      if (state.painting) { commitStroke(); return true; }
      return false;
    }

    return false;
  }

  /* ── Ctrl+Z 的监听句柄（提前建，下面 widget.onRemove 要用） ── */
  const abortKeys = new AbortController();
  /* ─────────────────── 注册成 litegraph 原生 canvas widget ─────────────────── */
  /* 关键：type 用前端不认识的字符串（"grid_canvas"）⇒ 落到 LegacyWidget / WidgetLegacy 分支，
   * 也就是**老式 canvas widget**：前端直接调 draw() 与 mouse()。 */
  const widget = {
    type: "grid_canvas",
    name: "grid_canvas",
    value: "",
    //: ⚠️ 不参与任何序列化：regions 才是唯一真源，画布状态由 regions 解码
    serialize: false,
    serializeValue: () => undefined,
    draw,
    /* ⭐ 唯一的鼠标入口（2026-10-14 实测根因）：点击落在 widget 区域时，两种模式都只会调
     * widget.mouse() —— node.onMouseDown 在经典模式是"没命中 widget"的 else 分支、
     * Vue 模式（Comfy Desktop 默认开）整条节点级回调不派发。 */
    mouse: (e, pos) => {
      if (!e || !pos) return false;
      const t = e.target;
      const main = app.canvas && app.canvas.canvas;
      const isVueEvt = !!(t && t.tagName === "CANVAS" && t !== main && t.clientWidth > 0);
      let hx, hy;
      if (isVueEvt) {
        //: Vue 模式：pos = widget 元素局部 CSS 像素（元素随 zoom 有拉伸 ⇒ 换回绘制坐标）
        const L = state.layout;
        if (!L) return false;
        if (t.clientWidth < L.w - 40) return false;   //: 侧边参数面板的迷你画布只看，不涂
        const fx = L.w / t.clientWidth, fy = L.total / (t.clientHeight || L.total);
        hx = pos[0] * fx; hy = pos[1] * fy;
      } else {
        //: 经典模式：pos = 节点体坐标 ⇒ 减行顶成行内坐标
        hx = pos[0]; hy = pos[1] - rowTop();
      }
      return handleMouse(e.type, hx, hy, e);
    },
    //: ⭐ 声明尺寸 == 自然画布尺寸 ⇒ `_arrangeWidgets` 用 `computeSize()[1]` 当**行高**，
    //:    节点高就自动是"所有行累计"，不用我们 setSize 猜；fitNode() 只收宽度。
    computeSize: () => {
      const n = naturalCanvas();
      return [Math.max(MIN_W, n.canvasW + 12), 2 + n.ch + ROW_GAP + INFO_H + 2];
    },
    onRemove: () => { try { abortKeys.abort(); } catch (e) {} },
  };
  /* ═══ 原生控件 widget ═══
   * 全部 `serialize:false` —— 它们**绝不能**进 widgets_values（唯一真源仍是
   * width/height/cell/regions/show_grid/background_file），否则又会造出"按位置错位 ⇒ NaN"。
   * 顺序：原生 widget 先加、画布 widget 最后加 ⇒ 画布那一行天然在所有输入行下面。 */

  //: ① 画笔颜色（combo，值域就是固定顺序）
  node.addWidget("combo", "paint_color", state.active, (v) => {
    state.active = COLORS.includes(v) ? v : "red";
    repaint();
  }, { values: COLORS.slice(), serialize: false });

  //: ② 宽高预设（combo）—— 选它只**写现有的 width/height**，不新增尺寸 widget
  const refreshAspect = () => {
    const w = Math.round(W("width", DEFAULT_W)), h = Math.round(W("height", DEFAULT_H));
    const hitA = ASPECTS.find(([, a, b]) => a === w && b === h);
    const aw = find("aspect");
    if (aw) aw.value = hitA ? hitA[0] : "自定义";
  };
  node.addWidget("combo", "aspect", "16:9", (v) => {
    const a = ASPECTS.find(([l]) => l === v);
    if (a) applySize(a[1], a[2]);      //: 只改 width/height 两个现有 widget
    refreshAspect();
  }, { values: ASPECTS.map(([l]) => l).concat(["自定义"]), serialize: false });

  //: ③ 上传底图（button + 隐藏 input）
  node.addWidget("button", "上传底图", "upload", () => { pickAndUpload(); }, { serialize: false });
  //: ④ 撤销 / 清空 / regions 文本
  node.addWidget("button", "撤销", "undo", () => { undo(); }, { serialize: false });
  node.addWidget("button", "清空", "clear", () => { pushUndo(); state.cells = {}; push(); }, { serialize: false });
  node.addWidget("button", "regions文本", "edit_regions", () => { editRegions(); }, { serialize: false });

  //: ⚠️ 保险：无论 store 怎么写，这些控件**一律不进 widgets_values**
  for (const nm of ["paint_color", "aspect", "上传底图", "撤销", "清空", "regions文本"]) {
    const cw2 = find(nm);
    if (cw2) { try { cw2.serialize = false; } catch (e) {} try { if (cw2.options) cw2.options.serialize = false; } catch (e) {} }
  }

  /* ── ⭐ 让命中矩形坐标对"y 被清零"免疫（2026-10-14 实测第三个坑） ──
   * 本机前端的命中判定 `getWidgetOnPos` 只认 `widget.last_y`，而这个值会在节点被选中后
   * 被某条绘制路径写成 0（实测：点第一下 `last_y=290` 命中正常，之后 `y`/`last_y` 变 0，
   * 于是**第二次点击开始全部点不动** —— 只有第一下生效）。
   * 这里给 `last_y` 装一层守卫：拒绝 ≤0 的写入（那是"行内坐标"而不是"节点体坐标"），
   * 只接受真正的节点体内位置。这样命中矩形始终落在画布上，不管 y 怎么被清零。 */
  let liveLastY = 0;
  try {
    Object.defineProperty(widget, "last_y", {
      configurable: true, enumerable: true,
      get() { return liveLastY; },
      set(v) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return;      //: 拒绝"行内坐标"式清零
        liveLastY = n;
      },
    });
  } catch (e) { /* 不支持就算了，只是命中可能偏 */ }

  node.addCustomWidget(widget);   //: ⭐ 画布**最后**加 ⇒ 排在所有输入行下面

  /* ── 外部改动同步：包 width/height/cell/background_file 的 callback ──
   * ⭐ Vue 模式下 onDrawForeground 不会被调（drawNode 提前 return），这是**唯一**可靠通道；
   *    经典模式下它与 onDrawForeground 的 sig 同步并存（remap 幂等，不会双重变形）。 */
  function onExternalGeometry() {
    const from = { cols: state.cols, rows: state.rows };
    syncGrid();
    refreshAspect();
    fitNode();   //: 宽高/cell 变了 ⇒ 节点边界重新贴内容
    if (from.cols !== state.cols || from.rows !== state.rows) {
      //: 尺寸/档位被外部改了 ⇒ 老格子按比例整块保留
      state.cells = remapCells(from, { cols: state.cols, rows: state.rows });
      push();
    } else {
      repaint();
    }
  }
  const wrapCb = (name, fn) => {
    const w = find(name); if (!w) return;
    const orig = w.callback;
    w.callback = function () {
      try { orig && orig.apply(this, arguments); } catch (e) {}
      try { fn(w.value); } catch (e) {}
    };
  };
  wrapCb("width", onExternalGeometry);
  wrapCb("height", onExternalGeometry);
  wrapCb("cell", onExternalGeometry);
  wrapCb("background_file", (v) => { loadBg(String(v || "").trim(), true); });

  //: litegraph 的 `_arrangeWidgets` 正是用 `computeSize()[1]` 写 computedHeight，
  //: Vue 的 WidgetLegacy 也优先读它 ⇒ 先给一个初始值。
  widget.computedHeight = contentH();

  /* ── regions 文本框：**必须真正从节点 UI 里藏掉** ──
   * 坑（实测踩到）：只把 computeSize 压成 [0,-4] 不够 —— 那个 <textarea> 仍然占着
   * 节点 widget 网格里的一行、并且**盖在画布上**（浏览器 elementFromPoint 命中的就是它），
   * 于是画布上每一次点击都被 textarea 吃掉 ⇒ 表现就是"完全点不动"。
   * 这里改成 hidden（不渲染、不占位），值仍在 widget 里、仍参与序列化；
   * 想手改 regions 用画布上的「regions文本」按钮（弹窗编辑器）。
   * ⚠️ **绝对不要把它从 node.widgets 里 splice 掉** —— 那样会改变序列化顺序，
   *    老工作流的 regions 值会错位。 */
  const rw = find("regions");
  if (rw) {
    rw.computeSize = () => [0, -4];
    rw.hidden = true;
  }

  /* ── Ctrl+Z（一次连续拖动算一步） ── */
  window.addEventListener("keydown", (e) => {
    if (!((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "z")) return;
    let sel = null;
    try { sel = app.canvas && app.canvas.selected_nodes; } catch (err) { return; }
    if (!sel || !sel[node.id]) return;      //: 只在选中这个节点时吃 Ctrl+Z，别抢别人的
    e.preventDefault(); e.stopPropagation();
    undo();
  }, { capture: true, signal: abortKeys.signal });

  /* ── ⚠️ 兜底：松手可能落在 widget 之外（拖出节点、松在标题栏…），
   *    那样我们的 mouse() 收不到 up ⇒ 这一笔永远不提交 regions（用户看到"画了但没生效"）。
   *    这里在 window 上监听一次松手，只负责"把这一笔收尾"，不参与绘制。 ── */
  const finishStroke = () => {
    if (!state.painting) return;
    state.painting = false;
    try { push(); } catch (e) {}
  };
  window.addEventListener("pointerup", finishStroke, { signal: abortKeys.signal });
  window.addEventListener("mouseup", finishStroke, { signal: abortKeys.signal });

  /* ── ⚠️ onResize 里**绝对不许** setSize（onResize→setSize→onResize 会无限递归，
   *    实测导致工作流加载不上）。这里只重绘。 ── */
  widget.onResize = () => { try { repaint(); } catch (e) {} };
  node.onResize = function () { try { repaint(); } catch (e) {} };

  /* ── 外部改动同步（经典模式的兜底：onDrawForeground 每帧做廉价签名比对） ── */
  //: ⚠️ 性能：regions 在细格时是几千字符，**不能每帧 String()**。
  //:    这里只做"引用不同就加个变化标记"的廉价判断（ComfyUI 的 STORE 换值必然换引用），
  //:    真正解析文本的 pull() 只在签名真的变了时才跑。
  let lastSig = "", regionsSeen = null, regionsDirty = false;
  const sig = () => [W("width", DEFAULT_W), W("height", DEFAULT_H), W("cell", DEFAULT_CELL),
                     String(W("background_file", "") || ""), regionsDirty].join("|");
  const oldFg = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    if (oldFg) { try { oldFg.call(this, ctx); } catch (e) {} }
    try {
      const rwNow = find("regions");
      const rv = rwNow ? rwNow.value : null;
      if (rv !== regionsSeen) { regionsSeen = rv; regionsDirty = true; }
      const s = sig();
      if (s !== lastSig) {
        lastSig = s;
        regionsDirty = false;
        const before = { cols: state.cols, rows: state.rows };
        syncGrid();
        refreshAspect();
        if (before.cols !== state.cols || before.rows !== state.rows) {
          //: 尺寸/档位被外部改了 ⇒ 老格子按比例整块保留
          state.cells = remapCells(before, { cols: state.cols, rows: state.rows });
          push();
          return;
        }
        const nm = String(W("background_file", "") || "");
        if (nm && (!state.bgImg || state.bgImg.src.indexOf(encodeURIComponent(nm)) < 0)) loadBg(nm);
        pull();
        repaint();
      }
    } catch (e) { /* 同步出错不能让整张图渲染挂掉 */ }
  };

  /* ── 节点边界贴内容（2026-10-14 用户反馈"2048 固定节点太大"）：
   * 宽度：必须**至少**装得下自然画布；用户手动拖得更宽时保留他的宽度（空白在行内居中）。
   * 高度：必须**至少**装得下"所有 widget 行的累计高"。本来 `_arrangeWidgets` 会做这件事，
   *      但它只在节点被 setSize/重排时跑；改宽高/cell/底图之后画布行变高、节点却不跟着长
   *      ⇒ 画布下面那截落在**节点体之外**，于是"点第二下开始就点不动了"（实测：一次会话里
   *      只有第一下生效，因为第一下靠的是节点体外的绘制，第二下 hit test 直接判定没命中）。
   *      所以这里自己把高度也算准并 setSize，让它重新走一遍 _arrangeWidgets。
   * 公式：表头偏移（= 画布行 y 减去它前面各行的累计高）+ 各行累计高 + 底部余量。
   * ⚠️ 绝不在 onResize 里调它（onResize→setSize→onResize 无限递归，实测搞挂过工作流加载）。 ── */
  function fitNode() {
    try {
      const n = naturalCanvas();
      const wantW = Math.max(MIN_W, n.canvasW + 12);
      const cw = find("grid_canvas");
      const vis = (node.widgets || []).filter((w) => !w.hidden);
      let sum = 0, before = 0, seen = false;
      for (const w of vis) {
        if (w === cw) { before = sum; seen = true; }
        sum += (typeof w.computedHeight === "number" ? w.computedHeight : 20);
      }
      let wantH = 0;
      if (seen && cw) {
        const startY = (Number.isFinite(cw.y) && cw.y > sum - before) ? (cw.y - before) : 26;
        wantH = Math.round(startY + sum + 4);
      }
      if (!(wantH > 200)) wantH = Math.round(n.ch + 380);          //: 还没排过版 ⇒ 粗估兜底
      const curW = Math.round(Number(node.size && node.size[0]) || 0);
      const curH = Math.round(Number(node.size && node.size[1]) || 0);
      if (curW >= wantW && curH >= wantH) return;                  //: 已经装得下 ⇒ 不动（幂等）
      node.setSize([Math.max(curW, wantW), Math.max(curH, wantH)]);
    } catch (e) {}
  }

  /* 画布行**应得**的行高（不读 node.size —— 那正是滞后回环的来源）。
   * 只作调试/诊断用；真正的行高由 widget.computeSize()[1] 声明、_arrangeWidgets 落位。 */
  function rowHeight() {
    const n = naturalCanvas();
    return 2 + n.ch + ROW_GAP + INFO_H + 2;
  }

  //: 只读调试出口：给自动化验收核对"声明的行高 == 实际绘制总高"
  try {
    window.__GRID_LAYOUT__ = () => {
      const nat = naturalCanvas();
      return {
        build: GRID_BUILD,
        computeSize: widget.computeSize(),
        natural: { cols: nat.cols, rows: nat.rows, cell: nat.cell, canvasW: nat.canvasW, ch: nat.ch },
        rowHeight: rowHeight(),
        layoutKeys: state.layout ? Object.keys(state.layout) : null,
        hasX0: !!(state.layout && Number.isFinite(state.layout.x0)),
        lastHit,
        rowTopNow: rowTop(),
        layout: state.layout ? { x0: state.layout.x0, cols: state.layout.cols, rows: state.layout.rows, cell: state.layout.cell,
                                  yCv: state.layout.yCv, total: state.layout.total, ch: state.layout.ch,
                                  canvasW: state.layout.canvasW, showInfo: state.layout.showInfo } : null,
        drawArgs: lastDrawArgs,
        nodeSize: node.size,
        widgetRow: (() => { const w = find("grid_canvas"); return w ? { y: w.y, last_y: w.last_y, computedHeight: w.computedHeight } : null; })(),
      };
    };
  } catch (e) {}

  /* ── 让**本节点**的 computeSize() 也报"自然宽" ──
   * ⚠️ litegraph 的 `LGraphNode.computeSize()` 只把 widget 的高度加起来，宽度一律用
   *    node.size[0]（或 DEFAULT_WIDTH / MIN_WIDTH）—— 所以它**永远不会**把节点收窄。
   *    实测后果：上传底图换成竖图后，节点宽度停在旧值上（用户看到的"边界不对/留白"）。
   *    这里把它包一层，让 ComfyUI 自己也用我们的自然尺寸：
   *      · "适应内容 / 载入工作流 / 右键 Resize" 都会走 computeSize()；
   *      · 宽度取 `max(node.size[0], 自然宽)` ⇒ **只会变宽不会变窄**，
   *        所以手动画宽的节点不会被我们收走（那正是 `expandToFitContent` 的语义）。
   *    ⚠️ 绝不能无条件返回自然宽 —— 那会跟拖拽改宽打架（用户拖宽后立刻被改回）。 */
  const origComputeSize = node.computeSize;
  node.computeSize = function (out) {
    const base = origComputeSize ? origComputeSize.call(this, out) : [0, 0];
    try {
      const n = naturalCanvas();
      const w = Math.max(Math.round(Number(this.size && this.size[0]) || 0), MIN_W, n.canvasW + 12);
      return [w, Math.max(Number(base && base[1]) || 0, 2 + n.ch + ROW_GAP + INFO_H + 2)];
    } catch (e) { return base; }
  };

  /* ── 工作流载入后的同步（nodeCreated 跑在 configure 之前，存的值那时才落下来） ──
   * 由 beforeRegisterNodeDef 里包的 onConfigure 在配置完成后调用。 */
  node.__gridRefresh = () => {
    try {
      healNumericWidgets();
      syncGrid();
      refreshAspect();
      const nm = String(W("background_file", "") || "");
      if (nm) loadBg(nm);
      state.cells = cellsFromText(getRegionsText(), state.cols, state.rows);
      lastPushedText = getRegionsText();
      repaint();
    } catch (e) {}
  };
  node.__gridFit = () => { try { fitNode(); } catch (e) {} };

  /* ── 初始化 ── */
  //: ⚠️ 顺序很重要：**先自愈坏值**，再算几何/画第一次。
  //:    实测老工作流里 width="自定义"、cell=1536 这种坏值，若不自愈，
  //:    NaN 会一路传到 computeSize()，画布整块画不出来。
  healNumericWidgets();
  syncGrid();
  //: 节点边界贴内容（老工作流存的 2048 固定尺寸/坏尺寸都在这儿被收编）；
  //: 工作流载入时 onConfigure 钩子会按载入值再贴一次。
  fitNode();
  //: 排版后 widget.y 才有效 ⇒ 补两次延迟贴合，把高度也收准（幂等）
  setTimeout(() => { try { fitNode(); } catch (e) {} }, 0);
  setTimeout(() => { try { fitNode(); } catch (e) {} }, 200);
  const nm0 = String(W("background_file", "") || "");
  if (nm0) loadBg(nm0);
  state.cells = cellsFromText(getRegionsText(), state.cols, state.rows);
  lastPushedText = getRegionsText();
  refreshAspect();
  repaint();

  return widget;
}

/* ───────────────────────── 注册（整个套 try/catch） ───────────────────────── */

app.registerExtension({
  name: "grid.mask.editor.node",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "GridMaskEditor") return;
    try {
      /* ⚠️ 时机坑（实测）：`nodeCreated` 跑在 `onConfigure` **之前**，
       * 那时 widget 还是默认值，读不到老工作流存进来的坏值 —— 所以自愈不能只放在 nodeCreated。
       * 这里挂一个 onConfigure 前置钩子，在 ComfyUI 把老值灌下去**之前**先修正。 */
      const orig = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        try { repairLegacyWidgets(nodeData, info, this); } catch (e) {}
        const r = orig ? orig.apply(this, arguments) : undefined;
        //: 老工作流里存的 size 会在 onConfigure 里覆盖掉当前值，所以配置完成后
        //: 再按载入的宽高/cell 把节点边界贴回内容（用 setTimeout 避开本次配置流程，
        //: 且**不是**在 onResize 里 setSize，不会递归）。顺带做载入后的画布同步
        //: （__gridRefresh/__gridFit 由 nodeCreated 里的 buildGridCanvasWidget 挂上）。
        try {
          const self = this;
          setTimeout(() => {
            try {
              if (self && typeof self.__gridFit === "function") self.__gridFit();
              if (self && typeof self.__gridRefresh === "function") self.__gridRefresh();
              self && self.graph && self.graph.setDirtyCanvas(true, true);
            } catch (e) {}
          }, 0);
        } catch (e) {}
        return r;
      };
    } catch (e) {
      console.warn("[grid_node_widget] onConfigure 钩子挂载失败（不影响加载）:", e && e.message);
    }
  },
  async nodeCreated(node) {
    if (node.comfyClass !== "GridMaskEditor") return;
    try {
      buildGridCanvasWidget(node);
    } catch (err) {
      //: ⭐ 我们的 widget 出错**绝不允许**拖垮工作流加载 —— 只记日志。
      //:    即使画布挂了，节点照常可用：regions/width/height 这些文本 widget 都还在。
      console.error("[grid_node_widget] 初始化失败（不影响加载）:", err);
      window.__GRID_TOOL_WHY__ = "node-widget-error: " + (err && err.message);
    }
  },
});
