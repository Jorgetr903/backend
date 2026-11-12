// services/plannings/timetable.js
//
// Lee la "tabla principal del campamento" (Excel): un bloque por día con
// columnas  [hora | grupo 1 | grupo 2 | grupo 3]  y celdas combinadas.
// Los días se identifican por su etiqueta (L20, M21... = letra + número del
// día del mes), nunca por posición, de modo que sirve para cualquier año.

const { loadWorkbook, cellLines, colorOf, timeOf, mergeIndex, dayToken } = require("./xlsxReader");
const { norm } = require("./textutil");

const RAIN_RE = /^d[ií]a de lluvia$/i;

function headerKind(text) {
  const t = (text || "").trim();
  const d = dayToken(t);
  if (d) return { kind: "dia", ...d };
  if (RAIN_RE.test(t)) return { kind: "lluvia", label: "LLUVIA", letter: "", num: 0 };
  return null;
}

function parseSheet(ws) {
  const merges = mergeIndex(ws);
  const maxRow = Math.min(ws.rowCount, 600);
  const maxCol = Math.min(ws.columnCount, 60);
  const days = [];

  // 1. cabeceras
  const headers = [];
  for (let r = 1; r <= maxRow; r++) {
    for (let c = 2; c <= maxCol; c++) {
      const cell = ws.getCell(r, c);
      if (cell.value == null) continue;
      const m = merges.get(`${r},${c}`);
      if (m && (m.r1 !== r || m.c1 !== c)) continue; // celda cubierta por una combinada
      const txt = cellLines(cell)
        .map((l) => l.text)
        .join(" ");
      const h = headerKind(txt);
      if (h) headers.push({ r, c, ...h, cell });
    }
  }
  // Una misma etiqueta en filas consecutivas (celda combinada vertical) cuenta una vez
  const uniq = [];
  for (const h of headers) {
    if (uniq.some((u) => u.c === h.c && u.label === h.label && h.r - u.r <= 2)) continue;
    uniq.push(h);
  }

  // 2. bloque de cada cabecera
  for (const h of uniq) {
    const tc = h.c - 1; // columna de horas
    if (tc < 1) continue;
    // primera fila con hora (como mucho 3 filas por debajo de la cabecera)
    let start = null;
    for (let r = h.r + 1; r <= h.r + 3 && r <= maxRow; r++) {
      if (timeOf(ws.getCell(r, tc))) {
        start = r;
        break;
      }
    }
    if (!start) continue;
    let end = start;
    let blank = 0;
    for (let r = start; r <= maxRow; r++) {
      if (timeOf(ws.getCell(r, tc))) {
        end = r;
        blank = 0;
      } else {
        blank++;
        if (blank >= 1) break;
      }
    }
    // título: texto a la derecha de la etiqueta en la fila de cabecera
    let title = "";
    for (let c = h.c + 1; c <= h.c + 2; c++) {
      const cell = ws.getCell(h.r, c);
      const t = cellLines(cell)
        .map((l) => l.text)
        .join(" ")
        .trim();
      if (t && !headerKind(t)) {
        title = t;
        break;
      }
    }

    const rows = [];
    for (let r = start; r <= end; r++) {
      const cells = [];
      for (let k = 0; k < 3; k++) {
        const c = h.c + k;
        const cell = ws.getCell(r, c);
        const m = merges.get(`${r},${c}`);
        let covered = false;
        let rowspan = 1;
        let colspan = 1;
        if (m) {
          if (m.r1 !== r || m.c1 !== c) {
            covered = true;
          } else {
            rowspan = Math.min(m.r2, end) - r + 1;
            colspan = Math.min(m.c2, h.c + 2) - c + 1;
          }
        }
        const lines = covered ? [] : cellLines(cell);
        cells.push({
          lines,
          text: lines.map((l) => l.text).join("\n"),
          bold: lines.length > 0 && lines.every((l) => l.bold),
          fill: covered ? null : colorOf(cell.fill),
          rowspan,
          colspan,
          covered,
        });
      }
      rows.push({ time: timeOf(ws.getCell(r, tc)), sheetRow: r, cells });
    }
    days.push({
      kind: h.kind,
      label: h.label,
      letter: h.letter,
      num: h.num,
      title,
      sheet: ws.name,
      rows,
    });
  }
  return days;
}

/**
 * @returns {{days: object[], warnings: string[]}}
 */
async function parseTimetable(buffer) {
  const wb = await loadWorkbook(buffer);
  const perSheet = wb.worksheets.map((ws) => ({ name: ws.name, days: parseSheet(ws) })).filter((s) => s.days.length);
  const warnings = [];
  if (!perSheet.length) {
    return { days: [], warnings: ["No se han encontrado días en el Excel (esperaba cabeceras tipo L20, M21...)."] };
  }
  // Se usa la hoja con más días "normales". Las demás se ignoran avisando si duplican días.
  const score = (s) => s.days.filter((d) => d.kind === "dia").length;
  perSheet.sort((a, b) => score(b) - score(a));
  const main = perSheet[0];
  const seen = new Set(main.days.map((d) => d.label));
  for (const other of perSheet.slice(1)) {
    const dup = other.days.filter((d) => seen.has(d.label));
    if (dup.length) {
      warnings.push(
        `La hoja "${other.name}" repite días que ya están en "${main.name}" (${dup.map((d) => d.label).join(", ")}); se usa "${main.name}".`
      );
    }
    for (const d of other.days) {
      if (!seen.has(d.label)) {
        main.days.push(d);
        seen.add(d.label);
      }
    }
  }
  // Orden: por posición en la hoja (la tabla ya está en orden cronológico).
  const days = main.days.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.rows[0].sheetRow - b.rows[0].sheetRow || 0);
  // reordenar por bloques: primero por fila inicial, luego por columna
  return { days: orderDays(days), warnings };
}

