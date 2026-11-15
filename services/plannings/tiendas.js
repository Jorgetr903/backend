// services/plannings/tiendas.js
//
// Plantilla de las tablas de TIENDAS (distribución de los acampados por nivel y monitor).
// Separa datos y diseño: los datos salen de la Base de Datos del año (parseTiendasHoja); el diseño está en
// tablasConfig.js. Cada nivel tiene su tabla y su título «NIVEL (Coordinador: X) - N»; las filas de cada monitor
// se agrupan en una sola celda combinada; la tabla ocupa el ancho útil de la página A4 vertical y, si no cabe,
// continúa en otra página repitiendo título y encabezado, sin cortar filas ni reducir la letra.

const { TIENDAS } = require("./tablasConfig");
const { prim, NIVELES } = require("./tablas");
const { tc, tr, tbl, cp, lineasEstimadas } = prim;
const { norm } = require("./textutil");

const C = TIENDAS;
const sz = C.bordes;
const borde = (n) => ({ sz: n, color: sz.color });

/** «PEQUEÑOS (Coordinador: Juan) - 23» → { nivelTexto, coordinador, numero } (lo que no aparezca queda vacío) */
function datosDeTitulo(titulo) {
  const t = String(titulo || "");
  const coord = /coordinador(?:a|es)?\s*:\s*([^)\-–]+?)\s*\)/i.exec(t) || /coordinador(?:a|es)?\s*:\s*(.+?)\s*(?:[-–]\s*\d+\s*)?$/i.exec(t);
  const num = /[-–]\s*(\d+)\s*$/.exec(t.trim());
  return { coordinador: coord ? coord[1].trim() : "", numero: num ? +num[1] : null };
}

/** Palabra más larga (en caracteres) de un conjunto de textos */
const palabraMax = (textos) => Math.max(0, ...textos.flatMap((t) => String(t || "").split(/\s+/).map((w) => w.length)));

/** Reparto de anchos (twips) del ancho útil. Las columnas con palabras largas crecen a costa de observaciones */
function repartoAnchos(h, util) {
  const W = C.anchos.map((p) => Math.round(util * p));
  const f = C.fuentes;
  const necesita = (letras, size, negrita) => Math.round(letras * size * 20 * (negrita ? 0.58 : 0.53)) + C.margenCelda.l + C.margenCelda.r + 40;
  const filas = h.bloques.flatMap((b) => b.filas);
  const min = [
    necesita(palabraMax(h.bloques.map((b) => String(b.grupo || "").toUpperCase())), f.monitor, true),
    necesita(palabraMax(filas.map((x) => x.nombre)), f.nombre, false),
    necesita(palabraMax(filas.map((x) => x.apellidos)) , f.apellidos, false),
  ];
  const obsMin = Math.round(util * C.anchoMinObservaciones);
  for (let i = 0; i < 3; i++) {
    if (W[i] < min[i]) {
      const falta = Math.min(min[i] - W[i], W[3] - obsMin);
      if (falta > 0) {
        W[i] += falta;
        W[3] -= falta;
      }
    }
  }
  W[3] = util - W[0] - W[1] - W[2];
  return W;
}

