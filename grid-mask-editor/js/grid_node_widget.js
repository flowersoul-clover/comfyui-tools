/* GridMaskEditor 画布 widget —— v3：**litegraph 原生 canvas widget**（照 PainterNode 的机制）
 * ============================================================================
 * 为什么从 `addDOMWidget` + `<canvas>` 改成现在这样（都是实测踩过的坑）：
 *
 * ① **画不了 / 拖不动**：DOM widget 的 `<div>/<canvas>` 浮在节点上层，但它的指针事件
 *    最终要经 ComfyUI 前端的 `DomWidgets` 覆盖层转发；而节点拖动是 litegraph 在
 *    graph canvas 上直接处理的。两套事件源打架，于是"按下 = 拖节点"，画布收不到稳定的
 *    down/move/up。原生 canvas widget 则由 litegraph **直接**把 canvas 坐标里的鼠标事件
 *    派发给 widget 的 `mouse(event, pos, node)`（见 LGraphCanvas.processWidgetClick），
 *    没有中间层，所以 PainterNode 那种画布一直是顺的。
 * ② **大小不定**：DOM widget 的高度依赖 `computeSize` 与节点尺寸互相影响；而原生
 *    widget 的高度由 litegraph 的 `_arrangeWidgets()` 用 `w.computeSize()` 算出来后
 *    写进 `w.computedHeight`，节点的 bodyHeight 再据此增长 —— 单向因果，不抖。
 *    ⇒ 本文件给 `computeSize` 返回**固定值**（不含传入 width），只按画布内容比例算。
 * ③ **无限递归**：以前在 `onResize` 里调 `setSize()` ⇒ onResize→setSize→onResize…
 *    工作流直接加载不上。⇒ 现在 `onResize` **只做重绘**，绝不 setSize。
 *
 * ⚠️ 机制细节（读的是本机前端 comfyui-frontend-package==1.53.10 的实际代码）：
 *    - `node.addWidget(type, ...)` 的类型不认识时（如 "grid_canvas"），前端会走
 *      `instantiateConcreteWidget` 的 default 分支 → `LegacyWidget`，这就是**老式
 *      canvas widget**：`draw(ctx, node, width, y, height)` + `mouse(event, pos, node)`。
 *    - Vue 语境（vueNodesMode）下它被渲染成 `WidgetLegacy` 组件，签名同样是
 *      `s.draw?.(ctx, node, width, 1, height)`，鼠标走 `s.mouse?.(e, [e.offsetX, e.offsetY], node)`。
 *    - `LegacyWidget.drawWidget()` 里 `this.draw?.(ctx, node, width, this.y, NODE_WIDGET_HEIGHT, showText)`
 *      ⇒ **draw 的第 5 个参数（height）在两条路径下含义不同**，所以本实现只信
 *      width，自己用内容比例算高度（见 LAYOUT），避免被那条 20px 的路径带歪。
 *
 * 功能一个都没少：颜色（与 MaskFromRGBCMYBW+ 固定顺序）、网格分辨率档位（粗选→细化、
 * 已画格子按比例保留）、撤销（一次拖动=一步，栈深 100）、宽高预设、上传底图（按底图
 * 实际尺寸、不拉伸）、半透明显示+格线在下、regions 双向同步、拖动只重绘松手才写文本、
 * 状态行。详细注释见下面各段。
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

//: 网格分辨率档位（像素/格）—— 注意这是**网格变细**，不是画笔变粗
const STEPS = [256, 128, 64, 32, 16, 8];
const DEFAULT_CELL = 128;

//: 宽高预设 —— 与 Pipe 的 ASPECTS **逐字一致**（nodes.py 里已经没有 aspect 输入了，
//: 所以这里只改 width/height 两个 widget 的值）
const ASPECTS = [["16:9", 1344, 768], ["3:2", 1216, 832], ["4:3", 1152, 896],
                 ["1:1", 1024, 1024], ["3:4", 896, 1152], ["2:3", 832, 1216],
                 ["9:16", 768, 1344]];

//: 画布逻辑宽度（不随节点宽度变 ⇒ 不抖）；高度按内容比例算
const BASE_W = 560;
const SWATCH_H = 18;      //: 色板行
const RES_H = 18;         //: 分辨率 + 宽高预设行
const BTN_H = 18;         //: 功能按钮行
const ROW_GAP = 2;
const INFO_H = 26;        //: 状态行（两行小字）
const MAX_CANVAS_H = 420; //: 画布高度上限（竖图时别把节点撑到天上去）

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

/* ─────────────────────────── 渲染小工具 ─────────────────────────── */

