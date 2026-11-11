// services/plannings/matcher.js
// Emparejamiento difuso actividad (texto del horario) ↔ documento Word.
// Niveles de confianza: clara / probable / dudosa / sin coincidencia.

const { similarity, norm } = require("./textutil");

const TIERS = { clara: 0.85, probable: 0.65, dudosa: 0.45 };

function tier(score) {
  if (score >= TIERS.clara) return "clara";
  if (score >= TIERS.probable) return "probable";
  if (score >= TIERS.dudosa) return "dudosa";
  return "sin_coincidencia";
}

/** Texto del horario sin paréntesis finales tipo "(J2)" ni adornos */
function cleanActivityText(t) {
  return String(t || "")
    .replace(/\((?:j|jornada)\s*\d+\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreAgainst(text, doc) {
  const names = [doc.nombre, doc.titulo].filter(Boolean);
  let best = 0;
  for (const n of names) best = Math.max(best, similarity(text, n));
  return best;
}

/** Mejores candidatos de un texto entre los documentos de actividades */
function candidates(text, docs, limit = 3) {
  const t = cleanActivityText(text);
  return docs
    .map((d) => ({ docId: d.id, nombre: d.nombre, score: Math.round(scoreAgainst(t, d) * 100) / 100 }))
    .filter((c) => c.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function isSpecialDoc(doc, special) {
  const n = norm(`${doc.nombre} ${doc.titulo || ""}`);
  if (special === "olimpiadas") return /olimpiad/.test(n);
  if (special === "tld") return /(tl dirigido|tiempo libre dirigido|\btld\b|tiempo libre)/.test(n);
  return false;
}

/**
 * Empareja un elemento del horario.
 * Si el texto es "A + B" y no encaja entero, se intenta por partes.
 * @returns {{docIds:string[], confidence:string, score:number, candidates:object[]}}
 */
function matchItem(item, docs) {
  if (item.special) {
    const hit = docs.filter((d) => isSpecialDoc(d, item.special));
    if (hit.length === 1) return { docIds: [hit[0].id], confidence: "clara", score: 1, candidates: [] };
    if (hit.length > 1)
      return {
        docIds: [],
        confidence: "dudosa",
        score: 0.5,
        candidates: hit.map((d) => ({ docId: d.id, nombre: d.nombre, score: 0.5 })),
        motivo: "Hay varios documentos posibles",
      };
    return { docIds: [], confidence: "sin_coincidencia", score: 0, candidates: [] };
  }
  const cands = candidates(item.text, docs);
  const top = cands[0];
  if (top && top.score >= TIERS.probable) {
    return { docIds: [top.docId], confidence: tier(top.score), score: top.score, candidates: cands };
  }
  // por partes
  const parts = cleanActivityText(item.text)
    .split(/\s*\+\s*/)
    .filter(Boolean);
  if (parts.length > 1) {
    const found = [];
    let min = 1;
    for (const part of parts) {
      const c = candidates(part, docs, 1)[0];
      if (c && c.score >= TIERS.probable && !found.includes(c.docId)) {
        found.push(c.docId);
        min = Math.min(min, c.score);
      }
    }
    if (found.length) {
      const parcial = found.length < parts.length;
      // si alguna parte se queda sin documento, se pide revisión
      return { docIds: found, confidence: parcial ? "dudosa" : tier(min), score: min, candidates: cands, parcial };
    }
  }
  if (top && top.score >= TIERS.dudosa) {
    return { docIds: [top.docId], confidence: "dudosa", score: top.score, candidates: cands };
  }
  return { docIds: [], confidence: "sin_coincidencia", score: top ? top.score : 0, candidates: cands };
}

module.exports = { matchItem, candidates, tier, TIERS, cleanActivityText, isSpecialDoc };
