// services/plannings/pdflayout.js
//
// Reconstrucción de la maquetación de un PDF como contenido editable de Word
// (ver pdfconv.js para la extracción). Entrada: PDF. Salida: grupos de páginas
// con bloques (párrafos, tablas, imágenes) y utilidades para escribirlos en
// el XML del planning.

const X = require("./pdfconv");
const { esc, run, para } = require("./ooxml");

const TW = 20; // twips por punto
const BULLET_RE = /^\s*([•▪◦●○■□➢✓❖\-–—*·]|\d{1,3}[.)]|[a-zA-Z]\))\s*/;

// ───────────────────────── líneas ─────────────────────────

function sameStyle(a, b) {
  return a.family === b.family && a.size === b.size && a.bold === b.bold && a.italic === b.italic && a.color === b.color && !!a.underline === !!b.underline;
}

/** Elementos de texto → líneas (ordenadas de arriba a abajo) con runs fusionados */
function buildLines(texts) {
  // quita duplicados exactos (negrita simulada pintando dos veces)
  const seen = new Set();
  const items = [];
  for (const t of texts) {
    const k = `${t.str}|${Math.round(t.x * 2)}|${Math.round(t.y * 2)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(t);
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.y - last.y) <= 0.4 * Math.max(it.size, last.size)) {
      last.items.push(it);
      last.size = Math.max(last.size, it.size);
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
    } else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  const lines = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    const runs = [];
    let prev = null;
    for (const it of r.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        const endsSp = /\s$/.test(prev.str), startsSp = /^\s/.test(it.str);
        if (gap > 2.4 * Math.max(prev.size, it.size) && it.str.trim()) runs.push({ tab: true, x: it.x });
        else if (gap > 0.2 * it.size && !endsSp && !startsSp) runs.push({ text: " ", ref: prev });
      }
      const st = { family: it.family, size: Math.round(it.size * 2) / 2, bold: it.bold, italic: it.italic, color: it.color, underline: it.underline };
      const lastRun = runs[runs.length - 1];
      if (lastRun && !lastRun.tab && lastRun.text !== undefined && lastRun.family && sameStyle(lastRun, st)) lastRun.text += it.str;
      else if (lastRun && lastRun.ref && !lastRun.family && it.str === " ") continue;
      else runs.push({ ...st, text: it.str, x0: it.x });
      prev = it;
    }
    // los espacios sueltos entre runs heredan el formato del run anterior
    const clean = [];
    for (const r2 of runs) {
      if (r2.ref && !r2.family) {
        const p = clean[clean.length - 1];
        if (p && p.text !== undefined) p.text += " ";
        continue;
      }
      clean.push(r2);
    }
    // espacios duplicados (justificado) → uno solo
    let prevSp = false;
    for (let i = clean.length - 1; i >= 0; i--) if (clean[i].tab) { clean[i].keep = true; }
    const compact = [];
    for (const c of clean) {
      if (c.tab) { compact.push(c); prevSp = true; continue; }
      let t = c.text.replace(/ {2,}/g, " ");
      if (prevSp && t.startsWith(" ")) t = t.slice(1);
      if (!t) continue;
      prevSp = t.endsWith(" ");
      compact.push({ ...c, text: t });
    }
    clean.length = 0;
    compact.forEach((c) => clean.push(c));
    const textual = clean.filter((c) => !c.tab);
    const text = textual.map((c) => c.text).join("");
    if (!text.trim()) continue;
    const x = r.items[0].x;
    const right = Math.max(...r.items.map((i) => i.x + i.w));
    const size = Math.max(...r.items.map((i) => i.size));
    lines.push({ y: r.y, x, right, size, runs: clean, text });
  }
  return lines;
}

// ───────────────────────── párrafos ─────────────────────────

function bulletInfo(line) {
  const first = line.runs.find((r) => !r.tab);
  if (!first) return null;
  const m = BULLET_RE.exec(first.text);
  if (!m || !m[1]) return null;
  const tok = m[1];
  // solo viñetas claras: símbolo, número con punto o letra con paréntesis seguidos de texto
  if (/^[a-zA-Z]\)$/.test(tok) || /^\d{1,3}[.)]$/.test(tok)) {
    if (!/^\s*\S+\s+\S/.test(first.text) && line.runs.length < 2) return null;
  }
  return { token: tok, rest: first.text.slice(m[0].length), len: m[0].length };
}

/** Líneas → párrafos. ctx: {left,right} del área de texto en pt */
function buildParagraphs(lines, ctx) {
  const paras = [];
  let P = null;
  const width = Math.max(50, ctx.right - ctx.left);
  for (const ln of lines) {
    const b = bulletInfo(ln);
    let join = false;
    if (P) {
      const L = P.lines[P.lines.length - 1];
      const gap = ln.y - L.y;
      const full = L.right >= ctx.right - Math.max(0.14 * width, 3 * L.size);
      const okGap = gap > 0.7 * L.size && gap <= 1.65 * L.size;
      const contX = P.lines.length === 1 ? null : P.cont;
      let okX;
      if (P.bullet) okX = Math.abs(ln.x - P.textStart) < 7 || (P.lines.length > 1 && Math.abs(ln.x - P.cont) < 7);
      else if (contX !== null) okX = Math.abs(ln.x - contX) < 5;
      else okX = Math.abs(ln.x - P.first) < 5 || (ln.x < P.first - 4 && P.first - ln.x < 40) || (ln.x > P.first + 4 && ln.x - P.first < 40 && P.lines.length === 1 && false);
      const hasTab = L.runs.some((r) => r.tab);
      join = okGap && okX && full && !b && !hasTab && Math.abs(ln.size - L.size) < 1.2;
    }
    if (join) {
      P.lines.push(ln);
      if (P.lines.length === 2 && !P.bullet) P.cont = ln.x;
      if (P.bullet && P.lines.length === 2) P.cont = ln.x;
    } else {
      const prevLast = P ? P.lines[P.lines.length - 1] : null;
      P = { lines: [ln], first: ln.x, cont: ln.x, bullet: !!b, textStart: ln.x, bulletInfo: b, gapBefore: prevLast ? ln.y - prevLast.y : null, prevSize: prevLast ? prevLast.size : null };
      if (b) {
        // la viñeta suele ser un elemento aparte: el texto empieza en el siguiente run
        const textual = ln.runs.filter((r) => !r.tab);
        P.textStart = textual.length > 1 && !b.rest.trim() ? textual[1].x0 || ln.x + 14 : ln.x + Math.max(10, ln.size * 1.1);
      }
      paras.push(P);
    }
  }
  return paras;
}

function paraXml(P, ctx, opts = {}) {
  const lines = P.lines;
  const first = lines[0];
  const size = Math.max(...lines.map((l) => l.size));
  // alineación
  let align = null;
  const center = (ctx.left + ctx.right) / 2;
  const widthCtx = ctx.right - ctx.left;
  const lc = (first.x + first.right) / 2;
  if (lines.length === 1 && !P.bullet && Math.abs(lc - center) < 6 && first.x - ctx.left > 0.1 * widthCtx && ctx.right - first.right > 0.1 * widthCtx) align = "center";
  else if (lines.length === 1 && !P.bullet && Math.abs(first.right - ctx.right) < 3 && first.x - ctx.left > 0.35 * widthCtx) align = "right";
  else if (lines.length > 2 && !P.bullet) {
    // justificado: todas las líneas menos la última llegan al borde derecho
    const inner = lines.slice(0, -1);
    if (inner.every((l) => Math.abs(l.right - ctx.right) < 3.5) && inner.length >= 2) align = "both";
  }
  // sangrías
  const left = Math.max(0, (P.bullet ? P.textStart : P.lines.length > 1 ? P.cont : P.first) - ctx.left);
  let ind = "";
  if (P.bullet) {
    const hang = Math.max(0, P.textStart - P.first);
    ind = `<w:ind w:left="${Math.round(Math.max(left, hang) * TW)}" w:hanging="${Math.round(hang * TW)}"/>`;
  } else if (P.lines.length > 1 && Math.abs(P.first - P.cont) > 2) {
    const d = (P.first - P.cont) * TW;
    ind = `<w:ind w:left="${Math.round(Math.max(0, P.cont - ctx.left) * TW)}" ${d >= 0 ? `w:firstLine="${Math.round(d)}"` : `w:hanging="${Math.round(-d)}"`}/>`;
  } else if (left > 1 && !align) ind = `<w:ind w:left="${Math.round(left * TW)}"/>`;

  // interlínea: de los saltos reales entre líneas del párrafo
  let lineSp = 240;
  if (lines.length > 1) {
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
    const good = gaps.filter((x) => x > 0.8 * size && x < 2.3 * size);
    const g = good.length ? X.median(good) : size * 1.15;
    lineSp = Math.max(200, Math.min(520, Math.round((g / (size * 1.15)) * 240)));
  }
  // espacio anterior: lo que sobra entre líneas base respecto a una interlínea normal
  let before = 0;
  if (P.gapBefore != null) before = Math.max(0, Math.min(900, Math.round((P.gapBefore - 1.15 * first.size * (lineSp / 240)) * TW)));
  else if (opts.firstGap) before = Math.min(600, Math.round(opts.firstGap * TW));
  const tabsSet = new Map();
  let xml = "";
  lines.forEach((ln, li) => {
    if (li > 0) {
      const prevTxt = lines[li - 1].runs.filter((r) => !r.tab).map((r) => r.text).join("");
      if (!/[-­]$/.test(prevTxt)) xml += run(" ", { size: ln.size });
    }
    let skip = 0;
    if (li === 0 && P.bullet) skip = P.bulletInfo.len;
    for (const r of ln.runs) {
      if (r.tab) {
        tabsSet.set(Math.round((r.x - ctx.left) * TW), 1);
        xml += "<w:r><w:tab/></w:r>";
        continue;
      }
      let text = r.text;
      if (skip) {
        // viñeta: se conserva el símbolo y se separa del texto con un tabulador (sangría francesa)
        const tok = text.slice(0, skip).trim();
        if (tok) xml += run(/^[\-–—*·]$/.test(tok) ? "•" : tok, { font: r.family, size: r.size, bold: r.bold, color: r.color }) + "<w:r><w:tab/></w:r>";
        else xml += "<w:r><w:tab/></w:r>";
        text = text.slice(skip);
        skip = 0;
        if (!text) continue;
      }
      xml += run(text, { font: r.family, size: r.size, bold: r.bold, italic: r.italic, color: r.color, underline: r.underline });
    }
  });
  const tabs = [...tabsSet.keys()].sort((a, b) => a - b).map((p) => `<w:tab w:val="left" w:pos="${p}"/>`).join("");
  const pr = `${opts.keepNext ? "<w:keepNext/>" : ""}${P.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${P.fill}"/>` : ""}${tabs ? `<w:tabs>${tabs}</w:tabs>` : ""}<w:spacing w:before="${before}" w:after="0" w:line="${lineSp}" w:lineRule="auto"/>${ind}${align ? `<w:jc w:val="${align}"/>` : ""}`;
  return `<w:p><w:pPr>${pr}</w:pPr>${xml}</w:p>`;
}

// ───────────────────────── tablas ─────────────────────────

function cluster(vals, tol = 1.8) {
  const s = [...vals].sort((a, b) => a - b);
  const out = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && v - last.sum / last.n <= tol) { last.sum += v; last.n++; }
    else out.push({ sum: v, n: 1 });
  }
  return out.map((o) => o.sum / o.n);
}

