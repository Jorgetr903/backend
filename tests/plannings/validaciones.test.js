const test = require("node:test");
const assert = require("node:assert");
const V = require("../../services/plannings/validaciones");

const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const tc = (w, content, extra = "") => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${extra}</w:tcPr>${content}</w:tc>`;
const tr = (cells) => `<w:tr>${cells.join("")}</w:tr>`;
const tbl = (widths, rows) => `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;
const sect = (w = 11906, l = 1417, r = 850) => `<w:p><w:pPr><w:sectPr><w:pgSz w:w="${w}" w:h="16838"/><w:pgMar w:top="1000" w:right="${r}" w:bottom="1000" w:left="${l}"/></w:sectPr></w:pPr></w:p>`;
const util = 11906 - 1417 - 850;
const W4 = [3000, 1500, 2500, util - 7000];
const cab = (w) => [tr([tc(util, p("MATERIAL NO FUNGIBLE"), '<w:gridSpan w:val="4"/>')]), tr(["", "CANTIDAD", "CAJA DE ACTIVIDAD", "MATERIAL GENERAL"].map((t, i) => tc(w[i], p(t))))];
const fila = (w, a, b, c, d) => tr([a, b, c, d].map((t, i) => tc(w[i], p(t))));
const doc = (...partes) => `<w:body>${partes.join("")}${sect()}</w:body>`;

test("bienFormado detecta etiquetas mal cerradas", () => {
  assert.equal(V.bienFormado("<a><b/></a>"), null);
  assert.ok(V.bienFormado("<a><b></a></b>"));
  assert.ok(V.bienFormado("<a><b></b>"));
});

test("tabla de material correcta: sin avisos", () => {
  const r = V.revisaTablas(doc(tbl(W4, [...cab(W4), fila(W4, "Disfraz de policía", "2", "X", ""), fila(W4, "Disfraz de chef", "2", "X", ""), fila(W4, "Camisa de crítico", "2", "X", "")])));
  assert.equal(r.material, 1);
  assert.deepEqual(r.estructura, []);
  assert.deepEqual(r.materialAncho, []);
  assert.deepEqual(r.sobresalen, []);
});

test("material con filas repetidas se detecta", () => {
  const r = V.revisaTablas(doc(tbl(W4, [...cab(W4), fila(W4, "Disfraz de chef", "2", "X", ""), fila(W4, "Disfraz de chef", "2", "X", ""), fila(W4, "Rata", "1", "X", "")])));
  assert.ok(r.estructura.some((e) => /repetida/i.test(e)));
});

test("varios disfraces concatenados en una celda combinada se detectan", () => {
  const unida = tr([tc(W4[0], p("Disfraz de policía") + p("Disfraz de chef") + p("Disfraz de camarera"), '<w:vMerge w:val="restart"/>'), tc(W4[1], p("2")), tc(W4[2], p("X")), tc(W4[3], p(""))]);
  const r = V.revisaTablas(doc(tbl(W4, [...cab(W4), unida, fila(W4, "Rata", "1", "X", ""), fila(W4, "Otra", "1", "X", "")])));
  assert.ok(r.estructura.some((e) => /Varios materiales/.test(e)));
});

test("un material que se parte en líneas no es una concatenación", () => {
  const largo = tr([tc(W4[0], p("Cuaderno/folio") + p("con cuentas") + p("(Mateo)")), tc(W4[1], p("1")), tc(W4[2], p("X")), tc(W4[3], p(""))]);
  const r = V.revisaTablas(doc(tbl(W4, [...cab(W4), largo, fila(W4, "A", "1", "", "X"), fila(W4, "B", "1", "", "X")])));
  assert.deepEqual(r.estructura, []);
});

test("material con menos de 4 columnas y tablas más anchas que la página se detectan", () => {
  const W3 = [3000, 3000, util - 6000];
  const t3 = tbl(W3, [tr([tc(util, p("MATERIAL FUNGIBLE"), '<w:gridSpan w:val="3"/>')]), tr(["", "CANTIDAD", "CAJA DE ACTIVIDAD MATERIAL GENERAL"].map((t, i) => tc(W3[i], p(t))))]);
  assert.ok(V.revisaTablas(doc(t3)).estructura.some((e) => /faltan columnas/.test(e)));
  const ancha = tbl([9000, 9000], [tr([tc(9000, p("a")), tc(9000, p("b"))])]);
  assert.equal(V.revisaTablas(doc(ancha)).sobresalen.length, 1);
});

test("tabla de personajes: 3 columnas", () => {
  const W = [2000, 3000, util - 5000];
  const c = tr(["Personaje", "Relación", "Observaciones"].map((t, i) => tc(W[i], p(t))));
  const r = V.revisaTablas(doc(tbl(W, [c, tr(W.map((w, i) => tc(w, p("x"))))])));
  assert.deepEqual(r.estructura, []);
  const W2 = [3000, util - 3000];
  const c2 = tr(["Personaje", "Relación Observaciones"].map((t, i) => tc(W2[i], p(t))));
  assert.ok(V.revisaTablas(doc(tbl(W2, [c2]))).estructura.length === 1);
});

test("tabulaciones: solo cuentan 3 o más líneas seguidas", () => {
  const t = (n) => `<w:p><w:r><w:t>Cubo</w:t><w:tab/><w:t>1</w:t><w:tab/><w:t>X</w:t></w:r></w:p>`.repeat(n);
  assert.equal(V.tabulacionesSimuladas(`<w:body>${t(1)}${p("x")}${t(2)}</w:body>`), 0);
  assert.equal(V.tabulacionesSimuladas(`<w:body>${t(3)}</w:body>`), 1);
});

test("tabulaciones: las viñetas y los esquemas de jugadores X/O no cuentan como tabla", () => {
  const vineta = `<w:p><w:r><w:t>●</w:t><w:tab/><w:tab/><w:t>Texto de la viñeta</w:t></w:r></w:p>`.repeat(4);
  const diagrama = `<w:p><w:r><w:tab/><w:t>X</w:t><w:tab/><w:t>O</w:t><w:tab/><w:t>X</w:t></w:r></w:p>`.repeat(4);
  assert.equal(V.tabulacionesSimuladas(`<w:body>${vineta}${p("x")}${diagrama}</w:body>`), 0);
});
