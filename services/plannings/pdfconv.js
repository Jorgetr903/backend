// services/plannings/pdfconv.js
//
// Convierte un PDF en CONTENIDO EDITABLE de Word (párrafos con su formato,
// tablas con celdas combinadas y colores, imágenes incrustadas). No dibuja
// las páginas como imagen: lee el texto, las líneas, los rellenos y las
// imágenes con pdf.js y reconstruye el documento.
//
// Flujo: extractPage() (datos crudos de una página) → buildPage() (bloques:
// párrafos / tablas / imágenes) → convertPdf() (documento completo, con
// grupos de páginas por orientación) → emitGroup() (XML de Word).

const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const jpeg = require("jpeg-js");
const { esc, run, para } = require("./ooxml");

const MAX_PAGES = 200;
const MAX_IMG_SIDE = 1600; // px: las imágenes grandes se reducen
const A4 = { w: 595.28, h: 841.89 };

let libs = null;
async function load() {
  if (libs) return libs;
  const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  // pdf.js en Node espera estos objetos globales del navegador. Para leer texto, tablas e imágenes no se
  // dibuja nada, así que bastan marcadores mínimos (evita cargar el motor gráfico nativo, ~50 MB).
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix { constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; } };
  if (!globalThis.Path2D) globalThis.Path2D = class Path2D {};
  if (!globalThis.ImageData) globalThis.ImageData = class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  libs = {
    pdfjs,
    standardFontDataUrl: path.join(pdfRoot, "standard_fonts") + path.sep,
    cMapUrl: path.join(pdfRoot, "cmaps") + path.sep,
  };
  return libs;
}

// ───────────────────────── utilidades geométricas ─────────────────────────

// mul(a, b): primero a y después b (convención de fila de PDF: p' = p × a × b)
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();
const rgbHex = (r, g, b) => hex2(r) + hex2(g) + hex2(b);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// ───────────────────────── extracción de una página ─────────────────────────

/** Color de relleno que dejan los operadores de color de pdf.js (argumentos ya normalizados) */
function colorFromOp(OPS, fn, args) {
  switch (fn) {
    case OPS.setFillRGBColor:
    case OPS.setStrokeRGBColor:
      return typeof args[0] === "string" ? args[0].replace("#", "").toUpperCase() : rgbHex(args[0], args[1], args[2]);
    case OPS.setFillGray:
    case OPS.setStrokeGray: {
      const v = args[0] <= 1 ? args[0] * 255 : args[0];
      return rgbHex(v, v, v);
    }
    case OPS.setFillCMYKColor:
    case OPS.setStrokeCMYKColor: {
      const [c, m, y, k] = args;
      return rgbHex(255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k));
    }
    default:
      return null;
  }
}