function coverage(ivs, len) {
  const iv = ivs.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let cov = 0, end = -1e9;
  for (const [a, b] of iv) { const s0 = Math.max(a, end); if (b > s0) cov += b - s0; end = Math.max(end, b); }
  return cov >= 0.6 * len;
}

function findTables(raw) {
  const pageArea = raw.W * raw.H;
  const realH = raw.segs.h.filter((s) => s.x2 - s.x1 >= 4 && !s.used);
  const realV = raw.segs.v.filter((s) => s.y2 - s.y1 >= 4);
  // los bordes de los rellenos de color también delimitan celdas (aunque no se dibujen líneas)
  const vH = [], vV = [];
  for (const f of raw.fills) {
    if (f.color === "FFFFFF" || f.w * f.h > 0.9 * pageArea || f.w < 6 || f.h < 5) continue;
    vH.push({ y: f.y, x1: f.x, x2: f.x + f.w, virtual: true }, { y: f.y + f.h, x1: f.x, x2: f.x + f.w, virtual: true });
    vV.push({ x: f.x, y1: f.y, y2: f.y + f.h, virtual: true }, { x: f.x + f.w, y1: f.y, y2: f.y + f.h, virtual: true });
  }
  const H = realH.concat(vH);
  const V = realV.concat(vV);
  const nodes = [...H.map((s) => ({ t: "h", s })), ...V.map((s) => ({ t: "v", s }))];
  const par = nodes.map((_, i) => i);
  const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
  const tol = 2.5;
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.t === b.t) continue;
      const h = a.t === "h" ? a.s : b.s, v = a.t === "h" ? b.s : a.s;
      if (v.x >= h.x1 - tol && v.x <= h.x2 + tol && h.y >= v.y1 - tol && h.y <= v.y2 + tol) par[find(i)] = find(j);
    }
  const comps = new Map();
  nodes.forEach((n, i) => { const r = find(i); (comps.get(r) || comps.set(r, []).get(r)).push(n); });
  const tables = [];
  for (const comp of comps.values()) {
    const hs = comp.filter((n) => n.t === "h").map((n) => n.s), vs = comp.filter((n) => n.t === "v").map((n) => n.s);
    if (hs.length < 2 || vs.length < 2) continue;
    // hace falta algún borde dibujado de verdad (si solo hay rellenos, se tratan como sombreado de párrafo)
    if (hs.filter((s) => !s.virtual).length < 1 || vs.filter((s) => !s.virtual).length < 1) continue;
    const xs = cluster(vs.map((s) => s.x)), ys = cluster(hs.map((s) => s.y));
    if (xs.length < 2 || ys.length < 2) continue;
    const bbox = { x1: xs[0], x2: xs[xs.length - 1], y1: ys[0], y2: ys[ys.length - 1] };
    if (bbox.x2 - bbox.x1 > raw.W * 0.995 && bbox.y2 - bbox.y1 > raw.H * 0.97) continue; // marco de página
    // cobertura de bordes
    const covV = (x, ya, yb) => {
      let cov = 0;
      const iv = vs.filter((s) => Math.abs(s.x - x) < 2.2).map((s) => [Math.max(ya, s.y1), Math.min(yb, s.y2)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
      let end = -1e9;
      for (const [a, b] of iv) { const s0 = Math.max(a, end); if (b > s0) cov += b - s0; end = Math.max(end, b); }
      return cov >= 0.6 * (yb - ya);
    };
    const covH = (y, xa, xb) => {
      let cov = 0;
      const iv = hs.filter((s) => Math.abs(s.y - y) < 2.2).map((s) => [Math.max(xa, s.x1), Math.min(xb, s.x2)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
      let end = -1e9;
      for (const [a, b] of iv) { const s0 = Math.max(a, end); if (b > s0) cov += b - s0; end = Math.max(end, b); }
      return cov >= 0.6 * (xb - xa);
    };
    const realCovV = (x, ya, yb) => coverage(vs.filter((s) => !s.virtual).filter((s) => Math.abs(s.x - x) < 2.4).map((s) => [Math.max(ya, s.y1), Math.min(yb, s.y2)]), yb - ya);
    const realCovH = (y, xa, xb) => coverage(hs.filter((s) => !s.virtual).filter((s) => Math.abs(s.y - y) < 2.4).map((s) => [Math.max(xa, s.x1), Math.min(xb, s.x2)]), xb - xa);
    const rows = ys.length - 1, cols = xs.length - 1;
    const done = Array.from({ length: rows }, () => Array(cols).fill(false));
    const cells = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (done[r][c]) continue;
        let cs = 1;
        while (c + cs < cols && !done[r][c + cs] && !covV(xs[c + cs], ys[r], ys[r + 1])) cs++;
        let rs = 1;
        while (r + rs < rows) {
          let cov = 0;
          for (let k = c; k < c + cs; k++) if (covH(ys[r + rs], xs[k], xs[k + 1])) cov++;
          if (cov > 0) break;
          let ok = true;
          for (let k = c; k < c + cs; k++) if (done[r + rs][k]) ok = false;
          if (!ok) break;
          rs++;
        }
        for (let a = r; a < r + rs; a++) for (let b = c; b < c + cs; b++) done[a][b] = true;
        cells.push({ r, c, rs, cs, x1: xs[c], x2: xs[c + cs], y1: ys[r], y2: ys[r + rs] });
        const cell = cells[cells.length - 1];
        cell.b = { top: realCovH(cell.y1, cell.x1, cell.x2), bottom: realCovH(cell.y2, cell.x1, cell.x2), left: realCovV(cell.x1, cell.y1, cell.y2), right: realCovV(cell.x2, cell.y1, cell.y2) };
      }
    const lw = X.median(comp.map((n) => n.s.w || 0.5));
    const col = (comp.find((n) => n.s.color) || { s: {} }).s.color;
    tables.push({ xs, ys, bbox, cells, rows, cols, color: col && col !== "FFFFFF" ? col : "000000", lw: Math.max(0.25, Math.min(3, lw)) });
  }
  // descarta tablas contenidas dentro de otra (se tratan como parte de la mayor)
  return tables.filter((t, i) => !tables.some((u, j) => j !== i && u.bbox.x1 <= t.bbox.x1 + 1 && u.bbox.x2 >= t.bbox.x2 - 1 && u.bbox.y1 <= t.bbox.y1 + 1 && u.bbox.y2 >= t.bbox.y2 - 1 && (u.bbox.x2 - u.bbox.x1) * (u.bbox.y2 - u.bbox.y1) > (t.bbox.x2 - t.bbox.x1) * (t.bbox.y2 - t.bbox.y1) + 4));
}

// ───────────────────────── página → bloques ─────────────────────────

function inside(b, x, y) { return x >= b.x1 - 1 && x <= b.x2 + 1 && y >= b.y1 - 1 && y <= b.y2 + 1; }

/** Bloques de una página, en orden de lectura: {kind:'para'|'table'|'image', top, bottom, ...} */
function buildPage(raw, opts = {}) {
  const tables = opts.noTables ? [] : findTables(raw);
  const rest = [];
  const tableTexts = tables.map(() => []);
  for (const t of raw.texts) {
    let placed = false;
    const cy = t.y - 0.3 * t.size, cx = t.x + Math.min(t.w, t.size) * 0.5;
    for (let i = 0; i < tables.length; i++)
      if (inside(tables[i].bbox, cx, cy)) { tableTexts[i].push(t); placed = true; break; }
    if (!placed) rest.push(t);
  }
  const pageArea = raw.W * raw.H;
  const nChars = raw.texts.reduce((n, t) => n + t.str.length, 0);
  const tableImgs = tables.map(() => []);
  const freeImgs = [];
  for (const im of raw.images) {
    // fondos de página completa con texto encima: se omiten
    if (nChars > 20 && im.w * im.h > 0.8 * pageArea) { raw.skippedBg = true; continue; }
    const cx = im.x + im.w / 2, cy = im.y + im.h / 2;
    let placed = false;
    for (let i = 0; i < tables.length; i++)
      if (inside(tables[i].bbox, cx, cy) && im.w <= tables[i].bbox.x2 - tables[i].bbox.x1 + 2) { tableImgs[i].push(im); placed = true; break; }
    if (!placed) freeImgs.push(im);
  }
  const blocks = [];
  // límites del área de texto de la página
  const allLines = buildLines(rest);
  const lefts = [...allLines.map((l) => l.x), ...tables.map((t) => t.bbox.x1), ...freeImgs.map((i) => i.x)];
  const rights = [...allLines.map((l) => l.right), ...tables.map((t) => t.bbox.x2), ...freeImgs.map((i) => i.x + i.w)];
  const ctx = { left: lefts.length ? Math.min(...lefts) : 56, right: rights.length ? Math.max(...rights) : raw.W - 56 };
  // el margen izquierdo es el mínimo "frecuente" (ignora un título aislado más a la izquierda)
  if (allLines.length > 6) {
    const cnt = new Map();
    allLines.forEach((l) => { const k = Math.round(l.x); cnt.set(k, (cnt.get(k) || 0) + 1); });
    const common = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    if (common && common[0] > ctx.left && common[0] - ctx.left < 8) ctx.left = common[0];
  }
  const paras = buildParagraphs(allLines, ctx);
  for (const P of paras) {
    const l0 = P.lines[0];
    const cy = l0.y - 0.3 * l0.size, cx = (l0.x + l0.right) / 2;
    const f = raw.fills.find((f) => f.color !== "FFFFFF" && f.w * f.h < 0.9 * pageArea && cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h && f.h < P.lines.length * l0.size * 2.2 + 10 && !tables.some((t) => inside(t.bbox, cx, cy)));
    if (f) P.fill = f.color;
  }
  for (const P of paras) blocks.push({ kind: "para", top: P.lines[0].y - P.lines[0].size, bottom: P.lines[P.lines.length - 1].y + 2, P });
  tables.forEach((t, i) => blocks.push({ kind: "table", top: t.bbox.y1, bottom: t.bbox.y2, table: t, texts: tableTexts[i], images: tableImgs[i], raw: { W: raw.W, H: raw.H, fills: raw.fills.filter((f) => f.x < t.bbox.x2 && f.x + f.w > t.bbox.x1 && f.y < t.bbox.y2 && f.y + f.h > t.bbox.y1) } }));
  for (const im of freeImgs) blocks.push({ kind: "image", top: im.y, bottom: im.y + im.h, im });
  blocks.sort((a, b) => a.top - b.top || (a.kind === "image" ? -1 : 1));
  // imágenes en la misma franja horizontal → una fila (tabla sin bordes), para conservar las cuadrículas de imágenes
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind !== "image") continue;
    const row = [blocks[i]];
    let j = i + 1;
    while (j < blocks.length && blocks[j].kind === "image") {
      const a = row[0], b = blocks[j];
      const ov = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ov >= 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top)) { row.push(b); j++; } else break;
    }
    if (row.length > 1) {
      row.sort((p, q) => p.im.x - q.im.x);
      blocks.splice(i, row.length, { kind: "imagerow", top: Math.min(...row.map((r) => r.top)), bottom: Math.max(...row.map((r) => r.bottom)), ims: row.map((r) => r.im) });
    }
  }
  // gapBefore del primer párrafo tras un bloque no textual: distancia desde su borde inferior
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].kind === "para" && blocks[i - 1].kind !== "para") {
      const P = blocks[i].P;
      P.gapBefore = Math.max(0, P.lines[0].y - blocks[i - 1].bottom);
      P.afterBlock = true;
      P.gapBefore = P.gapBefore + 1.15 * P.lines[0].size; // el resto de la fórmula resta una interlínea
    } else if (blocks[i].kind === "para" && blocks[i - 1].kind === "para") {
      const prev = blocks[i - 1].P;
      blocks[i].P.gapBefore = blocks[i].P.lines[0].y - prev.lines[prev.lines.length - 1].y;
    }
  }
  const top = blocks.length ? Math.min(...blocks.map((b) => b.top)) : 0;
  const bottom = blocks.length ? Math.max(...blocks.map((b) => b.bottom)) : 0;
  return { blocks, ctx, W: raw.W, H: raw.H, top, bottom, nChars, tables: tables.length, images: raw.images.length };
}

