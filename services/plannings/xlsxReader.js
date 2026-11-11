// services/plannings/xlsxReader.js
//
// Lectura de libros Excel conservando lo importante para los plannings:
// texto de cada celda, NEGRITA (incluida la negrita parcial dentro de una
// celda, p. ej. "Servir\n**Act. tarde**\nBaños"), colores de fondo y celdas
// combinadas.

const ExcelJS = require("exceljs");

/** Divide el contenido de una celda en líneas con su negrita. */
function cellLines(cell) {
  const v = cell.value;
  const cellBold = !!(cell.font && cell.font.bold);
  // lista de fragmentos {text, bold}
  let parts = [];
  if (v == null) return [];
  if (typeof v === "object" && Array.isArray(v.richText)) {
    parts = v.richText.map((r) => ({
      text: r.text || "",
      bold: r.font && r.font.bold !== undefined ? !!r.font.bold : cellBold,
    }));
  } else if (v instanceof Date) {
    return [];
  } else if (typeof v === "object" && v.result !== undefined) {
    parts = [{ text: String(v.result), bold: cellBold }];
  } else if (typeof v === "object" && v.text !== undefined) {
    parts = [{ text: String(v.text), bold: cellBold }];
  } else {
    parts = [{ text: String(v), bold: cellBold }];
  }
  // trocear por saltos de línea
  const lines = [{ text: "", boldChars: 0, chars: 0 }];
  for (const p of parts) {
    const segs = p.text.split(/\r?\n/);
    segs.forEach((seg, i) => {
      if (i > 0) lines.push({ text: "", boldChars: 0, chars: 0 });
      const cur = lines[lines.length - 1];
      cur.text += seg;
      const n = seg.replace(/\s/g, "").length;
      cur.chars += n;
      if (p.bold) cur.boldChars += n;
    });
  }
  return lines
    .map((l) => ({
      text: l.text.replace(/\s+/g, " ").trim(),
      // una línea cuenta como negrita si lo es la mayoría de sus caracteres visibles
      bold: l.chars > 0 && l.boldChars / l.chars >= 0.5,
    }))
    .filter((l) => l.text);
}

function plainText(cell) {
  return cellLines(cell)
    .map((l) => l.text)
    .join("\n");
}

function colorOf(fill) {
  if (!fill || fill.type !== "pattern" || fill.pattern !== "solid") return null;
  const c = fill.fgColor;
  if (c && c.argb && c.argb.length === 8) {
    const hex = c.argb.slice(2).toUpperCase();
    return hex === "FFFFFF" ? null : hex;
  }
  return null;
}

function parseRange(a1) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a1);
  if (!m) return null;
  const col = (s) => s.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return { c1: col(m[1]), r1: +m[2], c2: col(m[3]), r2: +m[4] };
}

function timeOf(cell) {
  const v = cell.value;
  if (v instanceof Date) {
    const mins = Math.round((v.getUTCHours() * 60 + v.getUTCMinutes() + v.getUTCSeconds() / 60));
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  }
  if (typeof v === "number" && v >= 0 && v < 1) {
    const mins = Math.round(v * 24 * 60);
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
  }
  return null;
}

async function loadWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

/** Mapa de celdas combinadas de una hoja: "r,c" -> rango */
function mergeIndex(ws) {
  const idx = new Map();
  const merges = (ws.model && ws.model.merges) || [];
  for (const m of merges) {
    const r = parseRange(m);
    if (!r) continue;
    for (let rr = r.r1; rr <= r.r2; rr++) for (let cc = r.c1; cc <= r.c2; cc++) idx.set(`${rr},${cc}`, r);
  }
  return idx;
}

const DAY_RE = /^\s*([LMXJVSD])\s*[-_ ]?\s*(\d{1,2})\s*$/i;

function dayToken(text) {
  const m = DAY_RE.exec(text || "");
  if (!m) return null;
  const num = parseInt(m[2], 10);
  if (num < 1 || num > 31) return null;
  return { letter: m[1].toUpperCase(), num, label: `${m[1].toUpperCase()}${num}` };
}

module.exports = {
  loadWorkbook,
  cellLines,
  plainText,
  colorOf,
  timeOf,
  mergeIndex,
  parseRange,
  dayToken,
  DAY_RE,
};
