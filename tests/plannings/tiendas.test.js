const test = require("node:test");
const assert = require("node:assert");
const { TIENDAS } = require("../../services/plannings/tablasConfig");
const TI = require("../../services/plannings/tiendas");

const UTIL = 11906 - 850 - 850;
const ALTO = 16838 - 1134 - 1200 - 40;

function hoja(nivel, bloques, titulo) {
  return {
    titulo: titulo || `${nivel.toUpperCase()} (Coordinador: Marta) - ${bloques.reduce((n, b) => n + b[1], 0)}`,
    nivel,
    bloques: bloques.map(([grupo, n, obs]) => ({
      grupo,
      filas: Array.from({ length: n }, (_, i) => ({ nombre: `Nombre${i}`, apellidos: `Apellido Apellido${i}`, obs: obs && i % 2 === 0 ? obs : "" })),
    })),
  };
}
const nTablas = (xml) => (xml.match(/<w:tbl>/g) || []).length;

test("el título lleva nivel, coordinador y número real de acampados", () => {
  const r = TI.tiendasTablaXml(hoja("pequenos", [["Ana", 3], ["Luis", 2]]), { util: UTIL, altoUtil: ALTO });
  assert.strictEqual(r.titulo, "PEQUEÑOS (Coordinador: Marta) - 5");
  assert.strictEqual(r.partes.length, 1);
  assert.deepStrictEqual(r.avisos, []);
});

test("avisa si el número del título no coincide con las filas o falta el coordinador", () => {
  const r = TI.tiendasTablaXml(hoja("mayores", [["Ana", 3]], "MAYORES - 9"), { util: UTIL, altoUtil: ALTO });
  assert.strictEqual(r.titulo, "MAYORES - 3");
  assert.ok(r.avisos.some((a) => /9 acampados/.test(a)));
  assert.ok(r.avisos.some((a) => /coordinador/i.test(a)));
});

test("los colores salen de la configuración central y cada nivel usa los suyos", () => {
  for (const n of ["pequenos", "medianos", "mayores"]) {
    const { fila, monitor } = TIENDAS.paleta[n];
    const xml = TI.tiendasTablaXml(hoja(n, [["Ana", 2]]), { util: UTIL, altoUtil: ALTO }).partes[0];
    assert.ok(xml.includes(`w:fill="${fila}"`) && xml.includes(`w:fill="${monitor}"`), n);
    assert.notStrictEqual(fila, monitor);
  }
});

test("anchos ≈ 18/20/29/33 % del ancho útil y la tabla ocupa todo el ancho", () => {
  const r = TI.tiendasTablaXml(hoja("medianos", [["Ana", 2]]), { util: UTIL, altoUtil: ALTO });
  assert.strictEqual(r.anchos.reduce((a, b) => a + b, 0), UTIL);
  [0.18, 0.2, 0.29, 0.33].forEach((p, i) => assert.ok(Math.abs(r.anchos[i] / UTIL - p) < 0.01));
});

test("el monitor es una celda combinada en vertical, en mayúsculas y sin repetir en cada fila", () => {
  const xml = TI.tiendasTablaXml(hoja("pequenos", [["Ana María", 4]]), { util: UTIL, altoUtil: ALTO }).partes[0];
  assert.strictEqual((xml.match(/w:vMerge w:val="restart"/g) || []).length, 1);
  assert.strictEqual((xml.match(/<w:vMerge\/>|w:vMerge w:val="continue"/g) || []).length, 3);
  assert.strictEqual((xml.match(/ANA MARÍA/g) || []).length, 1);
});

test("nunca se reduce la letra: todos los tamaños son los de la configuración", () => {
  const xml = TI.tiendasTablaXml(hoja("pequenos", [["Ana", 60, "Observación larga ".repeat(12)]]), { util: UTIL, altoUtil: ALTO }).partes.join("");
  const usados = new Set([...xml.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => +m[1] / 2));
  const permitidos = new Set([...Object.values(TIENDAS.fuentes), 1]); // 1 pt: marca de párrafo de las celdas vacías
  for (const u of usados) assert.ok(permitidos.has(u), `tamaño ${u} no permitido`);
});

test("si no cabe, se añade página (no se encoge), se repiten título y encabezado y los bloques pequeños no se parten", () => {
  const bloques = Array.from({ length: 12 }, (_, i) => [`Monitor${i}`, 5, "Alergia a algo con texto bastante largo para ocupar varias líneas en la columna de observaciones y obligar a crecer la fila"]);
  const r = TI.tiendasTablaXml(hoja("mayores", bloques), { util: UTIL, altoUtil: ALTO });
  assert.ok(r.partes.length >= 2);
  r.partes.forEach((p) => {
    assert.ok(p.includes(r.titulo), "título repetido");
    assert.ok(p.includes("MONITOR / RESPONSABLE"), "encabezado repetido");
    assert.strictEqual((p.match(/<w:tblHeader\/>/g) || []).length, 2);
  });
  // cada monitor aparece en una sola página (bloques de 5 filas caben enteros)
  for (let i = 0; i < 12; i++) assert.strictEqual(r.partes.filter((p) => p.includes(`MONITOR${i}<`)).length, 1, `MONITOR${i}`);
});

test("un bloque mayor que una página se parte por filas y el monitor se repite en cada trozo", () => {
  const r = TI.tiendasTablaXml(hoja("pequenos", [["Gigante", 90, "obs"]]), { util: UTIL, altoUtil: ALTO });
  assert.ok(r.partes.length >= 2);
  r.partes.forEach((p) => assert.ok(p.includes("GIGANTE<")));
  assert.strictEqual(r.partes.reduce((n, p) => n + (p.match(/Nombre\d+/g) || []).length, 0), 90);
});

test("el documento del macuto está apaisado en dos páginas", async () => {
  const JSZip = require("jszip");
  const fs = require("fs");
  const z = await JSZip.loadAsync(fs.readFileSync(require("path").join(__dirname, "../../assets/plannings/base/preparacion-macuto.docx")));
  const dx = await z.file("word/document.xml").async("string");
  const corte = dx.indexOf('w:br w:type="page"');
  assert.ok(/w:orient="landscape"/.test(dx));
  assert.strictEqual((dx.match(/w:br w:type="page"/g) || []).length, 1);
  assert.ok(dx.slice(0, corte).includes("MOCHILA PEQUEÑA") && !dx.slice(0, corte).includes("DEJAR PREPARADO"));
  assert.ok(dx.slice(corte).includes("DEJAR PREPARADO") && dx.slice(corte).includes("RECORDAR"));
});