// ───────────────────────── documento completo ─────────────────────────

function normHF(s) { return s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase(); }

/**
 * Convierte un PDF (Buffer) en grupos de páginas con bloques editables.
 * @returns {Promise<{groups:{landscape:boolean,margins:object,blocks:object[]}[], pages:number, truncated:boolean, stats:object, avisos:string[]}>}
 */
async function convertPdf(buffer) {
  if (!buffer || buffer.length < 8 || !buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) throw new Error("el archivo no es un PDF válido");
  const lib = await X.load();
  const task = lib.pdfjs.getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: lib.standardFontDataUrl, cMapUrl: lib.cMapUrl, cMapPacked: true, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  let doc;
  try { doc = await task.promise; } catch (e) {
    if (e && e.name === "PasswordException") throw new Error("el PDF está protegido con contraseña");
    throw new Error(`no se ha podido abrir el PDF (${String((e && e.message) || e).slice(0, 100)})`);
  }
  const avisos = [];
  const raws = [];
  const imgCache = new Map();
  try {
    const n = Math.min(doc.numPages, X.MAX_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      raws.push(await X.extractPage(page, lib, imgCache));
      page.cleanup();
    }
    if (doc.numPages > n) avisos.push(`Tiene ${doc.numPages} páginas: se convierten solo las primeras ${n}.`);
  } finally {
    try { await doc.destroy(); } catch (_) {}
  }
  // cabeceras y pies repetidos (número de página, título del documento) fuera
  if (raws.length > 1) {
    const cnt = new Map();
    for (const r of raws) {
      const keys = new Set();
      for (const t of r.texts) if (t.y < r.H * 0.07 || t.y > r.H * 0.93) keys.add(normHF(t.str));
      keys.forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1));
    }
    for (const r of raws) r.texts = r.texts.filter((t) => !((t.y < r.H * 0.07 || t.y > r.H * 0.93) && cnt.get(normHF(t.str)) >= Math.max(2, Math.ceil(raws.length * 0.5))));
  } else if (raws.length === 1) {
    raws[0].texts = raws[0].texts.filter((t) => !(t.y > raws[0].H * 0.95 && /^\s*\d{1,3}\s*$/.test(t.str)));
  }
  const pages = raws.map((r) => buildPage(r));
  const chars = pages.reduce((n, p) => n + p.nChars, 0);
  const nImgs = pages.reduce((n, p) => n + p.images, 0);
  if (!chars && !nImgs) throw new Error("el PDF no tiene texto ni imágenes que se puedan convertir");
  if (raws.some((r) => r.skippedBg)) avisos.push("Se ha omitido una imagen de fondo a toda página (el texto sí se incluye).");

  // grupos de páginas consecutivas con la misma orientación
  const groups = [];
  pages.forEach((p, i) => {
    const landscape = p.W > p.H;
    const g = groups[groups.length - 1];
    if (g && g.landscape === landscape) g.pages.push(p);
    else groups.push({ landscape, pages: [p] });
  });
  const out = [];
  for (const g of groups) {
    const pw = g.landscape ? X.A4.h : X.A4.w;
    const minX = Math.min(...g.pages.filter((p) => p.blocks.length).map((p) => p.ctx.left));
    const maxR = Math.max(...g.pages.filter((p) => p.blocks.length).map((p) => p.ctx.right));
    const minTop = Math.min(...g.pages.filter((p) => p.blocks.length).map((p) => p.top));
    let left = Number.isFinite(minX) ? Math.max(28, Math.min(150, minX)) : 56;
    let width = Number.isFinite(maxR) && Number.isFinite(minX) ? maxR - minX : pw - 112;
    let right = pw - left - width;
    if (right < 28) right = 28;
    if (pw - left - right < 200) { left = 56; right = 56; }
    const margins = {
      left: Math.round(left * TW), right: Math.round(right * TW),
      top: Math.round(Math.max(42, Math.min(110, Number.isFinite(minTop) ? minTop - 2 : 56)) * TW),
      bottom: Math.round(44 * TW), header: 400, footer: 480,
    };
    // bloques de todas las páginas del grupo, con saltos solo donde la página acaba pronto
    const blocks = [];
    g.pages.forEach((p, pi) => {
      if (pi > 0) {
        const prev = g.pages[pi - 1];
        const early = prev.bottom < prev.H * 0.7;
        if (early && blocks.length) blocks.push({ kind: "break" });
        else if (blocks.length && p.blocks.length) {
          // párrafo cortado por el salto de página: se une al anterior
          const a = blocks[blocks.length - 1], b = p.blocks[0];
          if (a.kind === "para" && b.kind === "para" && !b.P.bullet) {
            const L = a.P.lines[a.P.lines.length - 1];
            const full = L.right >= prev.ctx.right - Math.max(0.14 * (prev.ctx.right - prev.ctx.left), 3 * L.size);
            if (full && prev.bottom > prev.H * 0.82 && Math.abs(b.P.first - a.P.cont) < 6 && !L.runs.some((r) => r.tab)) {
              b.P.lines.forEach((ln) => a.P.lines.push(ln));
              p.blocks.shift();
            } else if (b.P.gapBefore == null) b.P.gapBefore = 1.5 * b.P.lines[0].size;
          } else if (b && b.kind === "para" && b.P.gapBefore == null) b.P.gapBefore = 1.5 * b.P.lines[0].size;
        }
      }
      for (const bl of p.blocks) blocks.push(bl);
    });
    out.push({ landscape: g.landscape, margins, blocks, textWidth: pw - (margins.left + margins.right) / TW, ctxLeft: Number.isFinite(minX) ? minX : 56, ctxRight: Number.isFinite(maxR) ? maxR : pw - 56 });
  }
  const stats = { paginas: pages.length, caracteres: chars, imagenes: nImgs, tablas: pages.reduce((n, p) => n + p.tables, 0) };
  return { groups: out, pages: pages.length, truncated: doc.numPages > X.MAX_PAGES, stats, avisos };
}

