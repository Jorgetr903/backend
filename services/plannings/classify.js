// services/plannings/classify.js
// Interpretación de nombres de archivo: oraciones (día y tipo) y niveles.

const { norm, fixFilename } = require("./textutil");

const DAY_IN_NAME = /(?:^|[^a-z0-9])([LMXJVSD])\s*[-_]?\s*(\d{1,2})(?![0-9])/i;

/**
 * Interpreta "ORACIÓN DÍA L-27 (noche)", "ORACIÓN NOCHE D19",
 * "ORACIÓN DÍA J-23 – Título – Nombres"...
 * No asigna nunca un día "adivinando": si no encuentra un patrón claro
 * devuelve day = null.
 */
function parseOracionText(raw) {
  const text = fixFilename(raw || "").replace(/\.docx?$/i, "");
  const n = norm(text);
  const isOracion = /\boracion\b/.test(n);
  // quitamos la palabra "día" para que su "D" no se confunda con la letra del día
  const cleaned = text
    .replace(/oraci[oó]n/gi, " ")
    .replace(/\bd[ií]a\b/gi, " ")
    .replace(/\bnoche\b/gi, " ");
  let day = null;
  const m = DAY_IN_NAME.exec(cleaned);
  if (m) {
    const num = parseInt(m[2], 10);
    if (num >= 1 && num <= 31) day = `${m[1].toUpperCase()}${num}`;
  }
  const night = /\bnoche\b/.test(n);
  // título: segundo segmento separado por guiones largos / guiones con espacios
  const segs = text.split(/\s+[–—-]\s+|\s*[–—]\s*/).map((s) => s.trim()).filter(Boolean);
  let titulo = "";
  if (segs.length >= 3) titulo = segs[1];
  else if (segs.length === 2 && !/^(oraci|d[ií]a|[LMXJVSD]\s*-?\s*\d)/i.test(segs[1])) titulo = segs[1];
  return { isOracion, day, night, titulo, nombres: segs.length >= 3 ? segs[segs.length - 1] : "" };
}

/** Nivel (de entre los definidos) que aparece en el nombre del archivo */
function detectLevel(filename, niveles) {
  const n = norm(fixFilename(filename).replace(/\.docx?$/i, ""));
  const hits = [];
  for (const nivel of niveles) {
    const key = norm(nivel).replace(/\s+/g, "").slice(0, 5);
    if (key.length >= 3 && n.replace(/\s+/g, "").includes(key)) hits.push(nivel);
  }
  return hits.length === 1 ? hits[0] : hits.length > 1 ? hits : null;
}

function baseName(filename) {
  return fixFilename(filename)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/[_]+/g, " ")
    .trim();
}

/** Categoría probable según el nombre y el tipo (solo para la subida automática) */
function autoCategoria(filename) {
  const name = fixFilename(filename);
  const ext = (name.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  const n = norm(name);
  if ([".png", ".jpg", ".jpeg", ".svg"].includes(ext)) return "logo";
  if (/base de datos/.test(n)) return "base_datos";
  if (/\balergi/.test(n)) return "alergias";
  if (/\bmenu\b/.test(n)) return "menu";
  if (ext === ".xlsx") return "general";
  if (/\boracion\b/.test(n)) return "oraciones";
  if (/\bdinamicas?\b/.test(n)) return "dinamicas";
  return "actividades";
}

module.exports = { parseOracionText, detectLevel, baseName, autoCategoria };
