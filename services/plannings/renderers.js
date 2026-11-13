// services/plannings/renderers.js
//
// Convierte datos de Excel (horario de cada día, planning general, tabla de
// turnos, tablas de grupos, contactos...) en tablas Word con el aspecto del
// planning de referencia: Calibri, tablas multicolumna, páginas apaisadas.
//
// Anchos útiles (twips):  vertical 9639  ·  apaisado 16130

const { esc, run, para, cell, row, table } = require("./ooxml");
const { loadWorkbook, cellLines, colorOf, mergeIndex } = require("./xlsxReader");

const FONT = "Calibri";
const FONT_LIGHT = "Calibri Light";
const W_PORTRAIT = 9639; // 11906 - 1417 - 850
const W_LANDSCAPE = 16130; // 16838 - 283 - 425
const H_LANDSCAPE = 9746; // 11906 - 960 - 1200 (alto útil de una página apaisada)
const GRIS_HORA = "7F7F7F";

const minutes = (t) => {
  if (!t) return 0;
  const [h, m] = String(t).split(":").map(Number);
  return (h < 6 ? h + 24 : h) * 60 + (m || 0);
};

function lightFill(hex) {
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
}

/** Una línea puede ser {text,bold,color} o {runs:[{text,bold}]} */
function cellParas(lines, size = 8.5, opts = {}) {
  if (!lines || !lines.length) return "";
  return lines
    .map((l) => {
      const runs = l.runs
        ? l.runs.map((r) => run(r.text, { bold: r.bold || opts.bold, size: r.size || size, font: FONT, color: r.color })).join("")
        : run(l.text, { bold: l.bold || opts.bold, size: l.size || size, font: FONT, color: l.color || opts.color });
      return para(runs, { after: 0, line: 240, align: l.align || opts.align });
    })
    .join("");
}

/**
 * Pinta una rejilla con celdas combinadas.
 * grid: filas de celdas {lines, fill, rowspan, colspan, covered, align}
 * opts: size, headerRows, minHeight, borderColor, borderSize, cellMargin, rowHeights[]
 */
function gridToXml(grid, widths, opts = {}) {
  const n = widths.length;
  const size = opts.size || 8.5;
  const vm = new Array(n).fill(null);
  const rows = [];
  grid.forEach((gr, ri) => {
    const cells = [];
    const active = vm.map((o) => (o && o.remaining > 0 ? o : null));
    const live = [...new Set(active.filter(Boolean))];
    let used = 0;
    for (let c = 0; c < n; c++) {
      const a = active[c];
      if (a) {
        if (a.start === c) {
          const w = widths.slice(c, c + a.span).reduce((x, y) => x + y, 0);
          cells.push(cell("", { width: w, span: a.span, vMerge: "continue", fill: a.fill }));
          used += a.span;
          c += a.span - 1;
        }
        continue;
      }
      const g = gr[c];
      if (!g || g.covered) continue;
      const span = Math.max(1, Math.min(g.colspan || 1, n - c));
      const w = widths.slice(c, c + span).reduce((x, y) => x + y, 0);
      const fill = lightFill(g.fill);
      const rs = g.rowspan || 1;
      if (rs > 1) {
        const o = { start: c, span, remaining: rs - 1, fill };
        for (let k = c; k < c + span; k++) vm[k] = o;
      }
      cells.push(
        cell(cellParas(g.lines, g.size || size, { align: g.align, bold: g.forceBold }), {
          width: w,
          span,
          fill,
          vMerge: rs > 1 ? "restart" : undefined,
          valign: g.valign || "center",
        })
      );
      used += span;
      c += span - 1;
    }
    live.forEach((o) => o.remaining--);
    if (used < n) {
      const w = widths.slice(used).reduce((x, y) => x + y, 0);
      cells.push(cell("", { width: w, span: n - used }));
    }
    const h = opts.rowHeights ? opts.rowHeights[ri] : opts.minHeight;
    rows.push(row(cells, { header: opts.headerRows && ri < opts.headerRows, height: h }));
  });
  return table(rows, widths, { borderSize: opts.borderSize || 4, borderColor: opts.borderColor || "000000", cellMargin: opts.cellMargin != null ? opts.cellMargin : 15, cellMarginX: opts.cellMarginX });
}