// ───────────────────────── a XML de Word ─────────────────────────

function blocksToXml(blocks, builder, ctxFor, availPt, imgCache) {
  let xml = "";
  let firstPara = true;
  const imgXml = (im, avail) => {
    let w = im.w, h = im.h;
    const k = Math.min(1, avail / w, 700 / h);
    w *= k; h *= k;
    let rid = imgCache.get(im.enc);
    if (!rid) { rid = builder.registerImage(im.enc.buf, im.enc.ext); imgCache.set(im.enc, rid); }
    return builder.imageXml(rid, Math.round(w * 12700), Math.round(h * 12700), "Imagen del documento");
  };
  for (const bl of blocks) {
    if (bl.kind === "break") { xml += `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`; firstPara = true; continue; }
    if (bl.kind === "para") {
      xml += paraXml(bl.P, ctxFor(bl), { firstGap: null });
      firstPara = false;
    } else if (bl.kind === "image") {
      const ctx = ctxFor(bl);
      const cx = bl.im.x + bl.im.w / 2, mid = (ctx.left + ctx.right) / 2;
      const center = Math.abs(cx - mid) < 8;
      const before = Math.min(300, Math.round(4 * TW));
      xml += `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${before}"/>${center ? '<w:jc w:val="center"/>' : bl.im.x - ctx.left > 2 ? `<w:ind w:left="${Math.round((bl.im.x - ctx.left) * TW)}"/>` : ""}</w:pPr>${imgXml(bl.im, availPt)}</w:p>`;
    } else if (bl.kind === "imagerow") {
      const ctx = ctxFor(bl);
      const ims = bl.ims;
      const k = Math.min(1, availPt / (Math.max(...ims.map((i) => i.x + i.w)) - Math.min(...ims.map((i) => i.x))));
      const widths = ims.map((im, i) => Math.round(((i < ims.length - 1 ? Math.max(im.w, ims[i + 1].x - im.x) : im.w) * k) * TW) + 40);
      const lead = Math.max(0, Math.round((ims[0].x - ctx.left) * TW));
      const cells = ims.map((im, i) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${imgXml(im, im.w * k)}</w:p></w:tc>`).join("");
      xml += `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b2) => a + b2, 0)}" w:type="dxa"/>${lead > 40 ? `<w:tblInd w:w="${lead}" w:type="dxa"/>` : ""}<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((b2) => `<w:${b2} w:val="nil"/>`).join("")}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr></w:tbl>`;
      xml += `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>`;
    } else if (bl.kind === "table") {
      xml += tableXml(bl, builder, availPt, imgXml, ctxFor(bl));
      xml += `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>`;
    }
  }
  return xml;
}

