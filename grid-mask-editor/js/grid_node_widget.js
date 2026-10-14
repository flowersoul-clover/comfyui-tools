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
const MAX_CANVAS_H = 1600; //: 画布高度上限（节点已固定 2048 高 ⇒ 放开，让画布随可用高度长）

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
  function grid() {
    const w = W("width", DEFAULT_W), h = W("height", DEFAULT_H);
    const cell = W("cell", DEFAULT_CELL);
    return {
      cols: finiteInt(w / cell, DEFAULT_W / DEFAULT_CELL, 1, 8192),   //: 除法会带 NaN 进来
      rows: finiteInt(h / cell, DEFAULT_H / DEFAULT_CELL, 1, 8192),
    };
  }
  const syncGrid = () => { const g = grid(); state.cols = g.cols; state.rows = g.rows; };
  const cellPx = () => finiteInt(W("cell", DEFAULT_CELL), DEFAULT_CELL, 4, 4096);
  //: 画布高度按宽高比（窄节点的兜底值；实际高度取"剩余空间"，见 layout）
  const canvasH = () => {
    const c = grid();
    return finiteInt(BASE_W * c.rows / c.cols, BASE_W * DEFAULT_H / DEFAULT_W, 48, MAX_CANVAS_H);
  };
  //: ⚠️ computeSize()/Vue 的容器高 直接吃这个 ⇒ 必须保证是有限正整数
  const contentH = () => {
    try {
      const L = layout(widthSource());
      return finiteInt(L.total, 64, 64, 16384);
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
  }

  /* ── 底图 ── */
  const loadBg = (name) => {
    if (!name) { state.bgImg = null; repaint(); return; }
    const img = new Image();
    img.onload = () => { state.bgImg = img; repaint(); };
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
  function layout(width) {
    const w = finiteInt(width, BASE_W, 160, 8192);
    //: 画布高度：剩下的空间都给画布（节点 2048 高 ⇒ 画布随高度长）
    const room = Math.max(64, canvasRoomH() - 2 - INFO_H - ROW_GAP);
    const ch = finiteInt(Math.max(canvasH(), room), 200, 48, MAX_CANVAS_H);
    const yCv = 2;                                   //: **行内**坐标（行顶 = 0）
    const yInfo = yCv + ch + ROW_GAP;
    return {
      w, ch, canvasW: Math.max(80, w - 4), yCv, yInfo, showInfo: true,
      total: yInfo + INFO_H + 2,
    };
  }

  function drawGrid(ctx, L) {
    const { cols, rows } = state;
    const x0 = 2, y0 = L.yCv;
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
   *     ⇒ 必须自己 translate(0, y)（这版 litegraph 不会替 widget 平移）。 */
  function draw(ctx, n, width, y, drawH) {
    if (!ctx) return 0;
    const isVue = Number.isFinite(y) && y <= 2;
    const el = ctx.canvas;
    let wDraw = finiteInt(width, BASE_W, 160, 8192);
    if (isVue && el) {
      const cw = Math.round(Number(el.clientWidth) || 0);
      if (cw >= 160) wDraw = cw;
      const L0 = layout(wDraw);
      const bw = Math.round(wDraw * 2), bh = Math.round((L0.total + 2) * 2);   //: scaleFactor=2（同 WidgetLegacy）
      if (el.width !== bw || el.height !== bh) { el.width = bw; el.height = bh; }
      ctx.setTransform(2, 0, 0, 2, 0, 0);   //: 改 width/height 会重置 ctx 状态 ⇒ 每次都重设
    }
    const yTop = isVue ? 0 : (Number.isFinite(y) && y >= 0 ? Math.round(y) : 0);
    const L = layout(wDraw);
    lastDrawnW = L.w;
    lastDrawArgs = { width: L.w, y: yTop, height: drawH, total: L.total, vue: isVue };
    state.layout = L;
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
  }

  /* ── 命中判断 ──
   * 事件坐标统一由 widget.mouse 换成"行内绘制坐标"（行顶 = 0），这里只信
   * **最近一次真实绘制**的 state.layout（Vue 模式宽度随元素走，缓存别的宽度会点歪）。 */
  function rowTop() {
    const w = find("grid_canvas");
    if (!w) return 0;
    const y = (w.last_y !== undefined && w.last_y !== null) ? w.last_y : w.y;
    return Number.isFinite(y) && y >= 0 ? Math.round(y) : 0;
  }

  function hitCanvas(x, yL) {
    const L = state.layout || layout(widthSource());   //: 还没画过时的兜底
    if (yL < L.yCv || yL > L.yCv + L.ch) return null;
    if (x < 2 || x > L.canvasW + 2) return null;
    const c = Math.floor((x - 2) / (L.canvasW / state.cols));
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
        //: Vue 模式：pos = widget 元素局部 CSS 像素（元素随 zoom 拉伸 ⇒ 换回绘制坐标）
        const L = state.layout;
        if (!L) return false;
        const fx = L.w / t.clientWidth, fy = L.total / (t.clientHeight || L.total);
        hx = pos[0] * fx; hy = pos[1] * fy;
      } else {
        //: 经典模式：pos = 节点体坐标 ⇒ 减行顶成行内坐标
        hx = pos[0]; hy = pos[1] - rowTop();
      }
      return handleMouse(e.type, hx, hy, e);
    },
    //: ⭐ 声明高度 == 这一行**实际绘制**的总高（同一份 layout() 算出来的，不再二次夹取）
    computeSize: () => {
      const w = widthSource();
      return [w, layout(w).total];
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

  node.addCustomWidget(widget);   //: ⭐ 画布**最后**加 ⇒ 排在所有输入行下面

  /* ── 外部改动同步：包 width/height/cell/background_file 的 callback ──
   * ⭐ Vue 模式下 onDrawForeground 不会被调（drawNode 提前 return），这是**唯一**可靠通道；
   *    经典模式下它与 onDrawForeground 的 sig 同步并存（remap 幂等，不会双重变形）。 */
  function onExternalGeometry() {
    const from = { cols: state.cols, rows: state.rows };
    syncGrid();
    refreshAspect();
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
  wrapCb("background_file", (v) => { loadBg(String(v || "").trim()); });

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

  /* ── 高度兜底：节点体高不够就**一次性**调够（⚠️ 绝不在 onResize 里 setSize） ── */
  /* ⭐ 用户要求：节点在屏幕上的像素尺寸**精确 2048×2048**（创建时一次设定）。 */
  const NODE_W_FIXED = 2048, NODE_H_FIXED = 2048;
  function ensureNodeTallEnough() {
    try { node.size = [NODE_W_FIXED, NODE_H_FIXED]; } catch (e) {}
  }

  /* 画布高度取"节点高 − 前面那些原生行占的高"的剩余值（宁可略小，**不把节点撑大**） */
  function canvasRoomH() {
    try {
      const bh = Number(node.size && node.size[1]);
      const w = find("grid_canvas");
      const wy = Number.isFinite(w && w.y) ? Math.round(w.y) : 0;
      if (Number.isFinite(bh) && bh > 0) return Math.max(48, Math.round(bh) - wy - 4);
    } catch (e) {}
    return MAX_CANVAS_H;
  }

  //: 只读调试出口：给自动化验收核对"声明的行高 == 实际绘制总高"
  try {
    window.__GRID_LAYOUT__ = () => ({
      computeSize: widget.computeSize(),
      layout: state.layout ? { yCv: state.layout.yCv, total: state.layout.total, ch: state.layout.ch, showInfo: state.layout.showInfo } : null,
      drawArgs: lastDrawArgs,
      nodeSize: node.size,
    });
  } catch (e) {}

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

  /* ── 初始化 ── */
  //: ⚠️ 顺序很重要：**先自愈坏值**，再算几何/画第一次。
  //:    实测老工作流里 width="自定义"、cell=1536 这种坏值，若不自愈，
  //:    NaN 会一路传到 computeSize()，画布整块画不出来。
  healNumericWidgets();
  syncGrid();
  ensureNodeTallEnough();   //: 高度兜底：不够就一次性调够（不在 onResize 里调）
  //: 节点尺寸兜底：老工作流里可能是 [560, null]（NaN 被 JSON 成了 null），
  //: null 尺寸会让 litegraph 的布局出 NaN。只在明显不合法时才动。
  if (!Array.isArray(node.size) || !Number.isFinite(node.size[0]) || !Number.isFinite(node.size[1])
      || node.size[0] < 200 || node.size[1] < 200) {
    node.size = [NODE_W_FIXED, NODE_H_FIXED];
  }
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
        //: ⭐ 用户要求节点**精确 2048×2048**：老工作流里存的 size 会在 onConfigure 里覆盖掉
        //:    创建时设的值，所以配置完成后**再钉一次**（用 setTimeout 避开本次配置流程，
        //:    且**不是**在 onResize 里 setSize，不会递归）。顺带做载入后的画布同步
        //:    （__gridRefresh 由 nodeCreated 里的 buildGridCanvasWidget 挂上）。
        try {
          const self = this;
          setTimeout(() => {
            try {
              if (self && self.size && (self.size[0] !== 2048 || self.size[1] !== 2048)) {
                self.setSize([2048, 2048]);
                self.graph && self.graph.setDirtyCanvas(true, true);
              }
              if (self && typeof self.__gridRefresh === "function") self.__gridRefresh();
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
