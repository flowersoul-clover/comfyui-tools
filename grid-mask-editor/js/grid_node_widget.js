/* GridMaskEditor 画布 widget（2026-10-13 · v2）
 * 目标：网格工具真正住进 ComfyUI —— 鼠标画格子，自动写回 `regions`（"颜色 列起 行起 列止 行止"）。
 * ⭐ v2 的两处修正（用户指出）：
 *   ① **按钮控制的是"网格分辨率"（cell 像素），不是画笔粗细** —— 网格本身变细，用来**细化边缘**；
 *      点更细的档位时，**已画的格子按比例保留**（粗选 → 细化，不丢）。
 *   ② 画布上的色块**半透明显示**（能看清底图）；但生成给 `MaskFromRGBCMYBW+` 的那张图仍是
 *      **硬边不透明纯色**（透明度只是"显示"，绝不影响拆色）。
 * 交互：左键/拖动 = 涂 · 右键或 Shift = 擦 · 色板换色 · [上传底图] · [清空]
 */
import { app } from "/scripts/app.js";

const COLORS = ["red", "green", "blue", "cyan", "magenta", "yellow", "black", "white"];
const RGB = {
  red: "#ff0000", green: "#00ff00", blue: "#0000ff", cyan: "#00ffff",
  magenta: "#ff00ff", yellow: "#ffff00", black: "#000000", white: "#ffffff",
};
const MASKIDX = {}; COLORS.forEach((c, i) => (MASKIDX[c] = i));
const STEPS = [256, 128, 64, 32, 16, 8];   //: 网格分辨率档位（像素/格）—— "128 差不多"（用户 2026-10-13）
//: 宽高预设 —— 与 Pipe 的 ASPECTS / 节点的 ASPECTS **逐字一致**
const ASPECTS = [["16:9",1344,768],["3:2",1216,832],["4:3",1152,896],["1:1",1024,1024],
                 ["3:4",896,1152],["2:3",832,1216],["9:16",768,1344]];

const W = (n, k, d) => { const w = (n.widgets || []).find((x) => x.name === k); return w ? Number(w.value) : d; };
const getText = (n) => { const w = (n.widgets || []).find((x) => x.name === "regions"); return w ? String(w.value || "") : ""; };
const setText = (n, v) => { const w = (n.widgets || []).find((x) => x.name === "regions"); if (w) { w.value = v; if (w.callback) try { w.callback(v); } catch (e) {} } };
const setWidget = (n, k, v) => { const w = (n.widgets || []).find((x) => x.name === k); if (w) { w.value = v; if (w.callback) try { w.callback(v); } catch (e) {} } };

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

