// services/plannings/docinfo.js
// Información ligera de los documentos Word (sin construir un DOM completo):
// primeros textos, título y si trae páginas apaisadas.

const JSZip = require("jszip");

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** Texto de cada párrafo (los vacíos se descartan) */
function paragraphTexts(xml, max = 400) {
  const out = [];
  const re = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml)) && out.length < max) {
    const para = m[0];
    const t = [];
    const tre = /<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g;
    let tm;
    while ((tm = tre.exec(para))) t.push(tm[1] !== undefined ? decodeXml(tm[1]) : " ");
    const s = t.join("").replace(/[​‌‍﻿]/g, "").replace(/\s+/g, " ").trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ok:boolean, error?:string, title?:string, paragraphs?:string[], landscape?:boolean, images?:number, tables?:number}>}
 */
async function readDocxInfo(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const f = zip.file("word/document.xml");
    if (!f) return { ok: false, error: "No es un documento Word (.docx) válido" };
    const xml = await f.async("string");
    const paragraphs = paragraphTexts(xml);
    const sizes = [...xml.matchAll(/<w:pgSz[^>]*>/g)].map((x) => x[0]);
    const landscape = sizes.some((s) => /w:orient="landscape"/.test(s));
    return {
      ok: true,
      title: paragraphs[0] || "",
      paragraphs: paragraphs.slice(0, 12),
      landscape,
      images: (xml.match(/<w:drawing>/g) || []).length,
      tables: (xml.match(/<w:tbl>/g) || []).length,
      bytes: buffer.length,
    };
  } catch (e) {
    return { ok: false, error: "Archivo dañado o no es un .docx: " + e.message };
  }
}

module.exports = { readDocxInfo };
