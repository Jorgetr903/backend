const test = require("node:test");
const assert = require("node:assert");
const ExcelJS = require("exceljs");
const { parseContactos } = require("../../services/plannings/contactos");

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("H");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("sin cabecera: nombre, correo y teléfono por fila", async () => {
  const r = await parseContactos(await xlsx([["Paula Test", "p@ejemplo.test", "600 000 001"], ["Alien Prueba", "a@ejemplo.test", "600 000 002"]]));
  assert.equal(r.error, null);
  assert.deepEqual(r.filas.map((f) => [f.nombre, f.email, f.telefono]), [["Paula Test", "p@ejemplo.test", "600 000 001"], ["Alien Prueba", "a@ejemplo.test", "600 000 002"]]);
});

test("título, cabecera en otro orden, filas vacías y cabecera repetida", async () => {
  const r = await parseContactos(await xlsx([["CONTACTOS 2026"], [], ["Teléfono", "Nombre", "Correo electrónico"], [600111222, "Ana Pérez", "ana@x.es"], [], ["+34 611 222 333", "Luis Gómez", "luis@x.es"], ["Teléfono", "Nombre", "Correo electrónico"], ["", "Sin Tel", "sin@x.es"]]));
  assert.equal(r.error, null);
  assert.deepEqual(r.filas.map((f) => f.nombre), ["Ana Pérez", "Luis Gómez", "Sin Tel"]);
  assert.equal(r.filas[0].email, "ana@x.es");
  assert.equal(r.filas[0].telefono, "600 111 222");
  assert.equal(r.filas[1].telefono, "+34 611 222 333");
  assert.equal(r.filas[2].telefono, "");
});

test("nombre y apellidos en columnas separadas", async () => {
  const r = await parseContactos(await xlsx([["Nombre", "Apellidos", "Email", "Móvil"], ["Ana", "Pérez López", "ana@x.es", "600 111 222"]]));
  assert.equal(r.filas[0].nombre, "Ana Pérez López");
  assert.equal(r.filas[0].email, "ana@x.es");
});

test("datos dudosos: avisa pero no inventa", async () => {
  const r = await parseContactos(await xlsx([["Nombre", "Correo", "Teléfono"], ["Ana", "ana@x.es", "600 111 222"], ["Marta", "marta.mal", "12"]]));
  assert.ok(r.avisos.some((a) => /Marta/.test(a) && /correo/.test(a)));
  assert.equal(r.filas.find((f) => f.nombre === "Marta").email, "");
});

test("archivo sin contactos interpretables: error explicativo", async () => {
  const r = await parseContactos(await xlsx([["Hola"], ["nada"]]), "«x.xlsx»");
  assert.ok(r.error && /x\.xlsx/.test(r.error));
  assert.equal(r.filas.length, 0);
});

test("no es un Excel: error explicativo", async () => {
  const r = await parseContactos(Buffer.from("esto no es un excel"), "«malo.xlsx»");
  assert.ok(r.error && /malo\.xlsx/.test(r.error));
});
