// services/plannings/images.js
// Imágenes del planning: tamaño de PNG/JPEG y conversión de logos SVG a PNG.
// Un SVG no se puede incrustar de forma fiable en todos los Word, así que se
// convierte a PNG de alta resolución (fondo transparente) con resvg, que es
// una librería local: no se envía nada a ningún servicio externo.

const MAX_SVG_BYTES = 5 * 1024 * 1024;

/** @returns {{w:number,h:number,ext:string}|null} */
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: "png" };
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), ext: "jpg" };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { w: 1, h: 1, ext: "jpg" };
  }
  return null;
}

/** ¿Parece un SVG? (texto XML con un elemento <svg>) */
function looksLikeSvg(buf) {
  if (!buf || !buf.length || buf.length > MAX_SVG_BYTES) return false;
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf8");
  return /<svg[\s>]/i.test(head);
}

/**
 * Convierte un SVG en PNG (ancho 1200 px, fondo transparente).
 * @returns {{png:Buffer, w:number, h:number, avisos:string[]}}
 */
function svgToPng(svgBuffer, { width = 1200 } = {}) {
  if (!looksLikeSvg(svgBuffer)) throw new Error("no es un SVG válido");
  const { Resvg } = require("@resvg/resvg-js");
  const svg = svgBuffer.toString("utf8");
  const avisos = [];
  if (/<text[\s>]/i.test(svg)) {
    avisos.push("El logo SVG contiene texto: si en el Word la letra no es la que esperas, expórtalo con el texto convertido a curvas.");
  }
  if (/<image[^>]+(?:href|xlink:href)\s*=\s*["']https?:/i.test(svg)) {
    avisos.push("El logo SVG enlaza imágenes de Internet, que no se descargan: usa un SVG con las imágenes incrustadas.");
  }
  let img;
  try {
    const r = new Resvg(svg, {
      fitTo: { mode: "width", value: width },
      font: { loadSystemFonts: true },
      shapeRendering: 2,
      textRendering: 1,
      imageRendering: 0,
    });
    img = r.render();
  } catch (e) {
    throw new Error(`no se ha podido convertir el SVG (${String(e.message || e).slice(0, 120)})`);
  }
  return { png: img.asPng(), w: img.width, h: img.height, avisos };
}

module.exports = { imageSize, looksLikeSvg, svgToPng, MAX_SVG_BYTES };