/** Una celda combinada solo porque no tiene borde vertical se parte donde el texto no cruza una columna */
function splitSpanCells(t, texts) {
  const out = [];
  for (const c of t.cells) {
    if (c.cs < 2 || c.rs > 1) { out.push(c); continue; }
    const inC = texts.filter((x) => x.y - 0.3 * x.size >= c.y1 - 1 && x.y - 0.3 * x.size <= c.y2 + 1 && x.x >= c.x1 - 1 && x.x <= c.x2 + 1);
    const cuts = [];
    for (let k = c.c + 1; k < c.c + c.cs; k++) {
      const bx = t.xs[k];
      const left = inC.some((x) => x.x + x.w <= bx + 1), right = inC.some((x) => x.x >= bx - 1);
      const cross = inC.some((x) => x.x < bx - 1 && x.x + x.w > bx + 1);
      if (left && right && !cross) cuts.push(k);
    }
    if (!cuts.length) { out.push(c); continue; }
    let start = c.c;
    for (const k of [...cuts, c.c + c.cs]) {
      out.push({ r: c.r, rs: 1, c: start, cs: k - start, x1: t.xs[start], x2: t.xs[k], y1: c.y1, y2: c.y2, b: { top: c.b.top, bottom: c.b.bottom, left: start === c.c ? c.b.left : false, right: k === c.c + c.cs ? c.b.right : false } });
      start = k;
    }
  }
  t.cells = out;
}

