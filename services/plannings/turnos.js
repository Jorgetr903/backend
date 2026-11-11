// services/plannings/turnos.js
//
// Tabla de turnos: una fila por monitor, una columna por día; en cada celda,
// una tarea por línea. La NEGRITA marca al responsable:
//   - si entre los monitores de una tarea hay alguno en negrita, el
//     responsable es solo el/los que están en negrita;
//   - si ninguno está en negrita, son todos;
//   - si no se puede relacionar con seguridad la tarea con el horario,
//     queda pendiente de revisión (nunca se elige "por intuición").

const { loadWorkbook, cellLines, dayToken } = require("./xlsxReader");
const { norm, tokens, ratio } = require("./textutil");

const ALIASES = [
  [/\bquiosco\b/g, "kiosko"],
  [/\baerobic\b/g, "aerobic"],
  [/\bdemontaje\b/g, "desmontaje"],
];

function taskKey(text) {
  let n = norm(text);
  for (const [re, to] of ALIASES) n = n.replace(re, to);
  return n;
}

async function parseTurnos(buffer) {
  const wb = await loadWorkbook(buffer);
  const warnings = [];
  let best = null;
  for (const ws of wb.worksheets) {
    const maxRow = Math.min(ws.rowCount, 400);
    const maxCol = Math.min(ws.columnCount, 60);
    // fila de cabecera: la que tiene más etiquetas de día
    for (let r = 1; r <= maxRow; r++) {
      const cols = [];
      for (let c = 1; c <= maxCol; c++) {
        const t = cellLines(ws.getCell(r, c))
          .map((l) => l.text)
          .join(" ");
        const d = dayToken(t);
        if (d) cols.push({ c, ...d });
      }
      if (cols.length >= 3 && (!best || cols.length > best.cols.length)) best = { ws, r, cols };
      if (best && best.ws === ws && cols.length >= 3) break;
    }
  }
  if (!best) {
    return {
      days: [],
      monitors: [],
      warnings: ["No se ha encontrado la cabecera de días en la tabla de turnos (esperaba L20, M21...)."],
    };
  }
  const { ws, r: hr, cols } = best;
  const nameCol = Math.min(...cols.map((x) => x.c)) - 1;
  const monitors = [];
  let blank = 0;
  for (let r = hr + 1; r <= Math.min(ws.rowCount, hr + 200); r++) {
    const name = cellLines(ws.getCell(r, nameCol))
      .map((l) => l.text)
      .join(" ")
      .trim();
    let hasTask = false;
    const cells = {};
    for (const col of cols) {
      const lines = cellLines(ws.getCell(r, col.c));
      if (lines.length) {
        hasTask = true;
        cells[col.label] = lines.map((l) => ({ task: l.text, key: taskKey(l.text), bold: l.bold }));
      }
    }
    if (!name && !hasTask) {
      blank++;
      if (blank >= 2) break;
      continue;
    }
    blank = 0;
    if (!name) {
      warnings.push(`Hay turnos en la fila ${r} sin nombre de monitor; se ignoran.`);
      continue;
    }
    monitors.push({ name, cells });
  }
  // nombres repetidos
  const seen = new Map();
  for (const m of monitors) {
    const k = norm(m.name);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) warnings.push(`El monitor "${k}" aparece ${n} veces en la tabla de turnos.`);
  return { days: cols.map((c) => c.label), monitors, warnings };
}

// ───────────────────────── Resolución de responsables ─────────────────────────

/** ¿la tarea (clave normalizada) corresponde a este texto del horario? */
function taskMatchesText(taskNorm, textNorm) {
  const tt = tokens(taskNorm);
  if (!tt.length) return false;
  const words = norm(textNorm).split(" ");
  const raw = taskNorm.split(" ").filter((w) => w.length > 0 && !["de", "del", "la", "el", "y"].includes(w));
  if (!raw.length) return false;
  if (raw.length === 1 && raw[0].length < 4) return false; // "g3", "tl"... no se intentan emparejar
  const close = (a, b) => {
    if (b.startsWith(a) || (a.length >= 5 && a.startsWith(b) && b.length >= 4)) return true;
    return a.length >= 5 && b.length >= 5 && ratio(a, b) >= 0.8;
  };
  return raw.every((rw) => words.some((w) => close(rw, w)));
}

const SLOT_RE = /^act (manana|tarde|noche)(?: (\d))?$/;

function slotOfTask(key) {
  const m = SLOT_RE.exec(key.replace(/\bactividad\b/, "act").replace(/\s+/g, " "));
  if (!m) return null;
  return { part: m[1], n: m[2] ? parseInt(m[2], 10) : null };
}

function minutesOf(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return (h < 6 ? h + 24 : h) * 60 + m;
}

function chooseNames(entries) {
  const bold = entries.filter((e) => e.bold);
  if (bold.length) return { names: bold.map((e) => e.name), basis: "negrita" };
  return { names: entries.map((e) => e.name), basis: "todos" };
}

