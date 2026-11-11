// services/plannings/renderers.js
// Convierte datos de Excel (horario, turnos, tablas genéricas) en tablas Word
// siempre en vertical (A4, ancho útil 9638 twips).

const { esc, run, para, cell, row, table } = require("./ooxml");
const { loadWorkbook, cellLines, colorOf, mergeIndex } = require("./xlsxReader");

const TEXT_W = 9638;

function lightFill(hex) {
  // el color de fondo se conserva tal cual (sin el canal alfa)
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
}

function cellParas(lines, size = 8.5, opts = {}) {
  if (!lines || !lines.length) return "";
  return lines
    .map((l) =>
      para(run(l.text, { bold: l.bold || opts.bold, size, font: "Arial", color: opts.color }), {
        after: 0,
        align: opts.align,
      })
    )
    .join("");
}

/**
 * Pinta una rejilla con celdas combinadas.
 * grid: filas de celdas {lines, fill, rowspan, colspan, covered}
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
        cell(cellParas(g.lines, size, { align: g.align, bold: g.forceBold }), {
          width: w,
          span,
          fill,
          vMerge: rs > 1 ? "restart" : undefined,
          valign: "center",
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
    rows.push(row(cells, { header: opts.headerRows && ri < opts.headerRows, height: opts.minHeight }));
  });
  return table(rows, widths, { borderSize: 4, borderColor: opts.borderColor || "7F7F7F", cellMargin: 25 });
}

// ───────────────────────── Horario de un día ─────────────────────────

function timetableXml(day) {
  const widths = [820, 0, 0, 0];
  const rest = (TEXT_W - widths[0]) / 3;
  widths[1] = widths[2] = Math.floor(rest);
  widths[3] = TEXT_W - widths[0] - widths[1] - widths[2];
  const grid = day.rows.map((r) => [
    { lines: r.time ? [{ text: r.time, bold: true }] : [], rowspan: 1, colspan: 1, fill: "F2F2F2", align: "center" },
    ...r.cells,
  ]);
  return gridToXml(grid, widths, { size: 8.5 });
}

// ───────────────────────── Turnos ─────────────────────────

function turnosXml(turnos, maxDays = 6) {
  const out = [];
  const days = turnos.days;
  for (let i = 0; i < days.length; i += maxDays) {
    const chunk = days.slice(i, i + maxDays);
    const nameW = 1300;
    const dayW = Math.floor((TEXT_W - nameW) / chunk.length);
    const widths = [nameW, ...chunk.map(() => dayW)];
    widths[widths.length - 1] += TEXT_W - widths.reduce((a, b) => a + b, 0);
    const grid = [];
    grid.push([
      { lines: [{ text: "MONITOR", bold: true }], fill: "D9D9D9", align: "center" },
      ...chunk.map((d) => ({ lines: [{ text: d, bold: true }], fill: "D9D9D9", align: "center" })),
    ]);
    for (const m of turnos.monitors) {
      grid.push([
        { lines: [{ text: m.name, bold: true }], fill: "F2F2F2" },
        ...chunk.map((d) => ({
          lines: (m.cells[d] || []).map((t) => ({ text: t.task, bold: t.bold })),
        })),
      ]);
    }
    out.push(
      para(run(`TABLA DE TURNOS${days.length > maxDays ? ` (${Math.floor(i / maxDays) + 1}/${Math.ceil(days.length / maxDays)})` : ""}`, { bold: true, size: 12, font: "Arial" }), {
        after: 120,
        keepNext: true,
      }) + gridToXml(grid, widths, { size: 7.5, headerRows: 1 }) + para("", { after: 200 })
    );
  }
  return out.join("");
}

// ───────────────────────── Hoja de Excel genérica ─────────────────────────

/**
 * Convierte una hoja cualquiera (contactos, alergias, menú...) en tablas.
 * Las tablas anchas se parten en bloques de columnas repitiendo la primera.
 */