// ───────────────────────── Títulos y anclas ─────────────────────────

/** Título subrayado centrado (estilo del planning: «TABLA DE TURNOS», «Planning General...») */
function title(text, { bookmark, pageBreakBefore } = {}) {
  return para(run(text, { font: FONT_LIGHT }), { style: "PlDia", bookmark, after: 120, keepNext: true, pageBreakBefore });
}

/** Párrafo casi invisible que sirve de ancla del índice (marcador) */
function anchor(bookmark) {
  return para("", { bookmark, lineExact: 20, after: 0 });
}

// ───────────────────────── Horario de uno o varios días ─────────────────────────

/**
 * Hace una copia del día con líneas extra dentro de las celdas
 * (responsables, servicio de comida/guardia...).
 * extra: Map "fila,col" -> [líneas]
 */
function withExtraLines(day, extra) {
  if (!extra || !extra.size) return day;
  return {
    ...day,
    rows: day.rows.map((r, ri) => ({
      ...r,
      cells: r.cells.map((c, ci) => {
        const add = extra.get(`${ri},${ci}`);
        return add && !c.covered ? { ...c, lines: [...c.lines, ...add] } : c;
      }),
    })),
  };
}

/**
 * Rejilla (varios días en horizontal). Cada día ocupa 4 columnas:
 * hora + 3 columnas del horario (una por grupo/nivel).
 * Las horas se unifican entre días para que las filas coincidan.
 */
function daysGrid(days, { startOrdinal = 1 } = {}) {
  const times = [];
  const seen = new Set();
  for (const d of days)
    for (const r of d.rows)
      if (r.time && !seen.has(r.time)) {
        seen.add(r.time);
        times.push(r.time);
      }
  times.sort((a, b) => minutes(a) - minutes(b));
  const uIndex = new Map(times.map((t, i) => [t, i]));
  const COLS = 4;
  const grid = [];
  // cabecera: nº | etiqueta | título
  const head = [];
  days.forEach((d, di) => {
    const ord = d.kind === "lluvia" ? "☂" : String(startOrdinal + di);
    head.push({ lines: [{ text: ord, bold: true }], fill: null, align: "center", rowspan: 1, colspan: 1, isHead: true });
    head.push({ lines: [{ text: d.kind === "lluvia" ? "LLUVIA" : d.label, bold: true }], fill: lightFill(d.headFill), align: "center", rowspan: 1, colspan: 1, isHead: true });
    head.push({ lines: [{ text: d.title || "", bold: true }], fill: null, align: "center", rowspan: 1, colspan: 2, isHead: true });
    head.push({ covered: true });
  });
  grid.push(head);
  times.forEach((t, ui) => {
    const line = [];
    days.forEach((d) => {
      const dr = d.rows.findIndex((r) => r.time === t);
      line.push({ lines: [{ text: t, color: GRIS_HORA }], align: "center", rowspan: 1, colspan: 1, isTime: true });
      for (let k = 0; k < 3; k++) {
        if (dr < 0) {
          line.push({ lines: [], rowspan: 1, colspan: 1 });
          continue;
        }
        const c = d.rows[dr].cells[k];
        if (!c || c.covered) {
          line.push({ covered: true });
          continue;
        }
        // altura recalculada en filas unificadas
        const lastRow = d.rows[Math.min(dr + (c.rowspan || 1) - 1, d.rows.length - 1)];
        const rs = lastRow && lastRow.time && uIndex.has(lastRow.time) ? uIndex.get(lastRow.time) - ui + 1 : 1;
        line.push({ lines: c.lines, fill: c.fill, align: "center", rowspan: Math.max(1, rs), colspan: c.colspan || 1 });
      }
    });
    grid.push(line);
  });
  return { grid, rows: times.length, cols: days.length * COLS };
}

