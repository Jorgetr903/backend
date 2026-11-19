const test = require("node:test");
const assert = require("node:assert");
const { TIENDAS } = require("../../services/plannings/tablasConfig");
const TI = require("../../services/plannings/tiendas");

const PG = TIENDAS.pagina; // A4 apaisado
const UTIL = 16838 - PG.left - PG.right;
const ALTO = 11906 - PG.top - PG.bottom - 40;

test("las tablas de tiendas van en página apaisada", () => {
  assert.strictEqual(TIENDAS.apaisada, true);
});

function hoja(nivel, bloques, titulo) {
  return {
    titulo: titulo || `${nivel.toUpperCase()} - ${bloques.reduce((n, b) => n + b[1], 0)}`,
    nivel,
    bloques: bloques.map(([grupo, n, obs]) => ({
      grupo,
      filas: Array.from({ length: n }, (_, i) => ({ nombre: `Nombre${i}`, apellidos: `Apellido Apellido${i}`, obs: obs && i % 2 === 0 ? obs : "" })),
    })),
  };
}
const nTablas = (xml) => (xml.match(/<w:tbl>/g) || []).length;

test("el título lleva nivel y número real de acampados, sin coordinador", () => {
  const r = TI.tiendasTablaXml(hoja("pequenos", [["Ana", 3], ["Luis", 2]]), { util: UTIL, altoUtil: ALTO });
  assert.strictEqual(r.titulo, "PEQUEÑOS - 5");
  assert.strictEqual(r.partes.length, 1);
  assert.deepStrictEqual(r.avisos, []);
});

test("avisa si el número del título no coincide con las filas", () => {
  const r = TI.tiendasTablaXml(hoja("mayores", [["Ana", 3]], "MAYORES - 9"), { util: UTIL, altoUtil: ALTO });
  assert.strictEqual(r.titulo, "MAYORES - 3");
  assert.ok(r.avisos.some((a) => /9 acampados/.test(a)));
  assert.ok(!r.avisos.some((a) => /coordinador/i.test(a)));
});

test("aunque el banner del Excel traiga un coordinador, el título no lo muestra", () => {
  const r = TI.tiendasTablaXml(hoja("medianos", [["Ana", 3]], "MEDIANOS (Coordinador: Pepe) - 3"), { util: UTIL, altoUtil: ALTO });
  assert.strictEqual(r.titulo, "MEDIANOS - 3");
  assert.ok(!r.partes.join("").includes("Pepe"));
});

test("los colores salen de la configuración central y cada nivel usa los suyos", () => {
  for (const n of ["pequenos", "medianos", "mayores"]) {
    const { fila, monitor } = TIENDAS.paleta[n];
    const xml = TI.tiendasTablaXml(hoja(n, [["Ana", 2], ["Luis", 2]]), { util: UTIL, altoUtil: ALTO }).partes[0]; // 2 bloques: el 2.º lleva el pastel
    assert.ok(xml.includes(`w:fill="${fila}"`) && xml.includes(`w:fill="${monitor}"`), n);
    assert.notStrictEqual(fila, monitor);
  }
});

test("anchos ≈ 9/9/17/65 % del ancho útil (observaciones lo más ancho posible) y la tabla ocupa todo el ancho", () => {
  const r = TI.tiendasTablaXml(hoja("medianos", [["Ana", 2]]), { util: UTIL, altoUtil: ALTO });
  assert.strictEqual(r.anchos.reduce((a, b) => a + b, 0), UTIL);
  [0.09, 0.09, 0.17, 0.65].forEach((p, i) => assert.ok(Math.abs(r.anchos[i] / UTIL - p) < 0.01, `columna ${i}`));
});

test("un nivel de 30 acampados con observaciones largas cabe en una sola página", () => {
  const largo = "Dermatitis atópica: hidratación diaria tras ducha, en caso de brote aplicar crema y avisar a la familia. Asma: tratamiento en cámara, 3 pulsaciones cada 6/8 horas si hay síntomas respiratorios intensos.";
  const h = hoja("pequenos", [["SANDRA", 5, "Alergia frutos secos (1 pastilla) Aerius, lleva adrenalina por si acaso"], ["MARTA", 5, largo], ["MARCOS", 5, "Alergia al pescado y al kiwi"], ["JAIME", 5, largo], ["ROBERTO", 5, "Rinitis alérgica, dar antialérgico"], ["ALVARITO", 5, "Dolor de cabeza: ibuprofeno 5ml/8horas"]]);
  const r = TI.tiendasTablaXml(h, { util: UTIL, altoUtil: ALTO });
  assert.strictEqual(r.nChicos, 30);
  assert.strictEqual(r.paginas, 1);
});

