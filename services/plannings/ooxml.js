// services/plannings/ooxml.js
//
// Constantes y pequeños generadores de XML WordprocessingML.
// Todo el contenido que genera la aplicación (portada, índice, tablas
// horarias, tablas de turnos...) se construye con estas funciones.

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
};

// Prefijos que se declaran siempre en la raíz del documento final.
// Se completan con los prefijos que aporte cada documento fuente.
const BASE_PREFIXES = {
  w: NS.w,
  r: NS.r,
  wp: NS.wp,
  a: NS.a,
  pic: NS.pic,
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  o: "urn:schemas-microsoft-com:office:office",
  v: "urn:schemas-microsoft-com:vml",
  w10: "urn:schemas-microsoft-com:office:word",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  wne: "http://schemas.microsoft.com/office/word/2006/wordml",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  wpg: "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
  wp14: "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
};

// Página A4 vertical (twips)
const PAGE = { w: 11906, h: 16838 };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // caracteres de control no permitidos en XML 1.0
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** Un "run" de texto. opts: bold, italic, size (pt), color, font, caps */
function run(text, opts = {}) {
  const rpr = [];
  if (opts.font) rpr.push(`<w:rFonts w:ascii="${esc(opts.font)}" w:hAnsi="${esc(opts.font)}" w:cs="${esc(opts.font)}"/>`);
  if (opts.bold) rpr.push("<w:b/><w:bCs/>");
  if (opts.italic) rpr.push("<w:i/><w:iCs/>");
  if (opts.caps) rpr.push("<w:caps/>");
  if (opts.color) rpr.push(`<w:color w:val="${esc(opts.color)}"/>`);
  if (opts.size) rpr.push(`<w:sz w:val="${Math.round(opts.size * 2)}"/><w:szCs w:val="${Math.round(opts.size * 2)}"/>`);
  if (opts.underline) rpr.push('<w:u w:val="single"/>');
  const props = rpr.length ? `<w:rPr>${rpr.join("")}</w:rPr>` : "";
  // soporta saltos de línea dentro del texto
  const parts = String(text == null ? "" : text).split(/\r?\n/);
  const inner = parts
    .map((p, i) => (i > 0 ? "<w:br/>" : "") + `<w:t xml:space="preserve">${esc(p)}</w:t>`)
    .join("");
  return `<w:r>${props}${inner}</w:r>`;
}

/** Un párrafo. opts: style, align, before, after, keepNext, bookmark, runs (xml ya construido), tabs */
function para(content, opts = {}) {
  const ppr = [];
  if (opts.style) ppr.push(`<w:pStyle w:val="${esc(opts.style)}"/>`);
  if (opts.keepNext) ppr.push("<w:keepNext/>");
  if (opts.pageBreakBefore) ppr.push("<w:pageBreakBefore/>");
  if (opts.tabs) ppr.push(`<w:tabs>${opts.tabs}</w:tabs>`);
  if (opts.before != null || opts.after != null || opts.line != null || opts.lineExact != null) {
    ppr.push(
      `<w:spacing w:before="${opts.before || 0}" w:after="${opts.after || 0}"${
        opts.lineExact != null
          ? ` w:line="${opts.lineExact}" w:lineRule="exact"`
          : opts.line != null
          ? ` w:line="${opts.line}" w:lineRule="auto"`
          : ""
      }/>`
    );
  }
  if (opts.indent) ppr.push(`<w:ind w:left="${opts.indent}"/>`);
  if (opts.align) ppr.push(`<w:jc w:val="${esc(opts.align)}"/>`);
  if (opts.sectPr) ppr.push(opts.sectPr);
  const props = ppr.length ? `<w:pPr>${ppr.join("")}</w:pPr>` : "";
  const bm = opts.bookmark
    ? `<w:bookmarkStart w:id="${opts.bookmark.id}" w:name="${esc(opts.bookmark.name)}"/><w:bookmarkEnd w:id="${opts.bookmark.id}"/>`
    : "";
  return `<w:p>${props}${bm}${content || ""}</w:p>`;
}

/**
 * Celda de tabla. opts: width (twips), span, vMerge ("restart"|"continue"),
 * fill (hex), borders (bool), valign, margins
 */
function cell(content, opts = {}) {
  const pr = [];
  if (opts.width) pr.push(`<w:tcW w:w="${Math.round(opts.width)}" w:type="dxa"/>`);
  if (opts.span && opts.span > 1) pr.push(`<w:gridSpan w:val="${opts.span}"/>`);
  if (opts.vMerge === "restart") pr.push('<w:vMerge w:val="restart"/>');
  if (opts.vMerge === "continue") pr.push("<w:vMerge/>");
  if (opts.fill) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${esc(opts.fill)}"/>`);
  if (opts.valign) pr.push(`<w:vAlign w:val="${esc(opts.valign)}"/>`);
  const body = content && content.trim() ? content : "<w:p/>";
  return `<w:tc><w:tcPr>${pr.join("")}</w:tcPr>${body}</w:tc>`;
}

function row(cells, opts = {}) {
  const pr = [];
  if (opts.header) pr.push("<w:tblHeader/>");
  if (opts.cantSplit !== false) pr.push("<w:cantSplit/>");
  if (opts.height) pr.push(`<w:trHeight w:val="${opts.height}" w:hRule="atLeast"/>`);
  return `<w:tr>${pr.length ? `<w:trPr>${pr.join("")}</w:trPr>` : ""}${cells.join("")}</w:tr>`;
}

/** Tabla con rejilla fija. widths: array de anchos (twips). */
function table(rows, widths, opts = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const bsz = opts.borderSize || 4;
  const bcol = opts.borderColor || "000000";
  const borders = opts.noBorders
    ? ""
    : `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
        .map((b) => `<w:${b} w:val="single" w:sz="${bsz}" w:space="0" w:color="${bcol}"/>`)
        .join("")}</w:tblBorders>`;
  const mar = opts.cellMargin != null ? opts.cellMargin : 40;
  const marx = opts.cellMarginX != null ? opts.cellMarginX : mar + 40;
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:top w:w="${mar}" w:type="dxa"/><w:left w:w="${marx}" w:type="dxa"/>` +
    `<w:bottom w:w="${mar}" w:type="dxa"/><w:right w:w="${marx}" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${Math.round(w)}"/>`).join("")}</w:tblGrid>` +
    rows.join("") +
    "</w:tbl>"
  );
}

module.exports = { NS, BASE_PREFIXES, PAGE, esc, run, para, cell, row, table };