/** Altura estimada (twips) de una rejilla, para ajustar el tamaño de letra a una sola página */
function estimateHeight(grid, widths, size, minRow) {
  const lineH = size * 20 * 1.22;
  const charsPer = (w) => Math.max(3, Math.floor((w - 60) / (size * 20 * 0.5)));
  const heights = grid.map((r, ri) => {
    let h = minRow;
    let c = 0;
    r.forEach((g) => {
      if (!g || g.covered) {
        c++;
        return;
      }
      const span = g.colspan || 1;
      const w = widths.slice(c, c + span).reduce((a, b) => a + b, 0);
      c += 1;
      if ((g.rowspan || 1) > 1) return;
      if (g.isTime) return;
      const nl = (g.lines || []).reduce((n, l) => {
        const t = l.runs ? l.runs.map((x) => x.text).join("") : l.text || "";
        return n + Math.max(1, Math.ceil(t.length / charsPer(w)));
      }, 0);
      h = Math.max(h, nl * lineH + 40);
    });
    return h;
  });
  // celdas combinadas: si no caben, el déficit se reparte en sus filas
  grid.forEach((r, ri) => {
    let c = 0;
    r.forEach((g) => {
      if (!g || g.covered) {
        c++;
        return;
      }
      const span = g.colspan || 1;
      const w = widths.slice(c, c + span).reduce((a, b) => a + b, 0);
      c += 1;
      const rs = g.rowspan || 1;
      if (rs <= 1) return;
      const nl = (g.lines || []).reduce((n, l) => {
        const t = l.runs ? l.runs.map((x) => x.text).join("") : l.text || "";
        return n + Math.max(1, Math.ceil(t.length / charsPer(w)));
      }, 0);
      const need = nl * lineH + 40;
      let have = 0;
      for (let k = ri; k < ri + rs && k < heights.length; k++) have += heights[k];
      if (need > have) {
        const extra = (need - have) / rs;
        for (let k = ri; k < ri + rs && k < heights.length; k++) heights[k] += extra;
      }
    });
  });
  return heights;
}

/**
 * Tabla de UN día, apaisada y en una sola página. El tamaño de letra baja
 * lo necesario (máx. 10 pt → mín. 6 pt) para que quepa.
 */
function dayTableXml(day, { ordinal = 1, textW = W_LANDSCAPE, maxHeight = Math.round(H_LANDSCAPE * 0.9), meta = null } = {}) {
  const { grid } = daysGrid([day], { startOrdinal: ordinal });
  const timeW = 720;
  const sub = Math.floor((textW - timeW) / 3);
  const widths = [timeW, sub, sub, textW - timeW - sub * 2];
  let size = 10;
  let heights;
  for (; size >= 6; size -= 0.5) {
    const minRow = Math.round(size * 20 * 1.3);
    heights = estimateHeight(grid, widths, size, minRow);
    if (heights.reduce((a, b) => a + b, 0) <= maxHeight) break;
  }
  const hs = heights.map((h) => Math.round(h));
  if (meta) {
    meta.size = size;
    meta.alto = Math.round(heights.reduce((a, b) => a + b, 0));
    meta.maxAlto = maxHeight;
    meta.cabe = meta.alto <= maxHeight;
  }
  // cabecera algo más grande
  grid[0].forEach((g) => {
    if (g && !g.covered) g.size = Math.min(14, size + 3);
  });
  return gridToXml(grid, widths, { size, rowHeights: hs, borderSize: 4, cellMargin: 10 });
}

/**
 * Planning general: varios días en horizontal por página (5 por defecto),
 * para verlo en grande.
 * @returns {string[]} un XML de tabla por página
 */
function generalPlanningPages(days, { perPage = 5, textW = W_LANDSCAPE, firstPageExtra = 380 } = {}) {
  const pages = [];
  for (let i = 0; i < days.length; i += perPage) {
    const chunk = days.slice(i, i + perPage);
    const { grid } = daysGrid(chunk, { startOrdinal: i + 1 });
    const per = Math.floor(textW / perPage);
    const timeW = 540;
    const sub = Math.floor((per - timeW) / 3);
    const widths = [];
    chunk.forEach(() => widths.push(timeW, sub, sub, per - timeW - sub * 2));
    // si hay menos de perPage días, la tabla no se estira
    const total = widths.reduce((a, b) => a + b, 0);
    const maxH = Math.round(H_LANDSCAPE * 0.92) - (i === 0 ? 900 + firstPageExtra : 0);
    let size = 6.5;
    let heights;
    for (; size >= 4; size -= 0.25) {
      heights = estimateHeight(grid, widths, size, Math.round(size * 20 * 1.25));
      if (heights.reduce((a, b) => a + b, 0) <= maxH) break;
    }
    grid[0].forEach((g) => {
      if (g && !g.covered) g.size = Math.min(8, size + 1.5);
    });
    pages.push(gridToXml(grid, widths, { size, rowHeights: heights.map((h) => Math.round(h)), cellMargin: 5, cellMarginX: 25, borderSize: 4 }));
  }
  return pages;
}