/** Espera (sondeando) a que pdf.js termine de decodificar una imagen; devuelve su objeto o null */
async function waitObj(page, id, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    for (const store of [page.objs, page.commonObjs]) {
      try {
        if (store.has(id)) return store.get(id);
      } catch (_) {}
    }
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** PNG sin dependencias (RGB o RGBA, 8 bits) */
function encodePng(w, h, rgba, hasAlpha) {
  const ch = hasAlpha ? 4 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = y * (w * ch + 1) + 1 + x * ch;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
      if (hasAlpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const crcT = encodePng.t || (encodePng.t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = hasAlpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Objeto de imagen de pdf.js → {buf, ext, w, h} (JPEG o PNG), reducido si es enorme */
/** Gira / voltea los píxeles según la matriz con la que se dibuja la imagen (a,b,c,d en espacio PDF, y hacia arriba) */
function orient(rgba, w, h, m) {
  const [a, b, c, d] = m;
  const small = (v, ref) => Math.abs(v) < 0.15 * Math.abs(ref);
  let mode = null; // función (i,j) destino → origen
  let nw = w, nh = h;
  if (small(b, a) && small(c, d) || (small(b, d) && small(c, a))) {
    if (a > 0 && d > 0) return { rgba, w, h };
    if (a < 0 && d < 0) mode = (i, j) => [w - 1 - i, h - 1 - j];
    else if (a > 0 && d < 0) mode = (i, j) => [i, h - 1 - j];
    else mode = (i, j) => [w - 1 - i, j];
  } else if (small(a, b) && small(d, c)) {
    nw = h; nh = w;
    if (b > 0 && c < 0) mode = (i, j) => [w - 1 - j, i]; // gira 90° a la izquierda
    else if (b < 0 && c > 0) mode = (i, j) => [j, h - 1 - i]; // gira 90° a la derecha
    else return { rgba, w, h };
  } else return { rgba, w, h };
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) {
    const [si, sj] = mode(i, j);
    const sp = (sj * w + si) * 4, dp = (j * nw + i) * 4;
    out[dp] = rgba[sp]; out[dp + 1] = rgba[sp + 1]; out[dp + 2] = rgba[sp + 2]; out[dp + 3] = rgba[sp + 3];
  }
  return { rgba: out, w: nw, h: nh };
}

function encodeImage(o, pdfjs, m) {
  let { width: w, height: h, data, kind } = o;
  if (!data || !w || !h) return null;
  const K = pdfjs.ImageKind;
  let rgba = new Uint8ClampedArray(w * h * 4);
  if (kind === K.RGBA_32BPP) rgba = data;
  else if (kind === K.RGB_24BPP) for (let i = 0, j = 0; i < w * h; i++, j += 3) { rgba[i * 4] = data[j]; rgba[i * 4 + 1] = data[j + 1]; rgba[i * 4 + 2] = data[j + 2]; rgba[i * 4 + 3] = 255; }
  else if (kind === K.GRAYSCALE_1BPP) {
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = data[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0; const i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255; }
  } else return null;
  if (m) ({ rgba, w, h } = orient(rgba, w, h, m));
  // reducción por promedio de bloques si es muy grande
  const f = Math.ceil(Math.max(w, h) / MAX_IMG_SIDE);
  if (f > 1) {
    const nw = Math.max(1, Math.floor(w / f)), nh = Math.max(1, Math.floor(h / f));
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const s = ((y * f + dy) * w + (x * f + dx)) * 4; acc[0] += rgba[s]; acc[1] += rgba[s + 1]; acc[2] += rgba[s + 2]; acc[3] += rgba[s + 3]; }
      const d = (y * nw + x) * 4; const n = f * f;
      out[d] = acc[0] / n; out[d + 1] = acc[1] / n; out[d + 2] = acc[2] / n; out[d + 3] = acc[3] / n;
    }
    rgba = out; w = nw; h = nh;
  }
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) { hasAlpha = true; break; }
  if (hasAlpha || w * h < 30000) return { buf: encodePng(w, h, rgba, hasAlpha), ext: "png", w, h };
  return { buf: Buffer.from(jpeg.encode({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width: w, height: h }, 85).data), ext: "jpg", w, h };
}

const FONT_CLEAN = [
  [/^[A-Z]{6}\+/, ""],
  [/[-,](Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Black|Semibold|Light|Medium)+.*$/i, ""],
  [/(PSMT|MT|PS)$/i, ""],
];
function familyOf(name) {
  let n = String(name || "");
  for (const [re, to] of FONT_CLEAN) n = n.replace(re, to);
  n = n.replace(/^(.*?)(Bold|Italic)+$/i, "$1");
  const map = { TimesNewRoman: "Times New Roman", ArialNarrow: "Arial Narrow", ComicSansMS: "Comic Sans MS", CourierNew: "Courier New", CenturyGothic: "Century Gothic", TrebuchetMS: "Trebuchet MS", SegoeUI: "Segoe UI", CambriaMath: "Cambria Math", Calibri: "Calibri" };
  n = map[n] || n.replace(/([a-z])([A-Z])/g, "$1 $2");
  return n || "Calibri";
}

