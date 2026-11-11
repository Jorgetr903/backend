// services/plannings/textutil.js
// Normalización y comparación aproximada de textos (nombres de actividades,
// nombres de archivo...).

/** Minúsculas, sin tildes ni signos, espacios colapsados */
function norm(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " y ")
    .replace(/[^a-z0-9ñ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["de", "del", "la", "las", "el", "los", "y", "e", "a", "en", "un", "una", "con", "por", "para", "al", "o", "u"]);

/** Recorta plurales/variaciones simples para comparar ("colores"~"color") */
function stem(w) {
  let t = w;
  if (t.length > 4) t = t.replace(/(es|s)$/, "");
  if (t.length > 4) t = t.replace(/(a|o)$/, "");
  return t;
}

function tokens(s) {
  return norm(s)
    .split(" ")
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function ratio(a, b) {
  const m = Math.max(a.length, b.length);
  return m ? 1 - levenshtein(a, b) / m : 1;
}

/**
 * Similitud 0..1 entre dos nombres. Combina:
 *  - coincidencia de palabras (tolerando pequeñas variaciones ortográficas)
 *  - similitud global de caracteres
 *  - contención (un nombre dentro del otro)
 */
function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return ratio(na, nb);

  // coincidencia de palabras, una a una, con tolerancia
  const used = new Set();
  let hits = 0;
  for (const x of ta) {
    let best = -1;
    let bestScore = 0;
    tb.forEach((y, i) => {
      if (used.has(i)) return;
      const s = x === y ? 1 : ratio(x, y);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    if (best >= 0 && bestScore >= 0.8) {
      used.add(best);
      hits += bestScore;
    }
  }
  const small = Math.min(ta.length, tb.length);
  const big = Math.max(ta.length, tb.length);
  const wordScore = (hits / big) * 0.5 + (hits / small) * 0.5;
  const charScore = ratio(na, nb);
  const contained = na.includes(nb) || nb.includes(na) ? Math.min(na.length, nb.length) / Math.max(na.length, nb.length) : 0;
  return Math.min(1, Math.max(wordScore * 0.8 + charScore * 0.2, contained * 0.5 + wordScore * 0.5));
}

/**
 * Corrige nombres de archivo mal codificados:
 *  - UTF-8 leído como latin1 (lo que hace multer)
 *  - secuencias "#U00d3" que dejan algunos compresores
 */
function fixFilename(name) {
  let n = String(name || "");
  n = n.replace(/#U([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (/[ÂÃ][\u0080-¿]/.test(n)) {
    try {
      const fixed = Buffer.from(n, "latin1").toString("utf8");
      if (!fixed.includes("�")) n = fixed;
    } catch (_) {
      /* se deja tal cual */
    }
  }
  return n;
}

module.exports = { norm, tokens, similarity, fixFilename, ratio };