test("si no cabe ni así, el nivel sigue en varias páginas sin cortar filas", () => {
  const h = hoja("pequenos", Array.from({ length: 12 }, (_, i) => [`M${i}`, 8, "Observación larga de prueba ".repeat(12)]));
  const r = TI.tiendasTablaXml(h, { util: UTIL, altoUtil: ALTO });
  assert.ok(r.paginas > 1);
});

test("todas las tablas de tiendas usan el mismo formato (letra y altura de fila), sea cual sea el nivel", () => {
  const sizes = (xml) => [...new Set((xml.match(/w:sz w:val="(\d+)"/g) || []).map((m) => m.replace(/\D/g, "")))].sort().join(",");
  const a = TI.tiendasTablaXml(hoja("pequenos", [["A", 5, "obs"], ["B", 5, "obs"], ["C", 5, "obs"]]), { util: UTIL, altoUtil: ALTO }).partes[0];
  const b = TI.tiendasTablaXml(hoja("mayores", [["A", 2, "obs"], ["B", 2, "obs"]]), { util: UTIL, altoUtil: ALTO }).partes[0];
  const c = TI.tiendasTablaXml(hoja("medianos", [["A", 3, "obs"], ["B", 3, "obs"]]), { util: UTIL, altoUtil: ALTO }).partes[0];
  assert.strictEqual(sizes(a), sizes(b));
  assert.strictEqual(sizes(b), sizes(c));
  assert.ok(sizes(a).split(",").includes("16"), "observaciones a 8 pt");
});

test("la hoja «Grupos de nivel» se marca como «No incluir» y las tiendas siguen siendo tiendas", () => {
  const B = require("../../services/plannings/basedatos");
  assert.strictEqual(B.rolPorNombre("Grupos de nivel"), "ignorar");
  assert.strictEqual(B.rolPorNombre("Tiendas con alergias"), "grupos_nivel");
  assert.ok(!B.ROLES_HOJA.some((r) => /grupos de nivel/i.test(r.nombre)), "ya no se ofrece «Grupos de nivel» como opción");
});

test("el macuto conserva su letra al unirlo al planning (Calibri 10 pt) y el resto se unifica a Calibri Light 11", async () => {
  const fs = require("fs");
  const JSZip = require("jszip");
  const { PlanningBuilder } = require("../../services/plannings/docxmerge");
  const buf = fs.readFileSync(require("path").join(__dirname, "../../assets/plannings/base/preparacion-macuto.docx"));
  const celda = async (conservarFormato) => {
    const b = new PlanningBuilder({ year: 2026 });
    await b.addDocx(buf, { conservarFormato });
    const dx = await (await JSZip.loadAsync(await b.build())).file("word/document.xml").async("string");
    return dx.slice(dx.indexOf("2 CAMISETAS") - 900, dx.indexOf("2 CAMISETAS"));
  };
  const con = await celda(true);
  assert.ok(/w:sz w:val="20"/.test(con) && /w:ascii="Calibri"/.test(con));
  const sin = await celda(false);
  assert.ok(/w:sz w:val="22"/.test(sin) && /w:ascii="Calibri Light"/.test(sin));
});

test("bloques alternos: el primero sin relleno y el segundo en pastel; título y monitor en el color del nivel", () => {
  const { fila, monitor } = TIENDAS.paleta.pequenos;
  assert.deepStrictEqual([fila, monitor], ["DEEAF6", "BDD6EE"]);
  const xml = TI.tiendasTablaXml(hoja("pequenos", [["Ana", 2], ["Luis", 2], ["Eva", 2]]), { util: UTIL, altoUtil: ALTO }).partes[0];
  assert.strictEqual((xml.match(new RegExp(`w:fill="${fila}"`, "g")) || []).length, 6); // solo el 2.º bloque: 2 filas × (nombre, apellidos, observaciones)
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

test("si no cabe, se añade página (no se encoge), se repite el título y los bloques pequeños no se parten", () => {
  const bloques = Array.from({ length: 12 }, (_, i) => [`Monitor${i}`, 5, "Alergia a algo con texto bastante largo para ocupar varias líneas en la columna de observaciones y obligar a crecer la fila"]);
  const r = TI.tiendasTablaXml(hoja("mayores", bloques), { util: UTIL, altoUtil: ALTO });
  assert.ok(r.partes.length >= 2);
  r.partes.forEach((p) => {
    assert.ok(p.includes(r.titulo), "título repetido");
    assert.ok(!p.includes("MONITOR / RESPONSABLE"), "sin fila de encabezado de columnas (como el planning de referencia)");
    assert.strictEqual((p.match(/<w:tblHeader\/>/g) || []).length, 1); // solo la fila del título se repite
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
