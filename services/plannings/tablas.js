// services/plannings/tablas.js
//
// Tablas del planning con las medidas exactas del planning de 2025:
//   · TIENDAS (una tabla por nivel y por página: Pequeños → Medianos → Mayores)
//   · GRUPOS DE TRABAJO (una página, 12 columnas)
//   · DISTRIBUCIÓN Y SERVICIOS DE LOS GRUPOS DE TRABAJO EN EL COMEDOR (7 × n + plano)
//   · TABLA DE CADA DÍA (dos copias de la tabla, una al lado de la otra)
//
// Unidades: 1 cm = 567 twips; 1 pt = 20 twips.

const { esc, run, para } = require("./ooxml");
const { cellLines, mergeIndex } = require("./xlsxReader");
const { norm } = require("./textutil");

const LIGHT = "Calibri Light";
const THIN = 6; // 0,75 pt
const THICK = 16; // 2 pt

// ───────────────────────── Piezas de bajo nivel ─────────────────────────

/** Bordes de celda. Cada lado: número (w:sz) o {sz,color}; null/0 → sin borde */
function tcBorders(b) {
  if (!b) return "";
  const side = (name, v) => {
    if (!v) return `<w:${name} w:val="nil"/>`;
    const sz = typeof v === "number" ? v : v.sz;
    const color = typeof v === "number" ? "000000" : v.color || "000000";
    return `<w:${name} w:val="single" w:sz="${sz}" w:space="0" w:color="${color}"/>`;
  };
  return `<w:tcBorders>${side("top", b.top)}${side("left", b.left)}${side("bottom", b.bottom)}${side("right", b.right)}</w:tcBorders>`;
}

/** Celda con control total. o: width, span, vMerge, fill, valign, borders, mar {l,r,t,b} */
function tc(content, o = {}) {
  const pr = [];
  pr.push(`<w:tcW w:w="${Math.round(o.width || 0)}" w:type="dxa"/>`);
  if (o.span > 1) pr.push(`<w:gridSpan w:val="${o.span}"/>`);
  if (o.vMerge === "restart") pr.push('<w:vMerge w:val="restart"/>');
  if (o.vMerge === "continue") pr.push("<w:vMerge/>");
  if (o.borders) pr.push(tcBorders(o.borders));
  if (o.fill) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${esc(o.fill)}"/>`);
  if (o.mar) pr.push(`<w:tcMar><w:top w:w="${o.mar.t}" w:type="dxa"/><w:left w:w="${o.mar.l}" w:type="dxa"/><w:bottom w:w="${o.mar.b}" w:type="dxa"/><w:right w:w="${o.mar.r}" w:type="dxa"/></w:tcMar>`);
  if (o.valign) pr.push(`<w:vAlign w:val="${o.valign}"/>`);
  return `<w:tc><w:tcPr>${pr.join("")}</w:tcPr>${content && content.length ? content : vacio()}</w:tc>`;
}