/** Título de la tabla */
function tituloTabla(h, nChicos) {
  const nivelNombre = C.nombreNivel[h.nivel] || String(h.titulo || "").replace(/\(.*$/, "").replace(/[-–]\s*\d+\s*$/, "").trim().toUpperCase();
  const { coordinador } = datosDeTitulo(h.titulo);
  return `${nivelNombre}${coordinador ? ` (Coordinador: ${coordinador})` : ""} - ${nChicos}`;
}

/**
 * Construye las tablas (una por página) de una hoja de tiendas.
 * @param h {titulo, nivel, bloques:[{grupo, filas:[{nombre,apellidos,obs}]}]}
 * @param opts {util: ancho útil (twips), altoUtil: alto útil (twips)}
 * @returns {{partes:string[], titulo:string, nChicos:number, avisos:string[], anchos:number[]}}
 */
function tiendasTablaXml(h, { util = 10206, altoUtil = 14500 } = {}) {
  const pal = C.paleta[h.nivel] || C.paleta.neutro;
  const f = C.fuentes;
  const mar = C.margenCelda;
  const W = repartoAnchos(h, util);
  const avisos = [];
  const filasTotal = h.bloques.reduce((n, b) => n + b.filas.length, 0);
  const { numero } = datosDeTitulo(h.titulo);
  if (numero != null && numero !== filasTotal) avisos.push(`${h.titulo}: el título de la hoja dice ${numero} acampados pero hay ${filasTotal} filas; se usa ${filasTotal}.`);
  if (!datosDeTitulo(h.titulo).coordinador) avisos.push(`${h.titulo}: no se encuentra el coordinador del nivel en el título de la hoja («… (Coordinador: Nombre) - N»); el título sale sin coordinador.`);
  const titulo = tituloTabla(h, filasTotal);

  // altura estimada de cada fila (twips)
  const lh = (size) => size * 20 * 1.22;
  const altoFila = (x) => {
    const n = Math.max(lineasEstimadas(x.nombre, W[1], f.nombre, 0.5), lineasEstimadas(x.apellidos, W[2], f.apellidos, 0.5), lineasEstimadas(x.obs, W[3], f.observaciones, 0.5));
    return Math.max(C.alturaMinFila, Math.round(n * lh(f.observaciones) + mar.t + mar.b + 20));
  };
  const cabeza = C.alturaTitulo + C.alturaEncabezado;
  const limite = Math.floor(altoUtil * C.aprovechamientoPagina);
  const libre = limite - cabeza;
  const minLineasMonitor = (b) => lineasEstimadas(String(b.grupo || "").toUpperCase(), W[0], f.monitor, 0.58);

  // reparto de bloques en páginas: un bloque no se parte si cabe en una página; si es mayor que una página se parte por filas
  const paginas = [];
  let actual = { bloques: [], alto: 0 };
  const cierra = () => {
    if (actual.bloques.length) paginas.push(actual);
    actual = { bloques: [], alto: 0 };
  };
  for (const b of h.bloques) {
    const hs = b.filas.map(altoFila);
    const altoBloque = Math.max(hs.reduce((a, c) => a + c, 0), Math.round(minLineasMonitor(b) * lh(f.monitor)) + mar.t + mar.b);
    if (actual.alto + altoBloque <= libre) {
      actual.bloques.push({ grupo: b.grupo, filas: b.filas, hs });
      actual.alto += altoBloque;
    } else if (altoBloque <= libre) {
      cierra();
      actual.bloques.push({ grupo: b.grupo, filas: b.filas, hs });
      actual.alto = altoBloque;
    } else {
      // bloque mayor que una página: se parte por filas; el monitor se repite al empezar cada trozo.
      // Si en la página actual caben al menos 3 filas, se empieza ahí; si no, en una página nueva.
      if (libre - actual.alto < 3 * Math.max(C.alturaMinFila, hs[0])) cierra();
      let i = 0;
      while (i < b.filas.length) {
        const hueco = libre - actual.alto;
        let acc = 0;
        const ini = i;
        while (i < b.filas.length && (acc + hs[i] <= hueco || i === ini)) acc += hs[i++];
        actual.bloques.push({ grupo: b.grupo, filas: b.filas.slice(ini, i), hs: hs.slice(ini, i) });
        actual.alto += acc;
        if (i < b.filas.length) cierra();
      }
    }
  }
  cierra();

  const partes = paginas.map((pg) => {
    const rows = [];
    rows.push(
      tr(
        [
          tc(cp([{ text: titulo, bold: true }], { size: f.titulo }), {
            width: util,
            span: 4,
            fill: pal.monitor,
            valign: "center",
            borders: { top: borde(sz.exterior), left: borde(sz.exterior), right: borde(sz.exterior), bottom: borde(sz.interior) },
            mar,
          }),
        ],
        { height: C.alturaTitulo, header: true }
      )
    );
    rows.push(
      tr(
        C.encabezados.map((t, i) =>
          tc(cp([{ text: t, bold: true }], { size: f.encabezado }), {
            width: W[i],
            fill: pal.monitor,
            valign: "center",
            borders: { top: borde(sz.interior), bottom: borde(sz.bloque), left: i === 0 ? borde(sz.exterior) : borde(sz.interior), right: i === 3 ? borde(sz.exterior) : borde(sz.interior) },
            mar,
          })
        ),
        { height: C.alturaEncabezado, header: true }
      )
    );
    pg.bloques.forEach((b, bi) => {
      const ultimoBloque = bi === pg.bloques.length - 1;
      b.filas.forEach((x, fi) => {
        const primera = fi === 0;
        const ultima = fi === b.filas.length - 1;
        const top = primera ? borde(sz.bloque) : borde(sz.interior);
        const bottom = ultima ? (ultimoBloque ? borde(sz.exterior) : borde(sz.bloque)) : borde(sz.interior);
        const bd = (left, right) => ({ top, bottom, left, right });
        const celdas = [
          tc(primera ? cp([{ text: String(b.grupo || "").toUpperCase(), bold: true }], { size: f.monitor, align: "center" }) : "", {
            width: W[0],
            vMerge: b.filas.length > 1 ? (primera ? "restart" : "continue") : undefined,
            fill: pal.monitor,
            valign: "center",
            borders: bd(borde(sz.exterior), borde(sz.interior)),
            mar,
          }),
          tc(cp(x.nombre, { size: f.nombre, align: "left" }), { width: W[1], fill: pal.fila, valign: "center", borders: bd(borde(sz.interior), borde(sz.interior)), mar }),
          tc(cp(x.apellidos, { size: f.apellidos, align: "left" }), { width: W[2], fill: pal.fila, valign: "center", borders: bd(borde(sz.interior), borde(sz.interior)), mar }),
          tc(cp(x.obs, { size: f.observaciones, align: "left" }), { width: W[3], fill: pal.fila, valign: "center", borders: bd(borde(sz.interior), borde(sz.exterior)), mar }),
        ];
        rows.push(tr(celdas, { height: b.hs[fi] }));
      });
    });
    return tbl(W, rows, { jc: "center" });
  });
  return { partes, titulo, nChicos: filasTotal, avisos, anchos: W, paginas: partes.length };
}

module.exports = { tiendasTablaXml, datosDeTitulo, repartoAnchos, tituloTabla };