// ───────────────────────── Turnos ─────────────────────────

/** Tabla de turnos: una sola tabla con todos los días, apaisada, cabecera repetida */
function turnosXml(turnos, { textW = W_LANDSCAPE } = {}) {
  const days = turnos.days;
  const nameW = 1250;
  const dayW = Math.floor((textW - nameW) / Math.max(1, days.length));
  const widths = [nameW, ...days.map(() => dayW)];
  widths[widths.length - 1] += textW - widths.reduce((a, b) => a + b, 0);
  const size = days.length > 15 ? 6.5 : days.length > 12 ? 7 : 7.5;
  const grid = [];
  grid.push([
    { lines: [{ text: "" }], align: "center" },
    ...days.map((d) => ({ lines: [{ text: d, bold: true }], fill: "D9D9D9", align: "center" })),
  ]);
  for (const m of turnos.monitors) {
    grid.push([
      { lines: [{ text: m.name.toUpperCase(), bold: true }], fill: lightFill(m.fill) || "DDEBF7", align: "center" },
      ...days.map((d) => ({
        lines: (m.cells[d] || []).map((t) => ({ text: t.task, bold: t.bold })),
        fill: lightFill((m.fills || {})[d]),
        align: "center",
      })),
    ]);
  }
  return gridToXml(grid, widths, { size, headerRows: 1, minHeight: 420, cellMargin: 10 });
}

// ───────────────────────── Hoja de Excel genérica ─────────────────────────

const ALIGN = { left: "left", center: "center", right: "right", centerContinuous: "center" };

/**
 * Convierte las hojas de un Excel (contactos, grupos, servicio, alergias,
 * menú...) en tablas Word respetando celdas combinadas, negrita, colores,
 * alineación y proporciones de las columnas.
 *
 * opts: landscape, size (base), boldFirstCol, maxRows, sheetFilter(name)->bool,
 *       pageBreaks (una hoja por página), titles (título con el nombre de la hoja)
 * @returns {{xml:string, warnings:string[], sheets:string[]}}
 */