async function sheetsToXml(buffer, { maxCols = 7, size = 8, maxRows = 400 } = {}) {
  const wb = await loadWorkbook(buffer);
  const parts = [];
  const warnings = [];
  for (const ws of wb.worksheets) {
    const merges = mergeIndex(ws);
    const R = Math.min(ws.rowCount, maxRows);
    const C = Math.min(ws.columnCount, 40);
    if (ws.rowCount > maxRows) warnings.push(`La hoja "${ws.name}" tiene más de ${maxRows} filas; se han incluido las primeras ${maxRows}.`);
    // cuadro delimitador del contenido
    let r1 = 1e9, r2 = 0, c1 = 1e9, c2 = 0;
    for (let r = 1; r <= R; r++)
      for (let c = 1; c <= C; c++) {
        const lines = cellLines(ws.getCell(r, c));
        if (lines.some((l) => l.text.trim())) {
          r1 = Math.min(r1, r); r2 = Math.max(r2, r); c1 = Math.min(c1, c); c2 = Math.max(c2, c);
        }
      }
    if (r2 === 0) continue;
    const cols = [];
    for (let c = c1; c <= c2; c++) {
      let any = false;
      for (let r = r1; r <= r2 && !any; r++) any = cellLines(ws.getCell(r, c)).some((l) => l.text.trim());
      if (any) cols.push(c);
    }
    const chunked = cols.length > maxCols;
    const groups = [];
    if (!chunked) groups.push(cols);
    else {
      const first = cols[0];
      const rest = cols.slice(1);
      const per = maxCols - 1;
      for (let i = 0; i < rest.length; i += per) groups.push([first, ...rest.slice(i, i + per)]);
    }
    const title = wb.worksheets.length > 1 ? para(run(ws.name, { bold: true, size: 11, font: "Arial" }), { after: 80, keepNext: true }) : "";
    groups.forEach((g, gi) => {
      const widths = g.map(() => Math.floor(TEXT_W / g.length));
      widths[widths.length - 1] += TEXT_W - widths.reduce((a, b) => a + b, 0);
      const grid = [];
      for (let r = r1; r <= r2; r++) {
        const rowCells = [];
        let empty = true;
        g.forEach((c, k) => {
          const cellObj = ws.getCell(r, c);
          const lines = cellLines(cellObj).filter((l) => l.text.length);
          if (lines.length) empty = false;
          const m = merges.get(`${r},${c}`);
          let covered = false, rowspan = 1, colspan = 1;
          if (m && !chunked) {
            if (m.r1 !== r || m.c1 !== c) covered = true;
            else {
              rowspan = Math.min(m.r2, r2) - r + 1;
              colspan = g.filter((x) => x >= m.c1 && x <= m.c2).length || 1;
            }
          }
          rowCells.push({ lines: covered ? [] : lines, fill: colorOf(cellObj.fill), rowspan, colspan, covered });
        });
        if (!empty || rowCells.some((x) => x.covered)) grid.push(rowCells);
      }
      parts.push(
        (gi === 0 ? title : para(run(`${ws.name} (continuación ${gi + 1}/${groups.length})`, { italic: true, size: 9, font: "Arial" }), { after: 80, keepNext: true })) +
          gridToXml(grid, widths, { size }) +
          para("", { after: 160 })
      );
    });
  }
  return { xml: parts.join(""), warnings };
}

// ───────────────────────── Piezas pequeñas ─────────────────────────

function heading(text, { bookmark, size = 16, pageBreakBefore } = {}) {
  return para(run(text, { bold: true, size, font: "Arial" }), { style: "PlDia", bookmark, after: 140, keepNext: true, pageBreakBefore });
}

function simpleTable(headers, rows, widths, { size = 8.5, fills = {} } = {}) {
  const w = widths.map((x) => Math.round((x / widths.reduce((a, b) => a + b, 0)) * TEXT_W));
  w[w.length - 1] += TEXT_W - w.reduce((a, b) => a + b, 0);
  const grid = [headers.map((h) => ({ lines: [{ text: h, bold: true }], fill: "D9D9D9" }))];
  for (const r of rows) {
    grid.push(
      r.map((v, i) => ({
        lines: String(v == null ? "" : v)
          .split("\n")
          .map((t) => ({ text: t, bold: false })),
        fill: fills[i],
      }))
    );
  }
  return gridToXml(grid, w, { size, headerRows: 1 });
}

module.exports = { TEXT_W, gridToXml, timetableXml, turnosXml, sheetsToXml, heading, simpleTable, cellParas };
