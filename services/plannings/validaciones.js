// services/plannings/validaciones.js
//
// Comprobaciones sobre el XML del Word ya montado. Recorren el texto por posiciones (sin construir
// un árbol DOM): en el servidor gratuito (512 MB) un árbol del documento completo gasta casi toda
// la memoria.

const RE_MATERIAL = /material\s+(no\s+)?fungible|recursos\s+materiales/i;

/**
 * Comprueba que un XML está bien formado (etiquetas abiertas y cerradas en orden).
 * Devuelve null si está bien, o el motivo.
 */
function bienFormado(xml) {
  const pila = [];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  let i = xml.indexOf("<");
  while (i >= 0) {
    if (xml.startsWith("<?", i)) {
      const j = xml.indexOf("?>", i);
      if (j < 0) return "instrucción sin cerrar";
      i = xml.indexOf("<", j + 2);
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const j = xml.indexOf("-->", i);
      if (j < 0) return "comentario sin cerrar";
      i = xml.indexOf("<", j + 3);
      continue;
    }
    tag.lastIndex = i;
    const m = tag.exec(xml);
    if (!m) return `etiqueta mal formada cerca de la posición ${i}`;
    if (m[1]) {
      if (pila.pop() !== m[2]) return `la etiqueta </${m[2]}> no coincide con la que se abrió`;
    } else if (!m[4]) pila.push(m[2]);
    i = xml.indexOf("<", tag.lastIndex);
  }
  return pila.length ? `quedan etiquetas sin cerrar (<${pila[pila.length - 1]}>)` : null;
}

/** Posición del final (exclusive) de la tabla que empieza en `pos`, contando tablas anidadas */
function finDeTabla(xml, pos) {
  let depth = 0;
  let i = pos;
  for (;;) {
    const a = xml.indexOf("<w:tbl>", i);
    const b = xml.indexOf("</w:tbl>", i);
    if (b < 0) return xml.length;
    if (a >= 0 && a < b) {
      depth++;
      i = a + 7;
    } else {
      depth--;
      i = b + 8;
      if (depth === 0) return i;
    }
  }
}

const textosDe = (frag) => (frag.match(/<w:t(?: [^>]*)?>[^<]*/g) || []).map((x) => x.replace(/<w:t(?: [^>]*)?>/, ""));

/** Filas de una tabla: cadenas XML (las tablas anidadas son raras en estos documentos) */
function filasDe(tabla) {
  const i = tabla.indexOf("</w:tblGrid>");
  return i < 0 ? [] : tabla.slice(i).match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [];
}

/** Celdas (nivel superior) de una fila */
function celdasDe(fila) {
  const out = [];
  let i = fila.indexOf("<w:tc>");
  while (i >= 0) {
    // sin tablas anidadas en las celdas que generamos; si las hubiera, se toma hasta el último cierre
    const b = fila.indexOf("</w:tc>", i);
    if (b < 0) break;
    out.push(fila.slice(i, b + 7));
    i = fila.indexOf("<w:tc>", b);
  }
  return out;
}

const sumaRejilla = (tabla) => {
  const g = tabla.slice(0, tabla.indexOf("</w:tblGrid>")).split("<w:tblGridChange")[0];
  return (g.match(/<w:gridCol w:w="(\d+)"/g) || []).map((x) => parseInt(x.replace(/\D/g, ""), 10));
};