function tableXml(bl, builder, availPt, imgXml, pageCtx) {
  const t = bl.table;
  const widthPt = t.bbox.x2 - t.bbox.x1;
  // tablas de material (RECURSOS MATERIALES / MATERIAL FUNGIBLE / NO FUNGIBLE): ocupan todo el ancho útil
  const r0 = t.cells.filter((c) => c.r <= 1);
  const hy1 = Math.min(...r0.map((c) => c.y1)), hy2 = Math.max(...r0.map((c) => c.y2));
  const cabeza = bl.texts.filter((x) => x.y - 0.3 * x.size >= hy1 - 1 && x.y - 0.3 * x.size <= hy2 + 1).map((x) => x.str).join(" ");
  const esMaterial = /material\s+(no\s+)?fungible|recursos\s+materiales/i.test(cabeza);
  const k = esMaterial ? availPt / widthPt : widthPt > availPt ? availPt / widthPt : 1;
  const colW = [];
  for (let c = 0; c < t.cols; c++) colW.push(Math.round((t.xs[c + 1] - t.xs[c]) * k * TW));
  const total = colW.reduce((a, b) => a + b, 0);
  const indent = esMaterial ? 0 : Math.max(0, Math.round((t.bbox.x1 - pageCtx.left) * k * TW));
  const bsz = Math.max(2, Math.min(24, Math.round(t.lw * 8)));
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="nil"/>`).join("");
  const cellBorders = (c) => {
    const e = (n, on) => (on ? `<w:${n} w:val="single" w:sz="${bsz}" w:space="0" w:color="${t.color}"/>` : `<w:${n} w:val="nil"/>`);
    return `<w:tcBorders>${e("top", c.b.top)}${e("left", c.b.left)}${e("bottom", c.b.bottom)}${e("right", c.b.right)}</w:tcBorders>`;
  };
  const pad = 3;
  // contenido de cada celda
  const cellCtx = (c) => ({ left: c.x1 + pad, right: c.x2 - pad });
  splitSpanCells(t, bl.texts);
  const cellBlocks = new Map();
  for (const c of t.cells) cellBlocks.set(c, { texts: [], images: [] });
  const cellAt = (x, y) => t.cells.find((c) => x >= c.x1 - 1 && x <= c.x2 + 1 && y >= c.y1 - 1 && y <= c.y2 + 1);
  for (const tx of bl.texts) {
    const c = cellAt(tx.x + Math.min(tx.w, tx.size) * 0.5, tx.y - 0.3 * tx.size);
    if (c) cellBlocks.get(c).texts.push(tx);
  }
  for (const im of bl.images) {
    const c = cellAt(im.x + im.w / 2, im.y + im.h / 2);
    if (c) cellBlocks.get(c).images.push(im);
  }
  const fillOf = (c) => {
    let fill = null;
    const area = (c.x2 - c.x1) * (c.y2 - c.y1);
    for (const f of bl.raw.fills) {
      const ox = Math.min(c.x2, f.x + f.w) - Math.max(c.x1, f.x), oy = Math.min(c.y2, f.y + f.h) - Math.max(c.y1, f.y);
      if (ox <= 0 || oy <= 0) continue;
      if ((ox * oy) / area >= 0.55 && f.w * f.h < 0.9 * bl.raw.W * bl.raw.H) fill = f.color;
    }
    return fill && fill !== "FFFFFF" ? fill : null;
  };
  const rowsXml = [];
  // qué celda cubre (r,c)
  for (let r = 0; r < t.rows; r++) {
    let tcs = "";
    for (let c = 0; c < t.cols; c++) {
      const own = t.cells.find((x) => x.r <= r && r < x.r + x.rs && x.c <= c && c < x.c + x.cs);
      if (!own) { tcs += "<w:tc><w:tcPr/><w:p/></w:tc>"; continue; }
      if (own.c !== c) continue; // cubierta horizontalmente
      let w = 0;
      for (let k2 = own.c; k2 < own.c + own.cs; k2++) w += colW[k2];
      const pr = [`<w:tcW w:w="${w}" w:type="dxa"/>`];
      if (own.cs > 1) pr.push(`<w:gridSpan w:val="${own.cs}"/>`);
      if (own.rs > 1) pr.push(own.r === r ? '<w:vMerge w:val="restart"/>' : "<w:vMerge/>");
      pr.push(cellBorders(own));
      const fill = fillOf(own);
      if (fill) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`);
      let content = "";
      if (own.r === r) {
        const cb = cellBlocks.get(own);
        const cctx = cellCtx(own);
        const lines = buildLines(cb.texts);
        const paras = buildParagraphs(lines, cctx);
        paras.forEach((P, i) => { if (i === 0) P.gapBefore = null; });
        const sub = [];
        for (const P of paras) sub.push({ kind: "para", top: P.lines[0].y, bottom: P.lines[P.lines.length - 1].y, P });
        for (const im of cb.images) sub.push({ kind: "image", top: im.y, bottom: im.y + im.h, im });
        sub.sort((a, b) => a.top - b.top);
        // alineación centrada de celda: si todas las líneas están centradas en la celda
        content = blocksToXml(sub, builder, () => cctx, own.x2 - own.x1 - 2 * pad, tableXml.cache || (tableXml.cache = new Map()));
        const vtop = cb.texts.length ? Math.min(...cb.texts.map((x) => x.y - x.size)) : own.y1;
        const vbot = cb.texts.length ? Math.max(...cb.texts.map((x) => x.y)) : own.y2;
        const space = (own.y2 - own.y1) - (vbot - vtop);
        if (space > 8 && vtop - own.y1 > 0.3 * space && own.y2 - vbot > 0.3 * space) pr.push('<w:vAlign w:val="center"/>');
      }
      tcs += `<w:tc><w:tcPr>${pr.join("")}</w:tcPr>${content || "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\"/></w:pPr></w:p>"}</w:tc>`;
    }
    const h = Math.round((t.ys[r + 1] - t.ys[r]) * TW);
    rowsXml.push(`<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${Math.max(h, 200)}" w:hRule="atLeast"/></w:trPr>${tcs}</w:tr>`);
  }
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>${indent > 40 ? `<w:tblInd w:w="${indent}" w:type="dxa"/>` : ""}<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:top w:w="20" w:type="dxa"/><w:left w:w="${pad * TW}" w:type="dxa"/><w:bottom w:w="20" w:type="dxa"/><w:right w:w="${pad * TW}" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${colW.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rowsXml.join("")}</w:tbl>`
  );
}

/** XML de un grupo de páginas. Cada llamada usa el PlanningBuilder del planning (registra sus imágenes) */
function emitGroup(group, builder) {
  const avail = group.textWidth;
  const imgCache = new Map();
  tableXmlCacheReset();
  const ctxFor = (bl) => {
    if (bl.kind === "para") return { left: bl.P.ctxLeft != null ? bl.P.ctxLeft : group.ctxLeft, right: group.ctxRight };
    return { left: group.ctxLeft, right: group.ctxRight };
  };
  return blocksToXml(group.blocks, builder, ctxFor, avail, imgCache);
}
function tableXmlCacheReset() { tableXml.cache = new Map(); }

module.exports = { convertPdf, emitGroup, buildLines, buildParagraphs, findTables };