function lighten(hex, k) {   //: 把色板按钮调亮一点，好画选中白框
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.min(255, Math.round(v + (255 - v) * k));
  const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
  return `rgb(${r},${g},${b})`;
}

//: 画一个圆角按钮，返回点击矩形 {x,y,w,h}
function button(ctx, x, y, w, h, label, opt = {}) {
  const { active = false, bg = "#34343c", fg = "#ddd", font = "10px system-ui" } = opt;
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 4); else ctx.rect(x, y, w, h);
  ctx.fillStyle = bg; ctx.fill();
  ctx.lineWidth = active ? 2 : 1;
  ctx.strokeStyle = active ? "#ffffff" : "#55555f";
  ctx.stroke();
  ctx.fillStyle = fg; ctx.font = font;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
  return { x, y, w, h };
}

const hit = (r, x, y) => !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/* ───────────────────── 单个 GridMaskEditor 节点的画布 ───────────────────── */

function buildGridCanvasWidget(node) {
  /* ── widget 取值/写值：与 nodes.py 的 width / height / cell / background_file / regions 打通 ── */
  const find = (k) => (node.widgets || []).find((w) => w.name === k);
  const W = (k, d) => { const w = find(k); return w && w.value != null && w.value !== "" ? Number(w.value) : d; };
  const setWidget = (k, v) => {
    const w = find(k); if (!w) return;
    w.value = v;
    try { w.callback && w.callback(v); } catch (e) { /* 回调是别人的，出错不能拖垮我们 */ }
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
    hits: { swatch: {}, res: [], aspect: [], actions: {} },
    ctx: null,
  };

  /* ── 网格几何：cols/rows 由 width/height/cell 决定（下面多处要用，先定义） ── */
  function grid() {
    const w = W("width", 1216), h = W("height", 704);
    const cell = Math.max(4, W("cell", DEFAULT_CELL));
    return {
      cols: Math.max(1, Math.round(w / cell)),
      rows: Math.max(1, Math.round(h / cell)),
    };
  }
  const syncGrid = () => { const g = grid(); state.cols = g.cols; state.rows = g.rows; };
  const cellPx = () => Math.max(4, W("cell", DEFAULT_CELL));
  //: 画布高度按宽高比，但有上限（竖图别把节点撑爆）
  const canvasH = () => {
    const c = grid();
    return Math.max(48, Math.min(MAX_CANVAS_H, Math.round(BASE_W * c.rows / c.cols)));
  };
  const contentH = () => SWATCH_H + RES_H + BTN_H + canvasH() + INFO_H + ROW_GAP * 4 + 6;

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
    state.cells = remapCells(from, { cols: state.cols, rows: state.rows });   //: 换尺寸不丢画
    push();
  }

  //: 点更细的档位：只改 cell widget，然后把已有格子按比例铺到更细的网格上
  function refineTo(px) {
    const from = { cols: state.cols, rows: state.rows };
    setWidget("cell", px);
    syncGrid();
    state.cells = remapCells(from, { cols: state.cols, rows: state.rows });
    push();
  }

  /* ── 底图 ── */
  const loadBg = (name) => {
    if (!name) { state.bgImg = null; return; }
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

  function layout(width) {
    const w = Math.max(160, Math.round(width || BASE_W));
    const ch = canvasH();
    const top = 2;
    const ySwatch = top;
    const yRes = ySwatch + SWATCH_H + ROW_GAP;
    const yBtn = yRes + RES_H + ROW_GAP;
    const yCv = yBtn + BTN_H + ROW_GAP;
    const yInfo = yCv + ch + ROW_GAP;
    return { w, ch, ySwatch, yRes, yBtn, yCv, yInfo,
             canvasW: w - 4, total: yInfo + INFO_H + 4 };
  }

  function drawPalette(ctx, L) {
    const pad = 2, sw = 46, gap = 3, h = SWATCH_H - 4;
    state.hits.swatch = {};
    let x = pad;
    for (const c of COLORS) {
      const r = button(ctx, x, L.ySwatch + 2, sw, h, c, {
        active: c === state.active, bg: RGB[c],
        fg: (c === "black" || c === "blue" || c === "magenta") ? "#fff" : "#000",
        font: "9px system-ui",
      });
      state.hits.swatch[c] = r;
      x += sw + gap;
    }
  }

  function drawResAndAspect(ctx, L) {
    const pad = 2, h = RES_H - 4;
    let x = pad;
    state.hits.res = [];
    for (const px of STEPS) {   //: 网格分辨率档位
      const r = button(ctx, x, L.yRes + 2, 36, h, px + "px", { active: px === cellPx() });
      state.hits.res.push({ px, rect: r });
      x += 36 + 3;
    }
    state.hits.aspect = [];
    for (const [lab, w, hh] of ASPECTS) {   //: 宽高预设（只改 width/height）
      const active = Math.round(W("width", 1216)) === w && Math.round(W("height", 704)) === hh;
      const r = button(ctx, x, L.yRes + 2, 34, h, lab, { active });
      state.hits.aspect.push({ w, h: hh, rect: r });
      x += 34 + 3;
    }
  }

  function drawActions(ctx, L) {
    const pad = 2, h = BTN_H - 4, y = L.yBtn + 2;
    state.hits.actions = {};
    let x = pad;
    state.hits.actions.upload = button(ctx, x, y, 58, h, "上传底图"); x += 58 + 3;
    state.hits.actions.undo = button(ctx, x, y, 40, h, "撤销", { active: undoStack.length > 0 }); x += 40 + 3;
    state.hits.actions.clear = button(ctx, x, y, 40, h, "清空"); x += 40 + 3;
    state.hits.actions.regions = button(ctx, x, y, 66, h, "regions文本");
    const dim = `${Math.round(W("width", 1216))}×${Math.round(W("height", 704))}`;
    ctx.save();
    ctx.font = "10px system-ui"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#8cf";
    ctx.fillText(dim, L.w - 6, y + h / 2);
    ctx.restore();
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
    const boldEvery = Math.max(1, Math.round(64 / Math.max(1, cw)));   //: 格越细粗线间隔自动放大
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
    const used = {};
    for (const k in state.cells) used[state.cells[k]] = (used[state.cells[k]] || 0) + 1;
    const parts = Object.keys(used).sort((a, b) => MASKIDX[a] - MASKIDX[b])
      .map((c) => `${c}→mask${MASKIDX[c]}(${used[c]})`).join(" ");
    ctx.save();
    ctx.font = "10px system-ui"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = "#9a9aa5";
    ctx.fillText(`${state.cols}×${state.rows} 格（${cellPx()}px/格）`, 4, L.yInfo + 1);
    const line = parts || "还没涂（左键涂 / 右键或 Shift 擦 / 上面按钮可把网格调细）";
    ctx.fillStyle = parts ? "#cfc" : "#777";
    ctx.fillText(line.length > 88 ? line.slice(0, 87) + "…" : line, 4, L.yInfo + 13);
    if (status2) {   //: 上传等操作的临时状态（只在右侧补一句，不覆盖格数统计）
      const txt = status2.length > 34 ? status2.slice(0, 33) + "…" : status2;
      ctx.fillStyle = "#fc8"; ctx.textAlign = "right";
      ctx.fillText(txt, L.w - 6, L.yInfo + 13);
    }
    ctx.restore();
  }

  //: 真正的绘制入口。两条调用路径（见文件头注释）只共享 width 是可信的。
  function draw(ctx, n, width) {
    if (!ctx) return 0;
    const L = layout(width);
    L.w = Math.max(160, Math.round(width || BASE_W));
    L.canvasW = L.w - 4;
    state.layout = L;
    state.ctx = ctx;
    ctx.save();
    ctx.fillStyle = "#1e1e22";
    ctx.fillRect(0, 0, L.w, L.total);
    drawPalette(ctx, L);
    drawResAndAspect(ctx, L);
    drawActions(ctx, L);
    drawGrid(ctx, L);
    drawInfo(ctx, L);
    ctx.restore();
    return L.total;
  }

  /* ── 重绘（派生状态变了就调这个；不碰 node.setSize） ── */
  function repaint() {
    syncGrid();
    const L = state.layout || layout(BASE_W);
    try { draw(state.ctx, node, L.w); } catch (e) { /* 绘制出错绝不冒泡 */ }
    //: 高度随宽高比变化时同步给 litegraph（命中测试 getWidgetOnPos 用 computedHeight）
    try { widget.computedHeight = contentH(); } catch (e) {}
    try { node.graph && node.graph.setDirtyCanvas(true, true); } catch (e) {}
  }

  /* ── 画布坐标 → 格 ── */
  function cellAt(x, y) {
    ensureLayout();
    const L = state.layout; if (!L) return null;
    if (y < L.yCv || y > L.yCv + L.ch || x < 2 || x > L.canvasW + 2) return null;
    const c = Math.floor((x - 2) / (L.canvasW / state.cols));
    const r = Math.floor((y - L.yCv) / (L.ch / state.rows));
    if (c < 0 || c >= state.cols || r < 0 || r >= state.rows) return null;
    return { c, r };
  }

  //: ⚠️ 实测踩到：**页面刚加载、还没触发过一次 draw 时 layout 是 null**，
  //:    此时点画布会静默无反应（用户看到的就是"点不动"）。所以鼠标入口必须能自算布局。
  function ensureLayout() {
    if (state.layout) return state.layout;
    const L = layout(BASE_W);
    state.layout = L;
    return L;
  }

  /* ─────────────────── 鼠标事件（litegraph 直接派发给 widget） ─────────────────── */
  /* PainterNode 的机制：widget.mouse(event, pos, node)；
   * down 时 `pos` 是节点内相对坐标，拖拽时是 `[e.offsetX, e.offsetY]`。 */
  function mouse(e, pos, n) {
    const x = pos ? pos[0] : (e.offsetX || 0);
    const y = pos ? pos[1] : (e.offsetY || 0);
    ensureLayout();
    const L = state.layout;
    if (!L) return;
    const type = e.type;

    if (type === "pointerdown" || type === "mousedown") {
      //: 顶部按钮区
      for (const c in state.hits.swatch)
        if (hit(state.hits.swatch[c], x, y)) { state.active = c; repaint(); return; }
      for (const it of state.hits.res)
        if (hit(it.rect, x, y)) { refineTo(it.px); return; }
      for (const it of state.hits.aspect)
        if (hit(it.rect, x, y)) { applySize(it.w, it.h); return; }
      const A = state.hits.actions;
      if (hit(A.upload, x, y)) { pickAndUpload(); return; }
      if (hit(A.undo, x, y)) { undo(); return; }
      if (hit(A.clear, x, y)) { pushUndo(); state.cells = {}; push(); return; }
      if (hit(A.regions, x, y)) { editRegions(); return; }
      //: 画布区：开始一笔（**此时入栈**，拖动过程中不再入 ⇒ 一次连续拖动 = 一步）
      const p = cellAt(x, y);
      if (p) {
        state.painting = true;
        pushUndo();
        state.erase = (e.button === 2) || !!e.shiftKey || (e.buttons & 2) === 2;
        const k = p.c + "," + p.r;
        if (state.erase) delete state.cells[k]; else state.cells[k] = state.active;
        repaint();   //: 拖动中**只重绘**，松手才写 regions（细格时字符串几千段）
      }
      return;
    }

    if (type === "pointermove" || type === "mousemove") {
      if (state.painting) {
        const p = cellAt(x, y);
        if (p) {
          const erase = state.erase;
          if (erase) delete state.cells[p.c + "," + p.r];
          else state.cells[p.c + "," + p.r] = state.active;
          repaint();
        }
      } else {
        const p = cellAt(x, y);
        const same = (p && state.hover && p.c === state.hover.c && p.r === state.hover.r) || (!p && !state.hover);
        state.hover = p;
        if (!same) repaint();
      }
      return;
    }

    if (type === "pointerup" || type === "mouseup" || type === "pointercancel") {
      if (state.painting) {
        state.painting = false;
        push();      //: 松手才写 regions
      }
      return;
    }

    if (type === "dblclick") { return; }
  }

  /* ── Ctrl+Z 的监听句柄（提前建，下面 widget.onRemove 要用） ── */
  const abortKeys = new AbortController();
  /* ─────────────────── 注册成 litegraph 原生 canvas widget ─────────────────── */
  /* 关键：type 用前端不认识的字符串（"grid_canvas"）⇒ 落到 LegacyWidget 分支，
   * 也就是**老式 canvas widget**：litegraph 直接派发鼠标给 `mouse()`。 */
  const widget = {
    type: "grid_canvas",
    name: "grid_canvas",
    value: "",
    //: ⚠️ 不参与任何序列化：regions 才是唯一真源，画布状态由 regions 解码
    serialize: false,
    serializeValue: () => undefined,
    draw,
    mouse,
    //: ⚠️ 固定值、**不依赖传入的 width**（依赖 width ⇒ 节点一变宽就重算高度 ⇒ 抖动/大小不定）
    computeSize: () => [BASE_W, contentH()],
    onRemove: () => { try { abortKeys.abort(); } catch (e) {} },
  };
  node.addCustomWidget(widget);
  //: litegraph 的 `_arrangeWidgets` 正是用 `computeSize()[1]` 写 computedHeight，
  //: 命中测试 `getWidgetOnPos` 用的也是 computedHeight ⇒ 先给一个初始值。
  widget.computedHeight = contentH();
  try { widget.serialize = false; } catch (e) {}

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

  /* ── 外部改动同步（手改 regions / 改 width·height·cell widget 都要反映到画布） ── */
  //: ⚠️ 性能：regions 在细格时是几千字符，**不能每帧 String()**。
  //:    这里只做"引用不同就加个变化标记"的廉价判断（ComfyUI 的 STORE 换值必然换引用），
  //:    真正解析文本的 pull() 只在签名真的变了时才跑。
  let lastSig = "", regionsSeen = null, regionsDirty = false;
  const sig = () => [W("width", 1216), W("height", 704), W("cell", DEFAULT_CELL),
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

  /* ── 初始化 ── */
  syncGrid();
  const nm0 = String(W("background_file", "") || "");
  if (nm0) loadBg(nm0);
  state.cells = cellsFromText(getRegionsText(), state.cols, state.rows);
  lastPushedText = getRegionsText();
  repaint();

  return widget;
}

/* ───────────────────────── 注册（整个套 try/catch） ───────────────────────── */

app.registerExtension({
  name: "grid.mask.editor.node",
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