/** Párrafo vacío de altura mínima (para celdas sin texto en filas de altura exacta) */
function vacio() {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>`;
}

/** Fila. o: height (twips), rule ("atLeast" | "exact"), header */
function tr(cells, o = {}) {
  const pr = ["<w:cantSplit/>"];
  if (o.header) pr.push("<w:tblHeader/>");
  if (o.height) pr.push(`<w:trHeight w:val="${Math.round(o.height)}" w:hRule="${o.rule || "atLeast"}"/>`);
  return `<w:tr><w:trPr>${pr.join("")}</w:trPr>${cells.join("")}</w:tr>`;
}

/** Tabla de rejilla fija, sin bordes de tabla (cada celda lleva los suyos) */
function tbl(widths, rows, o = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const jc = o.jc ? `<w:jc w:val="${o.jc}"/>` : "";
  const ind = o.indent ? `<w:tblInd w:w="${Math.round(o.indent)}" w:type="dxa"/>` : "";
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>${jc}${ind}<w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="55" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="55" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${Math.round(w)}"/>`).join("")}</w:tblGrid>` +
    rows.join("") +
    "</w:tbl>"
  );
}

/** Párrafo de celda: texto simple o líneas [{text,bold,color,runs}] */
function cp(lines, { size = 11, font = LIGHT, align = "center", bold = false, color } = {}) {
  const arr = Array.isArray(lines) ? lines : [{ text: String(lines == null ? "" : lines) }];
  if (!arr.length) return vacio();
  return arr
    .map((l) => {
      const runs = l.runs
        ? l.runs.map((r) => run(r.text, { font, size: r.size || size, bold: r.bold || bold, color: r.color || color })).join("")
        : run(l.text, { font, size: l.size || size, bold: l.bold || bold, color: l.color || color });
      return para(runs, { align: l.align || align, before: 0, after: 0, line: 240 });
    })
    .join("");
}

/** Alto estimado (twips) de un texto en una celda de ancho w (twips) a un tamaño dado */
function lineasEstimadas(texto, w, size, factor = 0.47) {
  const cpl = Math.max(3, Math.floor((w - 110) / (size * 20 * factor)));
  const palabras = String(texto || "").split(/\s+/).filter(Boolean);
  let n = 1;
  let cur = 0;
  for (const p of palabras) {
    const l = p.length;
    if (cur === 0) cur = l;
    else if (cur + 1 + l <= cpl) cur += 1 + l;
    else {
      n++;
      cur = l;
    }
    while (cur > cpl) {
      n++;
      cur -= cpl;
    }
  }
  return n;
}

const colorHex = (c) => (c && /^[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : null);

// ───────────────────────── Niveles: colores ─────────────────────────

const NIVELES = {
  pequenos: { nombre: "Pequeños", rank: 3, titulo: "BDD6EE", grupo: "BDD6EE", alterno: "DEEBF7", acampado: "FAE3D4" },
  medianos: { nombre: "Medianos", rank: 2, titulo: "FDD868", grupo: "FDE49B", alterno: "FFF2CC", acampado: "C2F0C7" },
  mayores: { nombre: "Mayores", rank: 1, titulo: "3CC262", grupo: "00CC66", alterno: "E3EFD9", acampado: "BFE5F5" },
};
const NEUTRO = { nombre: "", rank: 9, titulo: "D9D9D9", grupo: "D9D9D9", alterno: "F2F2F2", acampado: "FFFFFF" };

function nivelDe(texto) {
  const n = norm(texto || "");
  if (/peque/.test(n)) return "pequenos";
  if (/median|medi[ao]s/.test(n)) return "medianos";
  if (/mayor/.test(n)) return "mayores";
  return null;
}

// ───────────────────────── TIENDAS ─────────────────────────

const txtCelda = (ws, merges, r, c) => {
  const m = merges.get(`${r},${c}`);
  if (m && (m.r1 !== r || m.c1 !== c)) return ""; // parte combinada, no es la celda principal
  return cellLines(ws.getCell(r, c))
    .map((l) => l.text)
    .join(" ")
    .trim();
};

/**
 * Lee una hoja «tienda / nombre / apellidos / observaciones».
 * @returns {{titulo:string, nivel:string|null, bloques:{grupo:string, filas:{nombre,apellidos,obs}[]}[]}|null}
 */
function parseTiendasHoja(ws) {
  const merges = mergeIndex(ws);
  const R = ws.rowCount;
  const C = Math.min(ws.columnCount, 12);
  let r0 = 1;
  const filaVacia = (r) => ![...Array(C)].some((_, i) => txtCelda(ws, merges, r, i + 1));
  while (r0 <= R && filaVacia(r0)) r0++;
  if (r0 > R) return null;
  // título: la fila es solo un texto (combinado o en A)
  const celdasFila = [...Array(C)].map((_, i) => txtCelda(ws, merges, r0, i + 1)).filter(Boolean);
  let titulo = "";
  let inicio = r0;
  if (celdasFila.length === 1 && /\(|-|coordinador|peque|median|mayor/i.test(celdasFila[0])) {
    titulo = celdasFila[0];
    inicio = r0 + 1;
  }
  const bloques = [];
  // ¿hay fila de cabecera de columnas («Tienda | Monitores | Niño/a | Alergias»)?
  const PAL = /^(tienda|grupo|nombre|apellidos?|monitores?|ni[ñn]o\/?a?|ni[ñn]os?|alergias?|observaciones?|nivel|medicaci[oó]n|pauta)$/i;
  let mapa = null;
  {
    let rc = inicio;
    while (rc <= R && filaVacia(rc)) rc++;
    const cab = [...Array(C)].map((_, i) => txtCelda(ws, merges, rc, i + 1));
    if (cab.filter((t) => PAL.test(t)).length >= 2) {
      const col = (re) => cab.findIndex((t) => re.test(norm(t)));
      mapa = { fila: rc, tienda: col(/^(tienda|grupo)$/), monitores: col(/monitor/), nombre: col(/^(nombre|nino|ninoa|ninos)/), apellidos: col(/apellid/), obs: cab.map((t, i) => (/alerg|observ|medic|pauta/.test(norm(t)) ? i : -1)).filter((i) => i >= 0) };
      if ((mapa.tienda < 0 && mapa.monitores < 0) || mapa.nombre < 0) return null; // otra estructura: se pinta tal cual
      inicio = rc + 1;
    }
  }
  let claveActual = null;
  for (let r = inicio; r <= R; r++) {
    if (filaVacia(r)) continue;
    let a, b, c, obs, clave;
    if (mapa) {
      const t = (i) => (i >= 0 ? txtCelda(ws, merges, r, i + 1) : "");
      clave = t(mapa.tienda);
      a = t(mapa.monitores) || clave;
      b = t(mapa.nombre);
      c = t(mapa.apellidos);
      obs = mapa.obs.map((i) => t(i)).filter(Boolean).join(" / ");
      if (!b && !c && !obs) continue;
      if (!bloques.length || (clave && clave !== claveActual)) {
        bloques.push({ grupo: a, filas: [] });
        claveActual = clave || claveActual;
      }
      bloques[bloques.length - 1].filas.push({ nombre: b, apellidos: c, obs });
      continue;
    }
    a = txtCelda(ws, merges, r, 1);
    b = txtCelda(ws, merges, r, 2);
    c = txtCelda(ws, merges, r, 3);
    obs = [...Array(Math.max(0, C - 3))].map((_, i) => txtCelda(ws, merges, r, 4 + i)).filter(Boolean).join(" / ");
    if (/^(tienda|grupo)?\s*$/i.test(a) && /^nombre/i.test(b)) continue; // fila de cabecera de columnas
    if (!b && !c && !obs) continue;
    if (a || !bloques.length) bloques.push({ grupo: a, filas: [] });
    bloques[bloques.length - 1].filas.push({ nombre: b, apellidos: c, obs });
  }
  if (!bloques.length) return null;
  const nivel = nivelDe(titulo) || nivelDe(ws.name);
  return { titulo: titulo || ws.name, nivel, bloques };
}

/**
 * Tabla de una hoja de tiendas (una página). Reduce alto de fila y letra, en este orden, hasta que quepa.
 * @returns {{xml:string, size:number, minRow:number, cabe:boolean}}
 */
function tiendasTablaXml(h, { altoUtil = 9572 } = {}) {
  const pal = NIVELES[h.nivel] || NEUTRO;
  const W = [1134, 1077, 2551, 10546];
  const total = W.reduce((a, b) => a + b, 0);
  let elegido = null;
  const intentos = [];
  for (const size of [11, 10.5, 10, 9.5]) for (const minRow of size === 11 ? [280, 260, 240] : [240]) intentos.push({ size, minRow });
  const alturas = (size, minRow) => {
    const lh = size * 20 * 1.22;
    const filas = [];
    for (const b of h.bloques)
      for (const f of b.filas) {
        const n = Math.max(lineasEstimadas(f.nombre, W[1], size), lineasEstimadas(f.apellidos, W[2], size), lineasEstimadas(f.obs, W[3], size));
        filas.push(Math.max(minRow, Math.round(n * lh + 30)));
      }
    return filas;
  };
  for (const it of intentos) {
    const hs = alturas(it.size, it.minRow);
    const suma = 380 + hs.reduce((a, b) => a + b, 0);
    elegido = { ...it, hs, suma };
    if (suma <= altoUtil) break;
  }
  const { size, minRow, hs, suma } = elegido;
  const mar = { l: 55, r: 55, t: 15, b: 15 };
  const rows = [];
  // título
  rows.push(
    tr(
      [
        tc(cp(h.titulo, { size: 14 }), {
          width: total,
          span: 4,
          fill: pal.titulo,
          valign: "center",
          borders: { top: THICK, left: THICK, right: THICK, bottom: THICK },
          mar,
        }),
      ],
      { height: 380 }
    )
  );
  let k = 0;
  h.bloques.forEach((b, bi) => {
    const ultimoBloque = bi === h.bloques.length - 1;
    const alt = bi % 2 === 1 ? pal.alterno : null;
    b.filas.forEach((f, fi) => {
      const primera = fi === 0;
      const ultima = fi === b.filas.length - 1;
      const top = primera ? THICK : THIN;
      const bottom = ultima ? THICK : THIN;
      const bd = (left, right) => ({ top, bottom, left, right });
      const celdas = [];
      // columna 1: nombre del grupo, combinada en vertical por bloque
      celdas.push(
        tc(primera ? cp(String(b.grupo || "").toUpperCase(), { size }) : "", {
          width: W[0],
          vMerge: b.filas.length > 1 ? (primera ? "restart" : "continue") : undefined,
          fill: pal.grupo,
          valign: "center",
          borders: bd(THICK, THIN),
          mar,
        })
      );
      celdas.push(tc(cp(f.nombre, { size, align: "left" }), { width: W[1], fill: alt, valign: "center", borders: bd(THIN, THIN), mar }));
      celdas.push(tc(cp(f.apellidos, { size, align: "left" }), { width: W[2], fill: alt, valign: "center", borders: bd(THIN, THIN), mar }));
      celdas.push(tc(cp(f.obs, { size, align: "left" }), { width: W[3], fill: alt, valign: "center", borders: bd(THIN, THICK), mar }));
      rows.push(tr(celdas, { height: hs[k++] }));
    });
  });
  return { xml: tbl(W, rows), size, minRow, alto: suma, cabe: suma <= altoUtil };
}

// ───────────────────────── GRUPOS DE TRABAJO ─────────────────────────

const esAnio = (v) => Number.isInteger(v) && v >= 1980 && v <= 2035;

function anioDeCelda(cell) {
  const v = cell.value;
  if (v == null) return null;
  const val = typeof v === "object" && v.result !== undefined ? v.result : v;
  if (val instanceof Date) return esAnio(val.getUTCFullYear()) ? val.getUTCFullYear() : null;
  if (typeof val === "number") {
    if (esAnio(val)) return val;
    if (val > 20000 && val < 70000) {
      const d = new Date(Math.round((val - 25569) * 86400000));
      return esAnio(d.getUTCFullYear()) ? d.getUTCFullYear() : null;
    }
    return null;
  }
  const m = /^\s*(\d{4})\s*$/.exec(String(val));
  return m && esAnio(+m[1]) ? +m[1] : null;
}

/**
 * Lee la hoja de grupos de trabajo: una cabecera «GRUPO n» (combinada o no) y bajo ella
 * los monitores y las filas de acampados (nombre [+ apellidos] + año).
 * @returns {{grupos:{nombre:string, monitores:string[], filas:{nombre:string, anio:number|null}[]}[]}|null}
 */
function parseGruposTrabajoHoja(ws) {
  const merges = mergeIndex(ws);
  const R = ws.rowCount;
  const C = Math.min(ws.columnCount, 40);
  let filaCab = 0;
  let cabs = [];
  for (let r = 1; r <= Math.min(R, 12) && !filaCab; r++) {
    const f = [];
    for (let c = 1; c <= C; c++) {
      const t = txtCelda(ws, merges, r, c);
      if (/^grupo\s*\d+/i.test(t)) f.push({ c, nombre: t.toUpperCase().replace(/\s+/g, " ") });
    }
    if (f.length >= 2) {
      filaCab = r;
      cabs = f;
    }
  }
  if (!filaCab) return null;
  cabs.forEach((g, i) => {
    g.c2 = (cabs[i + 1] ? cabs[i + 1].c : C + 1) - 1;
  });
  // filas siguientes: monitores (celda con varias líneas o texto sin año) y acampados
  const grupos = cabs.map((g) => ({ nombre: g.nombre, monitores: [], filas: [], c: g.c, c2: g.c2 }));
  let filaMon = 0;
  for (let r = filaCab + 1; r <= R && !filaMon; r++) {
    const algo = grupos.some((g) => {
      for (let c = g.c; c <= g.c2; c++) if (txtCelda(ws, merges, r, c)) return true;
      return false;
    });
    if (algo) filaMon = r;
  }
  if (!filaMon) return { grupos };
  // ¿la fila de monitores es de monitores o ya es de acampados? (monitores: sin año en el grupo)
  const tieneAnio = (r, g) => {
    for (let c = g.c; c <= g.c2; c++) if (anioDeCelda(ws.getCell(r, c)) != null && !merges.get(`${r},${c}`)) return true;
    return false;
  };
  const filaEsMonitores = !grupos.some((g) => tieneAnio(filaMon, g));
  let primeraAcampados = filaMon;
  if (filaEsMonitores) {
    for (const g of grupos) {
      const lineas = [];
      for (let c = g.c; c <= g.c2; c++) {
        const m = merges.get(`${filaMon},${c}`);
        if (m && (m.r1 !== filaMon || m.c1 !== c)) continue;
        for (const l of cellLines(ws.getCell(filaMon, c))) lineas.push(l.text);
      }
      g.monitores = lineas;
    }
    primeraAcampados = filaMon + 1;
  }
  for (let r = primeraAcampados; r <= R; r++) {
    for (const g of grupos) {
      const partes = [];
      let anio = null;
      for (let c = g.c; c <= g.c2; c++) {
        const m = merges.get(`${r},${c}`);
        if (m && (m.r1 !== r || m.c1 !== c)) continue;
        const a = anioDeCelda(ws.getCell(r, c));
        if (a != null) {
          anio = a;
          continue;
        }
        const t = txtCelda(ws, merges, r, c);
        if (t && !/^\d+$/.test(t)) partes.push(t);
      }
      const nombre = partes.join(" ").replace(/\s+/g, " ").trim();
      if (nombre) g.filas.push({ nombre, anio });
    }
  }
  return { grupos };
}

const claveNombre = (s) => norm(s || "").replace(/[^a-z0-9]/g, "");

/** Tabla de grupos de trabajo (una página, 12 columnas). nivelPorNombre: Map(claveNombre → nivel) */
function gruposTrabajoXml(datos, { anio, nivelPorNombre = new Map() } = {}) {
  const gs = datos.grupos.slice(0, 6);
  const n = gs.length;
  const W = [];
  for (let i = 0; i < n; i++) W.push(1814, i === n - 1 ? 800 : 804);
  const total = W.reduce((a, b) => a + b, 0);
  const nivelAnio = (y) => {
    if (y == null) return "pequenos";
    const edad = anio - y;
    return edad >= 15 ? "mayores" : edad >= 12 ? "medianos" : "pequenos";
  };
  // ordenar: Mayores → Medianos → Pequeños, y por año (de más antiguo a más joven)
  for (const g of gs)
    g.filas = g.filas
      .map((f, i) => {
        const niv = nivelPorNombre.get(claveNombre(f.nombre)) || nivelAnio(f.anio);
        return { ...f, niv, i };
      })
      .sort((a, b) => NIVELES[a.niv].rank - NIVELES[b.niv].rank || (a.anio || 9999) - (b.anio || 9999) || a.i - b.i);
  const maxFilas = Math.max(0, ...gs.map((g) => g.filas.length));
  const mar = { l: 55, r: 55, t: 0, b: 0 };
  const rows = [];
  rows.push(
    tr(
      [
        tc(cp("GRUPOS DE TRABAJO", { size: 22 }), {
          width: total,
          span: W.length,
          valign: "center",
          borders: { top: THICK, left: THICK, right: THICK, bottom: THICK },
          mar,
        }),
      ],
      { height: 600 }
    )
  );
  rows.push(
    tr(
      gs.map((g, i) =>
        tc(cp(g.nombre, { size: 15 }), {
          width: W[2 * i] + W[2 * i + 1],
          span: 2,
          valign: "center",
          borders: { top: THICK, bottom: THICK, left: i === 0 ? THICK : THICK, right: i === n - 1 ? THICK : THICK },
          mar,
        })
      ),
      { height: 770 }
    )
  );
  const maxMon = Math.max(1, ...gs.map((g) => g.monitores.length));
  rows.push(
    tr(
      gs.map((g, i) =>
        tc(cp(g.monitores.length ? g.monitores.map((t) => ({ text: t })) : [{ text: "" }], { size: g.monitores.length >= 5 ? 11 : g.monitores.length === 4 ? 12 : 14 }), {
          width: W[2 * i] + W[2 * i + 1],
          span: 2,
          valign: "center",
          borders: { top: THICK, bottom: THICK, left: THICK, right: THICK },
          mar,
        })
      ),
      { height: 1434 }
    )
  );
  // tamaño de letra de los acampados: se reduce si no cabe en la página
  const fontSize = maxFilas > 14 ? 9.5 : maxFilas > 12 ? 10 : 10;
  for (let r = 0; r < maxFilas; r++) {
    const celdas = [];
    const ultima = r === maxFilas - 1;
    gs.forEach((g, i) => {
      const f = g.filas[r];
      const pal = f ? NIVELES[f.niv] : null;
      const fill = pal ? pal.acampado : null;
      const top = r === 0 ? THICK : THIN;
      const bottom = ultima ? THICK : THIN;
      celdas.push(
        tc(f ? cp(f.nombre, { size: fontSize, font: "Calibri" }) : "", { width: W[2 * i], fill, valign: "center", borders: { top, bottom, left: THICK, right: THIN }, mar })
      );
      celdas.push(
        tc(f ? cp(f.anio != null ? String(f.anio) : "", { size: fontSize, font: "Calibri" }) : "", {
          width: W[2 * i + 1],
          fill,
          valign: "center",
          borders: { top, bottom, left: THIN, right: i === n - 1 ? THICK : THICK },
          mar,
        })
      );
    });
    rows.push(tr(celdas, { height: 274 }));
  }
  // alto estimado
  const lh = fontSize * 20 * 1.22;
  let alto = 600 + 770 + Math.max(1434, maxMon * 14 * 20 * 1.22 + 40);
  for (let r = 0; r < maxFilas; r++) {
    let nl = 1;
    for (const g of gs) if (g.filas[r]) nl = Math.max(nl, lineasEstimadas(g.filas[r].nombre, W[0], fontSize, 0.5));
    alto += Math.max(274, Math.round(nl * lh + 20));
  }
  return { xml: tbl(W, rows), grupos: n, filas: maxFilas, alto };
}

// ───────────────────────── Comedor ─────────────────────────

const CICLO_SERVICIOS = ["Comedor", "Fregado 1", "Extra", "Oración", "Fregado 2", "Batida"];

/**
 * Filas del reparto de servicios entre grupos de trabajo.
 * dias: etiquetas de los días normales ("D19", "L20"...). marcha: etiqueta del día sin servicio (o null).
 * @returns {{etiqueta:string, gris:boolean, servicios:string[]}[]}
 */
function comedorFilas(dias, marcha, nGrupos = 6) {
  // días por fila: los dos primeros, los dos que siguen a la marcha y los dos últimos van juntos
  const n = dias.length;
  const iM = marcha ? dias.indexOf(marcha) : -1;
  const grupos = [];
  let i = 0;
  while (i < n) {
    const junta = (i === 0 && n >= 3) || (iM >= 0 && i === iM + 1 && i + 1 < n && i + 1 !== n - 1 && n - i > 2) || (i === n - 2 && n >= 3 && i !== iM);
    if (i === iM) grupos.push([i]);
    else if (junta && i + 1 < n && i + 1 !== iM) grupos.push([i, i + 1]);
    else grupos.push([i]);
    i += grupos[grupos.length - 1].length;
  }
  let paso = 0;
  return grupos.map((idx) => {
    const gris = iM >= 0 && idx.length === 1 && idx[0] === iM;
    const etiqueta = idx.map((k) => dias[k]).join(" - ");
    if (gris) return { etiqueta, gris: true, servicios: [] };
    const servicios = Array.from({ length: nGrupos }, (_, g) => CICLO_SERVICIOS[(g + paso) % CICLO_SERVICIOS.length]);
    paso++;
    return { etiqueta, gris: false, servicios };
  });
}

/** Si hay una hoja «Día | Comedor | Fregado 1 | … → Grupo n», la convierte en filas (día × grupo → servicio) */
function parseServicioHoja(ws) {
  const merges = mergeIndex(ws);
  const R = ws.rowCount;
  const C = Math.min(ws.columnCount, 12);
  let fCab = 0;
  for (let r = 1; r <= Math.min(R, 8) && !fCab; r++) {
    const t = [...Array(C)].map((_, i) => norm(txtCelda(ws, merges, r, i + 1)));
    if (t.some((x) => /^dia/.test(x)) && t.filter((x) => /comedor|fregado|extra|oracion|batida/.test(x)).length >= 3) fCab = r;
  }
  if (!fCab) return null;
  const cols = [];
  for (let c = 1; c <= C; c++) {
    const t = txtCelda(ws, merges, fCab, c);
    if (/comedor|fregado|extra|oraci|batida/i.test(t)) cols.push({ c, nombre: t.replace(/\s+/g, " ").trim() });
  }
  const filas = [];
  let nGrupos = 0;
  for (let r = fCab + 1; r <= R; r++) {
    const dia = txtCelda(ws, merges, r, 1);
    if (!dia) continue;
    const porGrupo = new Map();
    for (const col of cols) {
      const m = /(\d+)/.exec(txtCelda(ws, merges, r, col.c));
      if (m) {
        porGrupo.set(+m[1], col.nombre);
        nGrupos = Math.max(nGrupos, +m[1]);
      }
    }
    filas.push({ etiqueta: dia, gris: porGrupo.size === 0, porGrupo });
  }
  if (!filas.length || !nGrupos) return null;
  return filas.map((f) => ({ etiqueta: f.etiqueta, gris: f.gris, servicios: Array.from({ length: nGrupos }, (_, g) => f.porGrupo.get(g + 1) || "") }));
}

/** Tabla del comedor: caja de título + tabla 7 × (1 + filas) */
function comedorXml(filas, nGrupos = 6, { rowH = 428 } = {}) {
  const W = [2080, ...Array(nGrupos).fill(2070)];
  const total = W.reduce((a, b) => a + b, 0);
  const mar = { l: 55, r: 55, t: 0, b: 0 };
  const arial = { font: "Arial", size: 10 };
  const thin = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  // caja de título (tabla de una celda, centrada sobre las columnas de grupos)
  const wBox = 8100;
  const caja = tbl(
    [wBox],
    [
      tr(
        [
          tc(cp("DISTRIBUCIÓN Y SERVICIOS DE LOS GRUPOS DE TRABAJO EN EL COMEDOR", { ...arial, bold: true }), {
            width: wBox,
            valign: "center",
            borders: thin,
            mar,
          }),
        ],
        { height: 400 }
      ),
    ],
    { indent: Math.round(W[0] + (W.slice(1).reduce((a, b) => a + b, 0) - wBox) / 2) }
  );
  const rows = [];
  rows.push(
    tr(
      [
        tc("", { width: W[0], valign: "center", borders: { top: null, left: null, bottom: THIN, right: THIN }, mar }),
        ...W.slice(1).map((w, g) => tc(cp(`GRUPO ${g + 1}`, { ...arial, bold: true }), { width: w, valign: "center", borders: thin, mar })),
      ],
      { height: rowH, rule: "exact" }
    )
  );
  for (const f of filas) {
    const cel = [tc(cp(f.etiqueta, { ...arial, bold: true }), { width: W[0], fill: f.gris ? "BFBFBF" : "B8E0CC", valign: "center", borders: thin, mar })];
    for (let g = 0; g < nGrupos; g++) cel.push(tc(f.gris ? "" : cp(f.servicios[g] || "", arial), { width: W[g + 1], fill: f.gris ? "BFBFBF" : null, valign: "center", borders: thin, mar }));
    rows.push(tr(cel, { height: rowH, rule: "exact" }));
  }
  return { cajaXml: caja, tablaXml: tbl(W, rows), filas: filas.length };
}

// ───────────────────────── Tabla de cada día (dos copias) ─────────────────────────

const GRIS_FIJO = "D9D9D9";
const GRIS_ORACION = "A6A6A6";
const GRIS_HORA = "7F7F7F";

/** Relleno según el del Excel: grises → los del planning; otros colores se respetan */
function rellenoDia(fill) {
  const f = colorHex(fill);
  if (!f) return null;
  const r = parseInt(f.slice(0, 2), 16);
  const g = parseInt(f.slice(2, 4), 16);
  const b = parseInt(f.slice(4, 6), 16);
  const esGris = Math.abs(r - g) < 14 && Math.abs(g - b) < 14;
  if (esGris) return r >= 0xb0 ? GRIS_FIJO : GRIS_ORACION;
  return f;
}

const textoCelda = (c) => (c.lines || []).map((l) => (l.runs ? l.runs.map((x) => x.text).join("") : l.text || "")).join(" ");

/**
 * Tabla de un día: dos copias de la misma tabla una al lado de la otra.
 * grid: resultado de daysGrid([day]) (fila 0 = cabecera, resto = [hora, c0, c1, c2]).
 * opts: ordinal (texto del nº de día), codigo, titulo, lluvia (bool), baños {names}
 */
function diaDobleXml(grid, opts = {}) {
  const { numero = "", codigo = "", titulo = "", lluvia = false, banos = null, esLlegada = false, meta = null } = opts;
  // rejilla: [A] [L1..L6] [D] [R1..R6]
  const L = [643, 643, 643, 643, 644, 644];
  const Rr = [683, 683, 683, 683, 684, 684];
  const W = [840, ...L, 880, ...Rr];
  const NC = W.length;
  const sumW = (a, n) => W.slice(a, a + n).reduce((x, y) => x + y, 0);
  const horas = grid.slice(1);
  const NR = horas.length;
  const ocupado = Array.from({ length: NR }, () => new Array(NC).fill(false));
  const bloques = []; // {r,c,rs,cs,lines,fill,borders,valign,size}
  const aviso = [];
  const colocar = (b) => {
    for (let r = b.r; r < b.r + b.rs; r++) for (let c = b.c; c < b.c + b.cs; c++) if (r >= NR || ocupado[r][c]) return false;
    for (let r = b.r; r < b.r + b.rs; r++) for (let c = b.c; c < b.c + b.cs; c++) ocupado[r][c] = true;
    bloques.push(b);
    return true;
  };
  const fijoRe = /^(quedada|salida|.*viaje|comida|cena)\b/;
  const fuente = [];
  horas.forEach((fila, ri) => {
    for (let k = 0; k < 3; k++) {
      const c = fila[1 + k];
      if (!c || c.covered || !c.lines || !c.lines.length) continue;
      const cs = Math.min(c.colspan || 1, 3 - k);
      const rs = Math.max(1, c.rowspan || 1);
      fuente.push({ ri, k, cs, rs, c });
      if (!colocar({ r: ri, c: 1 + 2 * k, rs, cs: 2 * cs, lines: c.lines, fill: rellenoDia(c.fill), borde: true, valign: "center", lado: "izq" })) aviso.push(`${codigo}: celda solapada en ${horas[ri][0].lines[0].text}`);
    }
  });
  // copia derecha: solo bloques fijos (en las mismas filas) y BAÑOS
  const ocupadoD = Array.from({ length: NR }, () => false);
  const dcha = [];
  for (const s of fuente) {
    const primera = norm((s.c.lines[0] && (s.c.lines[0].text || (s.c.lines[0].runs && s.c.lines[0].runs[0].text))) || "");
    if (s.cs === 3 && fijoRe.test(primera)) {
      dcha.push({ r: s.ri, rs: s.rs, lines: s.c.lines, fill: GRIS_FIJO });
      for (let r = s.ri; r < s.ri + s.rs; r++) ocupadoD[r] = true;
    }
  }
  dcha.sort((a, b) => a.r - b.r);
  // huecos en blanco combinados; el primero lleva «BAÑOS»
  const piezasD = [];
  let cursor = 0;
  let primeraBlanca = true;
  const hueco = (desde, hasta) => {
    if (hasta <= desde) return;
    let lines = [];
    let valign = "center";
    if (primeraBlanca && !esLlegada) {
      lines = [{ runs: [{ text: "BAÑOS:", bold: false }, ...(banos && banos.names && banos.names.length ? [{ text: " " + banos.names.join(", ").toUpperCase(), bold: true }] : [])] }];
      valign = "top";
    }
    primeraBlanca = false;
    piezasD.push({ r: desde, rs: hasta - desde, lines, fill: null, valign });
  };
  for (const d of dcha) {
    hueco(cursor, d.r);
    piezasD.push({ r: d.r, rs: d.rs, lines: d.lines, fill: d.fill, valign: "center" });
    cursor = d.r + d.rs;
  }
  hueco(cursor, NR);
  for (const p of piezasD) colocar({ r: p.r, c: 8, rs: p.rs, cs: 6, lines: p.lines, fill: p.fill, borde: true, valign: p.valign, lado: "dcha" });

  // tamaño de letra: 9 pt; si la tabla no cabe en la página con las filas que hay que ensanchar, baja hasta 7 pt
  const filaH = 228;
  const hs = new Array(NR).fill(filaH);
  const MAX_ALTO = 9572;
  let size = 9;
  let ajustes = [];
  for (; size >= 7; size -= 0.5) {
    ajustes = new Array(NR).fill(0);
    for (const b of bloques) {
      const w = sumW(b.c, b.cs);
      const lh = size * 20 * 1.2;
      const nl = b.lines.reduce((n, l) => n + lineasEstimadas(l.runs ? l.runs.map((x) => x.text).join("") : l.text || "", w, size, 0.48), 0);
      const deficit = Math.ceil(nl * lh + 24 - filaH * b.rs);
      if (deficit > 0) {
        const ult = b.r + b.rs - 1;
        ajustes[ult] = Math.max(ajustes[ult], deficit);
      }
    }
    if (536 + NR * filaH + ajustes.reduce((a, c) => a + c, 0) <= MAX_ALTO) break;
  }
  if (size < 7) size = 7;
  for (let r = 0; r < NR; r++) hs[r] = filaH + ajustes[r];
  const alto = 536 + hs.reduce((a, b) => a + b, 0);

  // ── XML
  const rows = [];
  const borde = (c) => ({ top: THIN, bottom: THIN, left: THIN, right: THIN });
  const horaBorde = { top: { sz: 4, color: "BFBFBF" }, bottom: { sz: 4, color: "BFBFBF" }, left: { sz: 4, color: "BFBFBF" }, right: { sz: 4, color: "BFBFBF" } };
  const mar0 = { l: 40, r: 40, t: 0, b: 0 };
  // cabecera
  const cab = (offset, color) => {
    if (lluvia) {
      return [
        tc(cp(numero, { size: 16 }), { width: W[offset], valign: "center", borders: borde(), mar: mar0 }),
        tc(cp([{ text: "DÍA DE LLUVIA", color }], { size: 12 }), { width: sumW(offset + 1, offset === 0 ? 6 : 6), span: 6, valign: "center", borders: borde(), mar: mar0 }),
      ];
    }
    return [
      tc(cp(numero, { size: 16 }), { width: W[offset], valign: "center", borders: borde(), mar: mar0 }),
      tc(cp(codigo, { size: 12 }), { width: sumW(offset + 1, 2), span: 2, valign: "center", borders: borde(), mar: mar0 }),
      tc(cp(titulo, { size: 12 }), { width: sumW(offset + 3, 4), span: 4, valign: "center", borders: borde(), mar: mar0 }),
    ];
  };
  rows.push(tr([...cab(0, "00B0F0"), ...cab(7, "0000FF")], { height: 536, rule: "exact" }));
  // posiciones de inicio de bloque y de continuación vertical
  const inicio = new Map(); // "r,c" -> bloque
  const cont = new Map(); // "r,c" -> bloque (continuación vertical, solo columna inicial)
  const cubierto = Array.from({ length: NR }, () => new Array(NC).fill(false));
  for (const b of bloques) {
    inicio.set(`${b.r},${b.c}`, b);
    for (let r = b.r; r < b.r + b.rs; r++) for (let c = b.c; c < b.c + b.cs; c++) cubierto[r][c] = true;
    for (let r = b.r + 1; r < b.r + b.rs; r++) cont.set(`${r},${b.c}`, b);
  }
  for (let ri = 0; ri < NR; ri++) {
    const celdas = [];
    const horaTxt = horas[ri][0].lines[0].text;
    const horaCelda = (c) => tc(cp([{ text: horaTxt, color: GRIS_HORA }], { size: 9 }), { width: W[c], valign: "center", borders: horaBorde, mar: mar0 });
    for (let c = 0; c < NC; c++) {
      if (c === 0 || c === 7) {
        celdas.push(horaCelda(c));
        continue;
      }
      const b = inicio.get(`${ri},${c}`);
      const k = cont.get(`${ri},${c}`);
      if (b) {
        celdas.push(
          tc(cp(b.lines, { size }), {
            width: sumW(b.c, b.cs),
            span: b.cs,
            vMerge: b.rs > 1 ? "restart" : undefined,
            fill: b.fill,
            valign: b.valign,
            borders: borde(),
            mar: mar0,
          })
        );
        c += b.cs - 1;
      } else if (k) {
        celdas.push(tc("", { width: sumW(k.c, k.cs), span: k.cs, vMerge: "continue", fill: k.fill, borders: borde(), mar: mar0 }));
        c += k.cs - 1;
      } else if (!cubierto[ri][c]) {
        // hueco sin contenido: celda vacía de una columna
        celdas.push(tc("", { width: W[c], borders: borde(), mar: mar0 }));
      }
    }
    rows.push(tr(celdas, { height: hs[ri], rule: "exact" }));
  }
  if (meta) {
    meta.size = size;
    meta.alto = alto;
    meta.maxAlto = MAX_ALTO;
    meta.cabe = alto <= MAX_ALTO;
    meta.avisos = aviso;
  }
  return tbl(W, rows, { jc: "center" });
}

module.exports = {
  LIGHT,
  NIVELES,
  nivelDe,
  parseTiendasHoja,
  tiendasTablaXml,
  parseGruposTrabajoHoja,
  gruposTrabajoXml,
  claveNombre,
  comedorFilas,
  parseServicioHoja,
  comedorXml,
  diaDobleXml,
  CICLO_SERVICIOS,
};