async function sheetsToXml(buffer, opts = {}) {
  const { landscape = false, boldFirstCol = false, maxRows = 400, sheetFilter = null, pageBreaks = false, onSheet = null } = opts;
  const textW = landscape ? W_LANDSCAPE : W_PORTRAIT;
  const wb = await loadWorkbook(buffer);
  const parts = [];
  const warnings = [];
  const sheets = [];
  let first = true;
  for (const ws of wb.worksheets) {
    if (sheetFilter && !sheetFilter(ws.name)) continue;
    const merges = mergeIndex(ws);
    const R = Math.min(ws.rowCount, maxRows);
    const C = Math.min(ws.columnCount, 40);
    if (ws.rowCount > maxRows) warnings.push(`La hoja "${ws.name}" tiene más de ${maxRows} filas; se han incluido las primeras ${maxRows}.`);
    let r1 = 1e9, r2 = 0, c1 = 1e9, c2 = 0;
    for (let r = 1; r <= R; r++)
      for (let c = 1; c <= C; c++) {
        if (cellLines(ws.getCell(r, c)).length) {
          r1 = Math.min(r1, r); r2 = Math.max(r2, r); c1 = Math.min(c1, c); c2 = Math.max(c2, c);
        }
      }
    if (r2 === 0) continue;
    // columnas con contenido (o que forman parte de una combinada con contenido)
    const cols = [];
    for (let c = c1; c <= c2; c++) {
      let any = false;
      for (let r = r1; r <= r2 && !any; r++) any = cellLines(ws.getCell(r, c)).length > 0 || (merges.get(`${r},${c}`) && (merges.get(`${r},${c}`).c1 !== c || merges.get(`${r},${c}`).r1 !== r));
      if (any) cols.push(c);
    }
    // anchos proporcionales a los de Excel
    const wch = cols.map((c) => Math.max(3, (ws.getColumn(c) && ws.getColumn(c).width) || 8.43));
    const sum = wch.reduce((a, b) => a + b, 0);
    const widths = wch.map((w) => Math.max(260, Math.round((w / sum) * textW)));
    widths[widths.length - 1] += textW - widths.reduce((a, b) => a + b, 0);
    if (widths[widths.length - 1] < 260) {
      const k = textW / widths.reduce((a, b) => a + b, 0);
      for (let i = 0; i < widths.length; i++) widths[i] = Math.round(widths[i] * k);
      widths[widths.length - 1] += textW - widths.reduce((a, b) => a + b, 0);
    }
    // tamaño base según nº de columnas, escalado por el tamaño de letra de Excel
    const fonts = [];
    for (let r = r1; r <= r2; r++) for (const c of cols) { const f = ws.getCell(r, c).font; if (f && f.size && cellLines(ws.getCell(r, c)).length) fonts.push(f.size); }
    fonts.sort((a, b) => a - b);
    const med = fonts.length ? fonts[Math.floor(fonts.length / 2)] : 11;
    const base = opts.size || Math.max(6.5, Math.min(landscape ? 10 : 10.5, (landscape ? 13 : 12) - cols.length * 0.3));
    const grid = [];
    const heights = [];
    for (let r = r1; r <= r2; r++) {
      const rowCells = [];
      let empty = true;
      cols.forEach((c, k) => {
        const cellObj = ws.getCell(r, c);
        const lines = cellLines(cellObj);
        if (lines.length) empty = false;
        const m = merges.get(`${r},${c}`);
        let covered = false, rowspan = 1, colspan = 1;
        if (m) {
          if (m.r1 !== r || m.c1 !== c) covered = true;
          else {
            rowspan = Math.min(m.r2, r2) - r + 1;
            colspan = cols.filter((x) => x >= m.c1 && x <= m.c2).length || 1;
          }
        }
        const fsz = cellObj.font && cellObj.font.size ? cellObj.font.size : med;
        const scale = Math.max(0.8, Math.min(2.2, fsz / med));
        const horizontal = cellObj.alignment && cellObj.alignment.horizontal;
        rowCells.push({
          lines: covered ? [] : lines.map((l) => ({ ...l, bold: l.bold || (boldFirstCol && k === 0) })),
          fill: covered ? null : colorOf(cellObj.fill),
          rowspan,
          colspan,
          covered,
          size: Math.round(base * scale * 2) / 2,
          align: ALIGN[horizontal] || (typeof cellObj.value === "number" ? "center" : "left"),
        });
      });
      if (!empty || rowCells.some((x) => x.covered)) {
        grid.push(rowCells);
        const rh = ws.getRow(r).height;
        heights.push(rh ? Math.min(1400, Math.round(rh * 20)) : Math.round(base * 20 * 1.4));
      }
    }
    sheets.push(ws.name);
    const brk = !first && pageBreaks ? para("", { pageBreakBefore: true, lineExact: 20, after: 0 }) : "";
    const extra = onSheet ? onSheet(ws.name, first) : "";
    parts.push(brk + extra + gridToXml(grid, widths, { size: base, rowHeights: heights, cellMargin: 15 }) + para("", { after: 0, lineExact: 120 }));
    first = false;
  }
  return { xml: parts.join(""), warnings, sheets };
}

// ───────────────────────── Piezas pequeñas ─────────────────────────

function nombresTexto(nombres) {
  const n = nombres.map((x) => String(x).toUpperCase());
  if (n.length <= 1) return n.join("");
  return `${n.slice(0, -1).join(", ")} Y ${n[n.length - 1]}`;
}

module.exports = {
  FONT,
  FONT_LIGHT,
  W_PORTRAIT,
  W_LANDSCAPE,
  H_LANDSCAPE,
  gridToXml,
  title,
  anchor,
  withExtraLines,
  daysGrid,
  dayTableXml,
  generalPlanningPages,
  turnosXml,
  sheetsToXml,
  nombresTexto,
  cellParas,
};