function orderDays(days) {
  // Los bloques están en filas apiladas (de 7 en 7 días) y, dentro de cada
  // fila, de izquierda a derecha. Se conserva el orden de lectura.
  const normal = days.filter((d) => d.kind === "dia");
  const rain = days.filter((d) => d.kind === "lluvia");
  return [...normal, ...rain];
}

// ─────────────────────── Elementos del horario ───────────────────────

// Líneas "de rutina": no necesitan documento propio
const ROUTINE = [
  /^animadores/,
  /^buenos dias/,
  /^desayuno/,
  /^servicios?\b/,
  /^merienda/,
  /^cambio de ropa/,
  /^preparar ducha/,
  /^descansar/,
  /^cena y/,
  /^hasta que/,
  /^recogida de tiendas/,
  /^ducha/,
  /^comida/,
  /^cena$/,
  /^tl$/,
  /^tl y tl/,
  /^tiempo libre/,
  /^buenas noches/,
  /^reunion de monitores/,
  /^oracion monitores/,
  /^eucaristia/,
  /^preparacion/,
  /^salida$/,
  /^viaje al campamento/,
  /^hervir agua/,
  /^normas y funcionamiento/,
  /^tiendas/,
  /^simulacro/,
  /^quiosco/,
  /^kiosko/,
  /^llamadas/,
  /^grupo de nivel/,
  /^dinamica ?\d*/,
  /^himnos/,
  /^alarido/, // el alarido no es una actividad con documento
  /^piscin/,
  /^\(?evaluacion/,
  /^explicacion/,
  /^vuelta/,
  /^marcha/,
  /^terminar de recoger/,
  /^\.+z+/,
  /^zzz/,
];

/** Clasificación de una línea del horario */
function classifyLine(text) {
  const n = norm(text);
  if (!n) return { type: "vacio" };
  if (/^oracion de la manana/.test(n)) return { type: "oracion_dia" };
  if (n === "oracion") return { type: "oracion_noche" };
  if (/^oracion monitores/.test(n)) return { type: "oracion_monitores" };
  if (/olimpiad/.test(n)) return { type: "especial", special: "olimpiadas" };
  if (/(tl dirigido|tiempo libre dirigido|\btld\b)/.test(n)) return { type: "especial", special: "tld" };
  if (ROUTINE.some((re) => re.test(n))) return { type: "rutina" };
  return { type: "actividad" };
}

/**
 * Une las líneas de una celda que forman una sola frase
 * ("TALLER DE TEÑIR +" / "HIMNOS + BANDERA", "(autobus)", "+", ...).
 */
function mergeLines(lines) {
  const out = [];
  for (const l of lines) {
    const t = l.text.trim();
    const prev = out[out.length - 1];
    const join = prev && (/\+\s*$/.test(prev.text) || /^\+/.test(t) || /^\(/.test(t));
    if (join) {
      prev.text = `${prev.text.replace(/\s+$/, "")} ${t}`.replace(/\s+/g, " ");
      prev.bold = prev.bold && l.bold;
    } else out.push({ text: t, bold: l.bold });
  }
  return out;
}

/** Primer segmento de una línea ("A + B" -> "A") para clasificarla */
function head(text) {
  return text.split(/\s*\+\s*/)[0] || text;
}

/**
 * Extrae del horario de un día los elementos con significado:
 * actividades (que necesitan documento), oraciones y elementos especiales.
 */
function dayItems(day) {
  const items = [];
  day.rows.forEach((row, ri) => {
    row.cells.forEach((cell, ci) => {
      if (cell.covered || !cell.lines.length) return;
      const key0 = `${day.label}|${ri}|${ci}`;
      const seenKeys = new Set();
      mergeLines(cell.lines).forEach((line, li) => {
        const cls = classifyLine(head(line.text));
        if (cls.type === "vacio" || cls.type === "rutina") return;
        const canon = cls.special || cls.type;
        const dedupe = cls.type === "actividad" ? `${cls.type}:${norm(line.text)}` : canon;
        if (seenKeys.has(dedupe)) return;
        seenKeys.add(dedupe);
        items.push({
          key: `${key0}|${li}`,
          day: day.label,
          time: row.time,
          row: ri,
          col: ci,
          text: line.text.replace(/\s*\+\s*$/, "").trim(),
          bold: line.bold,
          cellText: cell.text,
          type: cls.type, // actividad | especial | oracion_dia | oracion_noche
          special: cls.special || null,
        });
      });
    });
  });
  // orden de la tabla: por hora (las de después de medianoche al final) y columna
  const minutes = (t) => {
    if (!t) return 0;
    const [h, m] = t.split(":").map(Number);
    return (h < 6 ? h + 24 : h) * 60 + m;
  };
  items.sort((a, b) => minutes(a.time) - minutes(b.time) || a.col - b.col || a.row - b.row);
  return items;
}

module.exports = { parseTimetable, dayItems, classifyLine, mergeLines };