app.registerExtension({
  name: "grid.mask.editor.node",
  async nodeCreated(node) {
    if (node.comfyClass !== "GridMaskEditor") return;
    try {

    const box = document.createElement("div");
    //: 仿 PainterNode：**画布占满节点**，控制条只占一行
    box.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:4px;background:#1e1e22;border-radius:6px;width:100%;box-sizing:border-box";
    const palette = document.createElement("div");
    palette.style.cssText = "display:flex;gap:4px;align-items:center;flex-wrap:wrap";
    const info = document.createElement("div");
    info.style.cssText = "font:11px system-ui;color:#aaa";
    const cv = document.createElement("canvas");
    cv.width = 560; cv.height = 320;
    cv.style.cssText = "display:block;width:100%;height:auto;background:#fff;border-radius:4px;cursor:crosshair;image-rendering:pixelated;touch-action:none";
    //: ⭐ 把指针事件**截在画布里**，别让它冒泡给 litegraph（否则按下 = 拖节点，画不了）
    ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu"].forEach((t) =>
      cv.addEventListener(t, (e) => { e.stopPropagation(); }, true));
    box.append(palette, cv, info);

    let active = "red";
    let cells = {};
    let bgImg = null;
    //: ⭐ 撤销：**一次连续拖动算一步**（pointerdown 时入栈，拖动过程中不再入栈）
    const undoStack = [];
    const pushUndo = () => { undoStack.push(JSON.stringify(cells)); if (undoStack.length > 100) undoStack.shift(); };
    const undo = () => { if (!undoStack.length) return; cells = JSON.parse(undoStack.pop()); push(); };

    //: 色板
    const swatches = {};
    COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.textContent = c;
      b.style.cssText = "font:10px system-ui;padding:1px 5px;border-radius:4px;cursor:pointer;" +
        `border:2px solid ${c === active ? "#fff" : "#444"};background:${RGB[c]};` +
        `color:${c === "black" || c === "blue" || c === "magenta" ? "#fff" : "#000"}`;
      b.onclick = () => { active = c; for (const k in swatches) swatches[k].style.borderColor = k === active ? "#fff" : "#444"; };
      swatches[c] = b; palette.append(b);
    });
    const sep = document.createElement("span");
    sep.style.cssText = "width:1px;height:16px;background:#555;margin:0 2px";
    palette.append(sep);
    //: ⭐ 网格分辨率（**网格变细**，不是画笔变粗）—— 已画的格子按比例保留
    const resBtns = {};
    STEPS.forEach((px) => {
      const b = document.createElement("button");
      b.textContent = px + "px";
      b.style.cssText = "font:10px system-ui;padding:1px 5px;border-radius:4px;cursor:pointer;" +
        `border:2px solid ${W(node, "cell", 64) == px ? "#fff" : "#444"};background:#333;color:#ddd`;
      b.onclick = () => refineTo(px);
      b.dataset.px = String(px); resBtns[px] = b; palette.append(b);
    });
    //: ⭐ 宽高预设（老办法：16:9 → 1:1 → 9:16）—— 也是**网格细化之外最常调的参数**
    const aspBtns = {};
    const aspRow = document.createElement("div");
    aspRow.style.cssText = "display:flex;gap:4px;align-items:center;flex-wrap:wrap";
    ASPECTS.forEach(([lab, w, h]) => {
      const b = document.createElement("button");
      b.textContent = lab;
      b.style.cssText = "font:10px system-ui;padding:1px 5px;border-radius:4px;cursor:pointer;background:#333;color:#ddd;border:2px solid #444";
      b.onclick = () => setSize(w, h);
      aspBtns[lab] = b; aspRow.append(b);
    });
    const wInfo = document.createElement("span");
    wInfo.style.cssText = "font:10px system-ui;color:#8cf;margin-left:4px";
    aspRow.append(wInfo);
    box.insertBefore(aspRow, cv);
    const up = document.createElement("input");
    up.type = "file"; up.accept = "image/*"; up.style.display = "none";
    const upBtn = document.createElement("button");
    upBtn.textContent = "上传底图";
    upBtn.style.cssText = "font:10px system-ui;padding:1px 6px;border-radius:4px;cursor:pointer";
    upBtn.onclick = () => up.click();
    up.onchange = async () => {
      const f = up.files && up.files[0]; if (!f) return;
      const fd = new FormData(); fd.append("image", f); fd.append("overwrite", "true");
      try {
        const j = await (await fetch("/upload/image", { method: "POST", body: fd })).json();
        const nm = j.name || "";
        setWidget(node, "background_file", nm);
        bgImg = new Image(); bgImg.src = "/view?filename=" + encodeURIComponent(nm) + "&type=input";
        bgImg.onload = () => { setSize(bgImg.naturalWidth, bgImg.naturalHeight, true); draw(); };   //: ⭐ 按底图尺寸，不拉伸
      } catch (e) { info.textContent = "上传失败：" + e.message; }
    };
    palette.append(upBtn);
    const undoBtn = document.createElement("button");
    undoBtn.textContent = "撤销";
    undoBtn.title = "撤销上一笔（一次连续拖动算一步）· Ctrl+Z";
    undoBtn.style.cssText = "font:10px system-ui;padding:1px 6px;border-radius:4px;cursor:pointer";
    undoBtn.onclick = undo;
    palette.append(undoBtn);
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    });
    const clr = document.createElement("button");
    clr.textContent = "清空";
    clr.style.cssText = "font:10px system-ui;padding:1px 6px;border-radius:4px;cursor:pointer;margin-left:auto";
    clr.onclick = () => { pushUndo(); cells = {}; push(); };
    palette.append(clr);

    function setSize(w, h, fromBg) {
      const from = grid();
      const to = { cols: Math.max(1, Math.round(w / Math.max(4, W(node, "cell", 64)))),
                   rows: Math.max(1, Math.round(h / Math.max(4, W(node, "cell", 64)))) };
      const nc = {};                                   //: 已画的格子按比例整块搬过去（换尺寸不丢）
      for (const k in cells) {
        const [c, r] = k.split(",").map(Number);
        const c0 = Math.round(c * to.cols / from.cols), c1 = Math.max(c0 + 1, Math.round((c + 1) * to.cols / from.cols));
        const r0 = Math.round(r * to.rows / from.rows), r1 = Math.max(r0 + 1, Math.round((r + 1) * to.rows / from.rows));
        for (let cc = c0; cc < c1; cc++) for (let rr = r0; rr < r1; rr++) nc[cc + "," + rr] = cells[k];
      }
      cells = nc;
      setWidget(node, "width", Math.round(w)); setWidget(node, "height", Math.round(h));
      setWidget(node, "aspect", fromBg ? "自定义" : (ASPECTS.find(([l, a, b]) => a === Math.round(w) && b === Math.round(h)) || ["自定义"])[0]);
      for (const k in aspBtns) aspBtns[k].style.borderColor =
        (ASPECTS.find(([l]) => l === k) || [])[1] === Math.round(w) && (ASPECTS.find(([l]) => l === k) || [])[2] === Math.round(h) ? "#fff" : "#444";
      wInfo.textContent = Math.round(w) + "×" + Math.round(h) + (fromBg ? "（按底图）" : "");
      push();
    }

    function grid() {
      const w = W(node, "width", 1216), h = W(node, "height", 704), cell = Math.max(4, W(node, "cell", 64));
      return { cols: Math.max(1, Math.round(w / cell)), rows: Math.max(1, Math.round(h / cell)) };
    }
    function refineTo(px) {
      const from = grid();
      const to = { cols: Math.max(1, Math.round(W(node, "width", 1216) / px)), rows: Math.max(1, Math.round(W(node, "height", 704) / px)) };
      const nc = {};                                   //: 老格子 → 新格子的整块（按比例铺满，粗选不丢）
      for (const k in cells) {
        const [c, r] = k.split(",").map(Number);
        const c0 = Math.round(c * to.cols / from.cols), c1 = Math.max(c0 + 1, Math.round((c + 1) * to.cols / from.cols));
        const r0 = Math.round(r * to.rows / from.rows), r1 = Math.max(r0 + 1, Math.round((r + 1) * to.rows / from.rows));
        for (let cc = c0; cc < c1; cc++) for (let rr = r0; rr < r1; rr++) nc[cc + "," + rr] = cells[k];
      }
      cells = nc;
      setWidget(node, "cell", px);
      for (const k in resBtns) resBtns[k].style.borderColor = resBtns[k].dataset.px == String(px) ? "#fff" : "#444";
      push();
    }
    function draw() {
      const { cols, rows } = grid();
      const wantW = 560, wantH = Math.max(80, Math.round(wantW * rows / cols));   //: ⭐ 画布比例跟着尺寸 ⇒ **永不拉伸**
      if (cv.width !== wantW || cv.height !== wantH) { cv.width = wantW; cv.height = wantH; }
      const ctx = cv.getContext("2d");
      ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      if (bgImg && bgImg.complete) { try { ctx.drawImage(bgImg, 0, 0, cv.width, cv.height); } catch (e) {} }
      const cw = cv.width / cols, ch = cv.height / rows;
      //: ⭐ 甲-C：**先画格线、再画色块** ⇒ 色块上不会被打出 1px 洞（洞会让 mask 出现缝）
      //:   且格线颜色都 < 127（阈值 0.5*255）⇒ 不会被判成 white 那一档
      const bold = cv.width / cols < 12 ? 8 : 4;
      for (let c = 1; c < cols; c++) {
        ctx.strokeStyle = (c % bold === 0) ? "#4a4a4a" : "#7a7a7a"; ctx.lineWidth = (c % bold === 0) ? 1.2 : 1;
        ctx.beginPath(); ctx.moveTo(c * cw, 0); ctx.lineTo(c * cw, cv.height); ctx.stroke();
      }
      for (let r = 1; r < rows; r++) {
        ctx.strokeStyle = (r % bold === 0) ? "#4a4a4a" : "#7a7a7a"; ctx.lineWidth = (r % bold === 0) ? 1.2 : 1;
        ctx.beginPath(); ctx.moveTo(0, r * ch); ctx.lineTo(cv.width, r * ch); ctx.stroke();
      }
      ctx.globalAlpha = 0.45;                          //: 半透明 ⇒ 能看清底图（**只影响显示**）
      for (const k in cells) {
        const [c, r] = k.split(",").map(Number);
        ctx.fillStyle = RGB[cells[k]] || "#fff";
        ctx.fillRect(c * cw, r * ch, Math.ceil(cw), Math.ceil(ch));
      }
      ctx.globalAlpha = 1;
      const used = {}; for (const k in cells) used[cells[k]] = (used[cells[k]] || 0) + 1;
      info.textContent = `${cols}×${rows} 格（${W(node, "cell", 64)}px/格）· ` + (Object.keys(used).length
        ? Object.keys(used).sort((a, b) => MASKIDX[a] - MASKIDX[b]).map((c) => `${c}→mask${MASKIDX[c]}(${used[c]})`).join(" ")
        : "还没涂（左键涂 / 右键擦 / 点右上按钮把网格调细）");
    }
    function push() { setText(node, toRegions(cells, grid().cols, grid().rows)); draw(); }
    function pull() {
      const g = grid();
      const c = cellsFromText(getText(node), g.cols, g.rows);
      if (JSON.stringify(c) !== JSON.stringify(cells)) { cells = c; draw(); }
    }
    function at(ev) {
      const { cols, rows } = grid();
      const rc = cv.getBoundingClientRect();
      const c = Math.floor(((ev.clientX - rc.left) / rc.width) * cols);
      const r = Math.floor(((ev.clientY - rc.top) / rc.height) * rows);
      return (c >= 0 && c < cols && r >= 0 && r < rows) ? { c, r } : null;
    }
    let painting = false;
    const paint = (ev, erase) => {
      const p = at(ev); if (!p) return;
      const k = p.c + "," + p.r;
      if (erase) delete cells[k]; else cells[k] = active;
      draw();                                          //: 甲-E：拖动中**只重绘**，松手才写 regions（细格时字符串很长）
    };
    cv.oncontextmenu = (e) => e.preventDefault();
    cv.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); painting = true; pushUndo();
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      paint(e, e.button === 2 || e.shiftKey); };
    cv.onpointermove = (e) => { if (painting) { e.preventDefault(); paint(e, e.button === 2 || e.shiftKey); } };
    cv.onpointerup = () => { if (painting) { painting = false; push(); } };
    window.addEventListener("pointerup", () => { if (painting) { painting = false; push(); } });

    const domW = node.addDOMWidget("grid_paint", "div", box, { serialize: false, hideOnZoom: false });
    //: widget 高度跟着画面比例 + 控制条 ⇒ 节点自动给画面留够地方（不用手动拖）
    //: ⚠️ **必须与传入的 width 无关**（否则节点一变宽就重算高度 ⇒ 抖动、"大小不定"，实测踩到）
    const FIXED_W = 560;
    domW.computeSize = () => {
      const g = grid();
      return [FIXED_W, Math.round(FIXED_W * g.rows / g.cols) + 104];
    };
    const rw = (node.widgets || []).find((x) => x.name === "regions");   //: 折叠长文本框（值还在，只是不占地方）
    if (rw) { rw.computeSize = () => [0, -4]; rw.hidden = true; }
    //: 只在**创建时**定一次尺寸（之后随便用户拖），避免和 computeSize 互相打架
    if (!node.size || node.size[0] < 520 || node.size[1] < 700) {
      node.size = [FIXED_W, Math.round(FIXED_W * grid().rows / grid().cols) + 150];
    }
    //: ⚠️ 这里**绝对不能再调 setSize** —— onResize → setSize → onResize 会无限递归，导致工作流加载不上（实测踩到）
    node.onResize = function () { try { draw(); } catch (e) {} };
    cells = cellsFromText(getText(node), grid().cols, grid().rows);
    wInfo.textContent = W(node, "width", 1216) + "×" + W(node, "height", 704);
    if (W(node, "background_file", "")) {
      const nm = String(W(node, "background_file", ""));
      bgImg = new Image(); bgImg.src = "/view?filename=" + encodeURIComponent(nm) + "&type=input"; bgImg.onload = draw;
    }
    draw();
    const oldDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
      if (oldDraw) try { oldDraw.call(this, ctx); } catch (e) {}
      if (!painting) try { pull(); } catch (e) {}
    };
    } catch (err) {
      //: 我们的 widget 出错**绝不允许**拖垮工作流加载 —— 只记日志，节点照常可用（regions 文本仍能编辑）
      console.error("[grid_node_widget] 初始化失败（不影响加载）:", err);
      window.__GRID_TOOL_WHY__ = "node-widget-error: " + (err && err.message);
    }
  },
});
