// services/plannings/pdfpages.js
// Convierte las páginas de un PDF en imágenes JPEG para incrustarlas en el
// Word del planning. Las actividades y dinámicas de la app se guardan como
// PDF: así se conserva su aspecto exacto (aunque no sean texto editable).
// Todo se hace en local con pdf.js + @napi-rs/canvas (sin servicios externos).

const path = require("path");
const fs = require("fs");

const TARGET_SHORT_SIDE_PX = 1000; // ≈120 ppp en un A4: legible y mucho más ligero
const JPEG_QUALITY = 70;
const MAX_PAGES = 150;

let libs = null;
async function load() {
  if (libs) return libs;
  // Se usa la misma copia de @napi-rs/canvas que pdf.js (si hubiera dos copias nativas, el proceso se cierra al pintar imágenes)
  const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const napi = require(require.resolve("@napi-rs/canvas", { paths: [pdfRoot] }));
  // pdf.js en Node necesita estos objetos globales del lienzo
  globalThis.Path2D = napi.Path2D;
  globalThis.DOMMatrix = napi.DOMMatrix;
  globalThis.ImageData = napi.ImageData;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  libs = {
    napi,
    pdfjs,
    standardFontDataUrl: path.join(pdfRoot, "standard_fonts") + path.sep,
    cMapUrl: path.join(pdfRoot, "cmaps") + path.sep,
  };
  return libs;
}

function isPdf(buf) {
  return !!buf && buf.length > 8 && buf.subarray(0, 1024).toString("latin1").includes("%PDF-");
}

/**
 * Renderiza las páginas de un PDF a JPEG y las guarda en `outDir`.
 * @returns {Promise<{pages:{file:string,w:number,h:number,landscape:boolean}[], truncated:boolean}>}
 */
async function renderPdfToDir(buffer, outDir, prefix) {
  if (!isPdf(buffer)) throw new Error("el archivo no es un PDF válido");
  const { napi, pdfjs, standardFontDataUrl, cMapUrl } = await load();
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (e && e.name === "PasswordException") throw new Error("el PDF está protegido con contraseña");
    throw new Error(`no se ha podido abrir el PDF (${String((e && e.message) || e).slice(0, 100)})`);
  }
  const pages = [];
  try {
    const n = Math.min(doc.numPages, MAX_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const scale = Math.min(3, TARGET_SHORT_SIDE_PX / Math.min(v1.width, v1.height));
      const vp = page.getViewport({ scale });
      const w = Math.max(1, Math.round(vp.width));
      const h = Math.max(1, Math.round(vp.height));
      const canvas = napi.createCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
      const file = path.join(outDir, `${prefix}-${String(i).padStart(3, "0")}.jpg`);
      fs.writeFileSync(file, canvas.toBuffer("image/jpeg", JPEG_QUALITY), { mode: 0o600 });
      pages.push({ file, w, h, landscape: w > h });
      page.cleanup();
    }
    return { pages, truncated: doc.numPages > MAX_PAGES, total: doc.numPages };
  } finally {
    try {
      await doc.destroy();
    } catch (_) {}
  }
}

/** Número de páginas y orientación de la primera, sin renderizar (para validar al subir) */
async function pdfInfo(buffer) {
  if (!isPdf(buffer)) return { ok: false, error: "no es un PDF válido" };
  try {
    const { pdfjs } = await load();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).promise;
    const out = { ok: true, pages: doc.numPages };
    await doc.destroy();
    return out;
  } catch (e) {
    if (e && e.name === "PasswordException") return { ok: false, error: "el PDF está protegido con contraseña" };
    return { ok: false, error: `no se puede leer el PDF (${String((e && e.message) || e).slice(0, 100)})` };
  }
}

module.exports = { renderPdfToDir, pdfInfo, isPdf, MAX_PAGES };