/**
 * Para un día, relaciona las tareas de la tabla de turnos con los elementos
 * del horario (actividades, oraciones, olimpiadas...).
 * @returns {{byItem: Object, servicios: Array}}
 */
function resolveDay(turnos, dayLabel, items) {
  // tareas del día: key -> {display, entries:[{name,bold}]}
  const tasks = new Map();
  for (const m of turnos.monitors) {
    for (const t of m.cells[dayLabel] || []) {
      if (!t.key) continue;
      if (!tasks.has(t.key)) tasks.set(t.key, { key: t.key, display: t.task.trim(), entries: [] });
      tasks.get(t.key).entries.push({ name: m.name, bold: t.bold });
    }
  }
  const consumed = new Set();
  const byItem = {};

  const assign = (item, taskKeys, how) => {
    const entries = [];
    const used = [];
    for (const k of taskKeys) {
      const tk = tasks.get(k);
      if (!tk) continue;
      used.push(k);
      for (const e of tk.entries) if (!entries.some((x) => x.name === e.name)) entries.push(e);
    }
    if (!used.length) return false;
    used.forEach((k) => consumed.add(k));
    const chosen = chooseNames(entries);
    byItem[item.key] = {
      ...chosen,
      status: "ok",
      how,
      tasks: used.map((k) => tasks.get(k).display),
      candidates: entries.map((e) => ({ name: e.name, bold: e.bold })),
    };
    return true;
  };

  const directed = new Set();

  // 1. Oraciones
  for (const it of items) {
    if (it.type === "oracion_dia") {
      if (assign(it, ["oracion"].filter((k) => tasks.has(k)), "oracion")) directed.add(it.key);
    } else if (it.type === "oracion_noche" || it.type === "oracion_monitores") {
      if (assign(it, ["oracion noche"].filter((k) => tasks.has(k)), "oracion noche")) directed.add(it.key);
    }
  }
  // 2. Coincidencia directa por nombre (olimpiadas, día temático, mask singer, túnel...)
  for (const it of items) {
    if (directed.has(it.key)) continue;
    if (it.type !== "actividad" && it.type !== "especial") continue;
    const tn = norm(it.text);
    const matching = [];
    for (const [k] of tasks) {
      if (SLOT_RE.test(k) || k === "velada" || k === "oracion" || k === "oracion noche") continue;
      if (taskMatchesText(k, tn)) matching.push(k);
    }
    if (matching.length && assign(it, matching, "nombre")) directed.add(it.key);
  }
  // 3. Franjas: mañana / tarde (1, 2...) / velada
  const slotItems = items.filter((it) => it.type === "actividad" && !directed.has(it.key));
  const part = (it) => {
    const m = minutesOf(it.time);
    if (m < 14 * 60) return "manana";
    if (m < 21 * 60) return "tarde";
    return "velada";
  };
  for (const p of ["manana", "tarde", "velada"]) {
    const list = slotItems.filter((it) => part(it) === p);
    list.forEach((it, idx) => {
      const n = idx + 1;
      const keys = [];
      for (const [k] of tasks) {
        if (p === "velada") {
          if (k === "velada") keys.push(k);
          continue;
        }
        const s = slotOfTask(k);
        if (!s || s.part !== p) continue;
        if (s.n === n) keys.push(k);
        else if (s.n == null && list.length === 1) keys.push(k);
      }
      const ambiguous = [];
      if (list.length > 1) {
        for (const [k] of tasks) {
          if (p === "velada" && k === "velada") ambiguous.push(k);
          const s = slotOfTask(k);
          if (s && s.part === p && s.n == null) ambiguous.push(k);
        }
      }
      if (keys.length) assign(it, keys, "franja");
      else if (ambiguous.length) {
        byItem[it.key] = {
          names: [],
          basis: null,
          status: "dudoso",
          how: "franja",
          tasks: ambiguous.map((k) => tasks.get(k).display),
          candidates: ambiguous.flatMap((k) => tasks.get(k).entries.map((e) => ({ name: e.name, bold: e.bold }))),
          motivo: `El día tiene ${list.length} actividades en esa franja y la tarea de turnos no indica cuál es (p. ej. "Act. ${
            p === "manana" ? "mañana" : p
          } 1/2").`,
        };
      }
    });
  }

  // 4. El resto de tareas se muestran como "turnos del día"
  const servicios = [];
  for (const [k, t] of tasks) {
    if (consumed.has(k)) continue;
    const chosen = chooseNames(t.entries);
    servicios.push({ task: t.display, key: k, names: chosen.names, basis: chosen.basis, candidates: t.entries });
  }
  servicios.sort((a, b) => a.task.localeCompare(b.task, "es"));
  return { byItem, servicios };
}

module.exports = { parseTurnos, resolveDay, taskKey, chooseNames };
