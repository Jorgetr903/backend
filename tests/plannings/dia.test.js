const test = require("node:test");
const assert = require("node:assert");
const T = require("../../services/plannings/tablas");
const V = require("../../services/plannings/validaciones");

const celda = (t, extra = {}) => ({ lines: t ? [{ text: t }] : [], ...extra });
const grid = [
  [celda("")],
  [celda("09:00"), celda("Desayuno largo con muchas cosas que contar", { colspan: 3 }), celda(""), celda("")],
  [celda("10:00"), celda("Actividad A"), celda("Actividad B"), celda("Actividad C")],
  [celda("11:00"), celda("Comida", { colspan: 3 }), celda(""), celda("")],
];

test("la tabla de cada día ocupa todo el ancho útil, con horas estrechas", () => {
  const meta = {};
  const xml = T.diaDobleXml(grid, { anchoUtil: 15308, numero: "1", codigo: "L20", titulo: "Lunes", meta });
  assert.equal(meta.ancho, 15308);
  assert.ok(meta.hora >= 720 && meta.hora <= 1400, `hora ${meta.hora}`);
  const cols = (xml.match(/<w:gridCol w:w="(\d+)"/g) || []).map((x) => +x.replace(/\D/g, ""));
  assert.equal(cols.reduce((a, b) => a + b, 0), 15308);
  assert.equal(cols.length, 14);
  assert.deepEqual(V.revisaTablas(`<w:body>${xml}<w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:h="11906"/><w:pgMar w:left="765" w:right="765"/></w:sectPr></w:pPr></w:p></w:body>`).sobresalen, []);
});

test("con otro ancho útil se reparte igual", () => {
  const meta = {};
  T.diaDobleXml(grid, { anchoUtil: 14000, numero: "1", codigo: "L20", titulo: "x", meta });
  assert.equal(meta.ancho, 14000);
});

test("contactosXml: una fila por monitor con 3 columnas", () => {
  const xml = T.contactosXml([{ nombre: "Ana", email: "a@x.es", telefono: "600 000 001" }, { nombre: "Luis", email: "l@x.es", telefono: "" }], { ancho: 9639 });
  assert.equal((xml.match(/<w:tr>/g) || []).length, 3);
  assert.equal((xml.match(/<w:gridCol /g) || []).length, 3);
  assert.ok(xml.includes("a@x.es") && xml.includes("600 000 001"));
});