/** Datos crudos de una página: textos con formato, segmentos, rellenos e imágenes (coordenadas en pt, y hacia abajo) */
async function extractPage(page, lib, imgCache = new Map()) {
  const { pdfjs } = lib;
  const OPS = pdfjs.OPS;
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const ol = await page.getOperatorList();

  // fuentes
  const fontInfo = new Map();
  const fontOf = (loaded) => {
    if (fontInfo.has(loaded)) return fontInfo.get(loaded);
    let fo = null;
    try { fo = page.commonObjs.has(loaded) ? page.commonObjs.get(loaded) : null; } catch (_) {}
    const raw = (fo && (fo.name || fo.fallbackName)) || "";
    const bold = !!(fo && fo.bold) || /bold|black|heavy|semibold|-bd/i.test(raw);
    const italic = !!(fo && fo.italic) || /italic|oblique|-it\b/i.test(raw);
    const info = { family: familyOf(raw), bold, italic, symbol: /symbol|wingding|webding|dingbat/i.test(raw) };
    fontInfo.set(loaded, info);
    return info;
  };

  // pasada por los operadores: colores de texto, trazos, rellenos, imágenes
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let fillColor = "000000";
  let strokeColor = "000000";
  let lineWidth = 1;
  let tm = [1, 0, 0, 1, 0, 0], lm = [1, 0, 0, 1, 0, 0];
  let fontSize = 0, charSpace = 0, wordSpace = 0, hScale = 1, leading = 0, fm = 0.001;
  const glyphs = []; // un registro por glifo visible: posición, avance, estilo
  let renderMode = 0, fontLoaded = null;
  const fills = [];
  const segs = { h: [], v: [] };
  const imgs = [];
  let path = [];
  const toPage = (x, y) => { const [px, py] = apply(ctm, x, y); return [px, H - py]; };

  const addSeg = (x1, y1, x2, y2, w, color) => {
    const [a, b] = toPage(x1, y1), [c, d] = toPage(x2, y2);
    if (Math.abs(b - d) < 0.8 && Math.abs(a - c) > 1) segs.h.push({ y: (b + d) / 2, x1: Math.min(a, c), x2: Math.max(a, c), w, color });
    else if (Math.abs(a - c) < 0.8 && Math.abs(b - d) > 1) segs.v.push({ x: (a + c) / 2, y1: Math.min(b, d), y2: Math.max(b, d), w, color });
  };
  const flushPath = (paint) => {
    const doFill = paint === "fill" || paint === "fillstroke";
    const doStroke = paint === "stroke" || paint === "fillstroke";
    for (const sp of path) {
      if (sp.rect) {
        const [x, y, w, h] = sp.rect;
        const [x0, y0] = toPage(x, y), [x1, y1] = toPage(x + w, y + h);
        const rx = Math.min(x0, x1), ry = Math.min(y0, y1), rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
        if (doFill) {
          if (rw <= 2.2 && rh > 1) segs.v.push({ x: rx + rw / 2, y1: ry, y2: ry + rh, w: Math.max(0.5, rw), color: fillColor });
          else if (rh <= 2.2 && rw > 1) segs.h.push({ y: ry + rh / 2, x1: rx, x2: rx + rw, w: Math.max(0.5, rh), color: fillColor });
          else if (rw > 2 && rh > 2) fills.push({ x: rx, y: ry, w: rw, h: rh, color: fillColor });
        }
        if (doStroke) {
          segs.h.push({ y: ry, x1: rx, x2: rx + rw, w: lineWidth, color: strokeColor });
          segs.h.push({ y: ry + rh, x1: rx, x2: rx + rw, w: lineWidth, color: strokeColor });
          segs.v.push({ x: rx, y1: ry, y2: ry + rh, w: lineWidth, color: strokeColor });
          segs.v.push({ x: rx + rw, y1: ry, y2: ry + rh, w: lineWidth, color: strokeColor });
        }
      } else if (doStroke && sp.pts.length >= 2) {
        for (let i = 1; i < sp.pts.length; i++) addSeg(sp.pts[i - 1][0], sp.pts[i - 1][1], sp.pts[i][0], sp.pts[i][1], lineWidth, strokeColor);
        if (sp.closed) addSeg(sp.pts[sp.pts.length - 1][0], sp.pts[sp.pts.length - 1][1], sp.pts[0][0], sp.pts[0][1], lineWidth, strokeColor);
      }
    }
    path = [];
  };

  const imagePending = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ctm: ctm.slice(), fillColor, strokeColor, lineWidth }); break;
      case OPS.restore: { const s = stack.pop(); if (s) ({ ctm, fillColor, strokeColor, lineWidth } = s); break; }
      case OPS.transform: ctm = mul(a, ctm); break;
      case OPS.paintFormXObjectBegin: stack.push({ ctm: ctm.slice(), fillColor, strokeColor, lineWidth }); if (a[0]) ctm = mul(a[0], ctm); break;
      case OPS.paintFormXObjectEnd: { const s = stack.pop(); if (s) ({ ctm, fillColor, strokeColor, lineWidth } = s); break; }
      case OPS.setLineWidth: lineWidth = a[0]; break;
      case OPS.setFillRGBColor: case OPS.setFillGray: case OPS.setFillCMYKColor: fillColor = colorFromOp(OPS, fn, a) || fillColor; break;
      case OPS.setStrokeRGBColor: case OPS.setStrokeGray: case OPS.setStrokeCMYKColor: strokeColor = colorFromOp(OPS, fn, a) || strokeColor; break;
      case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; lm = [1, 0, 0, 1, 0, 0]; break;
      case OPS.setTextRenderingMode: renderMode = a[0]; break;
      case OPS.setFont: fontSize = a[1]; fontLoaded = a[0]; try { const fo = page.commonObjs.has(a[0]) ? page.commonObjs.get(a[0]) : null; fm = (fo && fo.fontMatrix && fo.fontMatrix[0]) || 0.001; } catch (_) { fm = 0.001; } break;
      case OPS.setCharSpacing: charSpace = a[0]; break;
      case OPS.setWordSpacing: wordSpace = a[0]; break;
      case OPS.setHScale: hScale = a[0] / 100; break;
      case OPS.setLeading: leading = a[0]; break;
      case OPS.setTextMatrix: tm = a.slice(); lm = a.slice(); break;
      case OPS.moveText: lm = mul([1, 0, 0, 1, a[0], a[1]], lm); tm = lm.slice(); break;
      case OPS.setLeadingMoveText: leading = -a[1]; lm = mul([1, 0, 0, 1, a[0], a[1]], lm); tm = lm.slice(); break;
      case OPS.nextLine: lm = mul([1, 0, 0, 1, 0, -leading], lm); tm = lm.slice(); break;
      case OPS.showText:
      case OPS.showSpacedText: {
        const parts = fn === OPS.showText ? [a[0]] : a[0];
        for (const p of parts) {
          if (typeof p === "number") { tm = mul([1, 0, 0, 1, (-p / 1000) * fontSize * hScale, 0], tm); continue; }
          for (const g of p) {
            if (typeof g === "number") { tm = mul([1, 0, 0, 1, (-g / 1000) * fontSize * hScale, 0], tm); continue; } // ajuste de espaciado (TJ)
            const adv = (g.width || 0) * fm * fontSize * hScale + charSpace * hScale + (g.isSpace ? wordSpace * hScale : 0);
            if (renderMode !== 3 && renderMode !== 7) {
              const full = mul(tm, ctm);
              const sc = Math.hypot(full[0], full[1]);
              glyphs.push({ ch: g.unicode === undefined || g.unicode === null ? "" : g.unicode, x: full[4], y: H - full[5], adv: adv * sc, size: fontSize * sc, rot: Math.abs(full[1]) > 0.05 * sc || Math.abs(full[2]) > 0.5 * sc, color: fillColor, font: fontLoaded });
            }
            tm = mul([1, 0, 0, 1, adv, 0], tm);
          }
        }
        break;
      }
      case OPS.constructPath: {
        const ops = a[0], d = a[1];
        let k = 0, cur = null;
        for (const op of ops) {
          if (op === OPS.moveTo) { cur = { pts: [[d[k], d[k + 1]]], closed: false }; path.push(cur); k += 2; }
          else if (op === OPS.lineTo) { if (!cur) { cur = { pts: [], closed: false }; path.push(cur); } cur.pts.push([d[k], d[k + 1]]); k += 2; }
          else if (op === OPS.curveTo) { k += 6; if (cur) cur.pts.length = 0; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { k += 4; if (cur) cur.pts.length = 0; }
          else if (op === OPS.closePath) { if (cur) cur.closed = true; }
          else if (op === OPS.rectangle) { path.push({ rect: [d[k], d[k + 1], d[k + 2], d[k + 3]] }); cur = null; k += 4; }
        }
        break;
      }
      case OPS.fill: case OPS.eoFill: flushPath("fill"); break;
      case OPS.stroke: case OPS.closeStroke: flushPath("stroke"); break;
      case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke: flushPath("fillstroke"); break;
      case OPS.endPath: path = []; break;
      case OPS.paintImageXObject: case OPS.paintJpegXObject: {
        const [x0, y0] = toPage(0, 0), [x1, y1] = toPage(1, 1);
        const rec = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), id: a[0], m: [ctm[0], ctm[1], ctm[2], ctm[3]] };
        imgs.push(rec);
        break;
      }
      case OPS.paintInlineImageXObject: {
        const [x0, y0] = toPage(0, 0), [x1, y1] = toPage(1, 1);
        imgs.push({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), inline: a[0], m: [ctm[0], ctm[1], ctm[2], ctm[3]] });
        break;
      }
      default: break;
    }
  }

  // imágenes: se resuelven a bytes
  const images = [];
  const seen = imgCache;
  for (const im of imgs) {
    if (im.w < 4 || im.h < 4) continue;
    const key = im.id ? `${im.id}|${im.m.map((v) => (Math.abs(v) < 1e-6 ? 0 : Math.sign(v))).join(",")}` : null;
    let enc = key && seen.has(key) ? seen.get(key) : undefined;
    if (enc === undefined) {
      const o = im.inline || (await waitObj(page, im.id));
      try { enc = o ? encodeImage(o, pdfjs, im.m) : null; } catch (_) { enc = null; }
      if (key) seen.set(key, enc);
    }
    if (enc) images.push({ x: im.x, y: im.y, w: im.w, h: im.h, enc });
  }

  // textos: los glifos contiguos con el mismo estilo forman un elemento
  const texts = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const fi = fontOf(cur.font);
    let str = cur.str;
    if (fi.symbol) str = str.replace(/[\uF000-\uF0FF]/g, (c) => ({ "\uF0B7": "•", "\uF0A7": "▪", "\uF076": "❖", "\uF0D8": "➢", "\uF0FC": "✓", "\uF06F": "o" }[c] || "•"));
    str = str.normalize("NFKC").replace(/[\uE000-\uF8FF]/g, "•").replace(/\u00a0/g, " ");
    if (str.length && !(cur.size < 3)) texts.push({ str, x: cur.x, y: cur.y, w: cur.end - cur.x, size: Math.round(cur.size * 4) / 4, family: fi.family, bold: fi.bold, italic: fi.italic, color: cur.color === "000000" ? null : cur.color });
    cur = null;
  };
  for (const g of glyphs) {
    if (g.rot) { flush(); continue; }
    if (cur && g.font === cur.font && g.color === cur.color && Math.abs(g.size - cur.size) < 0.3 && Math.abs(g.y - cur.y) < 0.5 && g.x - cur.end > -0.35 * g.size && g.x - cur.end < 0.15 * g.size) {
      cur.str += g.ch;
      cur.end = g.x + g.adv;
    } else {
      flush();
      cur = { str: g.ch, x: g.x, y: g.y, end: g.x + g.adv, size: g.size, color: g.color, font: g.font };
    }
  }
  flush();

  // subrayados: un trazo horizontal fino justo debajo de la línea base del texto
  for (const tx of texts) {
    if (tx.w < 2) continue;
    for (const s of segs.h) {
      if (s.y > tx.y + 0.5 && s.y < tx.y + 0.3 * tx.size && s.x1 <= tx.x + tx.w * 0.4 && s.x2 >= tx.x + tx.w * 0.6 && s.x2 - s.x1 < tx.w * 1.6 + 8 && s.w < 2.5) { tx.underline = true; s.used = true; break; }
    }
  }
  return { W, H, texts, segs, fills, images };
}

module.exports = { load, extractPage, encodePng, familyOf, median, MAX_PAGES, A4, mul, apply, esc, run, para };