/** Texto de una celda por párrafos con contenido */
function parrafosConTexto(celda) {
  return (celda.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map((p) => textosDe(p).join("").trim()).filter(Boolean);
}

/**
 * Revisión de las tablas del documento. Por cada tabla de primer nivel:
 *  · ancho frente al ancho útil de su sección (las de material deben ocupar todo el ancho);
 *  · tablas de material con las 4 columnas originales, un material por fila, sin filas repetidas;
 *  · tablas de relaciones (Personaje / Relación / Observaciones) con 3 columnas;
 *  · filas con varios elementos concatenados en una misma celda.
 */
function revisaTablas(xml) {
  const res = { tablas: 0, material: 0, materialAncho: [], sobresalen: [], estructura: [], vacias: 0 };
  const reSect = /<w:sectPr[ >][\s\S]*?<\/w:sectPr>/g;
  let desde = 0;
  let m;
  const visita = (hasta, util) => {
    let pos = xml.indexOf("<w:tbl>", desde);
    while (pos >= 0 && pos < hasta) {
      const fin = finDeTabla(xml, pos);
      const tabla = xml.slice(pos, fin);
      res.tablas++;
      const cols = sumaRejilla(tabla);
      const ancho = cols.reduce((a, b) => a + b, 0);
      const indMatch = /<w:tblInd w:w="(-?\d+)"/.exec(tabla.slice(0, 2000));
      const ind = indMatch ? Math.max(0, parseInt(indMatch[1], 10)) : 0;
      const filas = filasDe(tabla);
      const cab = filas.slice(0, 3).map((f) => textosDe(f).join(" ")).join(" ");
      const esMaterial = RE_MATERIAL.test(cab);
      const nombre = (cab || "").replace(/\s+/g, " ").trim().slice(0, 40) || "(sin texto)";
      if (util && ancho + ind > util + 120 && cols.length) res.sobresalen.push(`«${nombre}»: ${(ancho / 567).toFixed(1)} cm en una página útil de ${(util / 567).toFixed(1)} cm`);
      if (esMaterial) {
        res.material++;
        if (util && Math.abs(ancho - util) > 80) res.materialAncho.push(`${(ancho / 567).toFixed(1)} cm en vez de ${(util / 567).toFixed(1)} cm`);
        // las tablas de material con CANTIDAD / CAJA / MATERIAL GENERAL tienen 4 columnas
        if (/cantidad/i.test(cab) && /caja de actividad/i.test(cab) && /material general/i.test(cab) && cols.length < 4) res.estructura.push(`Tabla de material «${nombre}» con ${cols.length} columnas: faltan columnas de las 4 originales (Material, Cantidad, Caja de actividad, Material general)`);
      }
      if (/personaje/i.test(cab) && /relaci[oó]n/i.test(cab) && /observaciones/i.test(cab)) {
        const cabecera = filas.find((f) => /personaje/i.test(textosDe(f).join(" ")));
        const nCel = cabecera ? celdasDe(cabecera).length : 0;
        if (nCel !== 3) res.estructura.push(`Tabla de relaciones con ${nCel} columnas en la cabecera en vez de 3`);
      }
      // filas con elementos concatenados: una celda con 3 o más párrafos de texto mientras otras celdas de la misma fila
      // tienen un solo valor, en una tabla con filas de datos (varias filas con un elemento cada una)
      if (filas.length >= 4) {
        let previa = null;
        filas.forEach((f, ri) => {
          const celdas = celdasDe(f);
          const ps = celdas.map(parrafosConTexto);
          const clave = ps.map((p) => p.join(" ")).join("|");
          if (esMaterial && clave.replace(/\|/g, "").trim() && clave === previa) res.estructura.push(`Fila repetida en «${nombre}» (fila ${ri + 1}): ${clave.slice(0, 50)}`);
          previa = clave;
          // varios materiales en una celda: una celda combinada verticalmente con 3 o más párrafos, o párrafos que empiezan por la misma palabra
          // (un material que se parte en varias líneas por falta de ancho no cuenta)
          if (esMaterial && ps.length >= 3 && ps[0].length >= 3 && ps.slice(1).some((p) => p.length <= 1)) {
            const primeras = ps[0].map((t) => t.split(/\s+/)[0].toLowerCase()).filter((w) => w.length > 3);
            const repetida = primeras.some((w, i) => primeras.indexOf(w) !== i);
            if (/vMerge w:val="restart"/.test(celdas[0]) || repetida) res.estructura.push(`Varios materiales en una misma celda en «${nombre}» (fila ${ri + 1}): ${ps[0].join(" · ").slice(0, 60)}`);
          }
        });
      }
      // la tabla no tiene filas con texto
      if (!filas.some((f) => textosDe(f).join("").trim())) res.vacias++;
      pos = xml.indexOf("<w:tbl>", fin);
    }
  };
  while ((m = reSect.exec(xml))) {
    const sp = m[0];
    const pgW = /<w:pgSz[^>]*w:w="(\d+)"/.exec(sp);
    const iz = /<w:pgMar[^>]*w:left="(\d+)"/.exec(sp);
    const de = /<w:pgMar[^>]*w:right="(\d+)"/.exec(sp);
    const util = pgW && iz && de ? +pgW[1] - +iz[1] - +de[1] : 0;
    visita(m.index, util);
    desde = m.index + sp.length;
  }
  return res;
}

/**
 * Tablas simuladas con tabulaciones: 3 o más párrafos seguidos con 2 o más tabulaciones cada uno
 * (una línea suelta con tabulaciones —un texto justificado, un esquema de jugadores— no es una tabla).
 * Devuelve el número de bloques sospechosos.
 */
function tabulacionesSimuladas(xml) {
  let bloques = 0;
  let racha = 0;
  let finPrevio = -1;
  let pos = 0;
  while ((pos = xml.indexOf("<w:tab/>", pos)) >= 0) {
    const a = Math.max(xml.lastIndexOf("<w:p>", pos), xml.lastIndexOf("<w:p ", pos));
    const b = xml.indexOf("</w:p>", pos);
    if (a < 0 || b < 0) break;
    const p = xml.slice(a, b);
    // segmentos de texto separados por tabulaciones (sin la viñeta inicial); un esquema de jugadores X/O no es una tabla
    const segs = [""];
    for (const tk of p.match(/<w:t(?: [^>]*)?>[^<]*|<w:tab\/>/g) || []) {
      if (tk === "<w:tab/>") segs.push("");
      else segs[segs.length - 1] += tk.replace(/<w:t[^>]*>/, "");
    }
    const celdas = segs.map((t) => t.trim()).filter((t) => t && !/^[●•▪◦·\-–]$/.test(t));
    const n = celdas.length >= 3 && celdas.some((t) => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}/.test(t)) ? segs.length - 1 : 0;
    // cabecera de una tabla de materiales escrita como un solo párrafo («MATERIAL … ⇥CANTIDAD ⇥CAJA …»)
    if (celdas.length >= 3 && /material/i.test(celdas.join(" ")) && celdas.some((t) => /^cantidad$/i.test(t)) && !/PAGEREF/.test(p)) bloques++;
    if (n >= 2 && !/PAGEREF/.test(p)) {
      racha = a - finPrevio <= 8 && finPrevio >= 0 ? racha + 1 : 1;
      if (racha === 3) bloques++;
      finPrevio = b + 6;
    }
    pos = b;
  }
  return bloques;
}

/** Número de páginas casi vacías de un PDF (sin texto ni imágenes ni dibujos relevantes) */
async function paginasEnBlanco(pdfPath, fs, lib) {
  const doc = await lib.pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), isEvalSupported: false, verbosity: 0 }).promise;
  const vacias = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const hayTexto = tc.items.some((it) => it.str && it.str.trim());
      let hayGrafico = false;
      if (!hayTexto) {
        const ops = await page.getOperatorList();
        const OPS = lib.pdfjs.OPS;
        hayGrafico = ops.fnArray.some((f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject || f === OPS.paintImageMaskXObject || f === OPS.constructPath || f === OPS.stroke || f === OPS.fill);
      }
      if (!hayTexto && !hayGrafico) vacias.push(p);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return vacias;
}

module.exports = { bienFormado, revisaTablas, tabulacionesSimuladas, paginasEnBlanco, finDeTabla, filasDe, celdasDe, RE_MATERIAL };
