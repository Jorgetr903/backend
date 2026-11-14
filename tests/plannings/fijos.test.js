const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { classifyLine } = require("../../services/plannings/timetable");

const BASE = path.join(__dirname, "../../assets/plannings/base");

test("los documentos fijos del macuto y del anexo de evaluación existen y son Word válidos", async () => {
  for (const f of ["preparacion-macuto.docx", "anexo-evaluacion.docx"]) {
    const buf = fs.readFileSync(path.join(BASE, f));
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("word/document.xml").async("string");
    assert.ok(xml.length > 5000, f);
  }
});

test("el anexo conserva su título y el macuto su contenido original", async () => {
  const txt = async (f) => (await (await JSZip.loadAsync(fs.readFileSync(path.join(BASE, f)))).file("word/document.xml").async("string")).replace(/<[^>]+>/g, "");
  assert.match(await txt("anexo-evaluacion.docx"), /EVALUACI/i);
  assert.match(await txt("preparacion-macuto.docx"), /MACUTO/i);
});

test("la línea del horario «preparación del macuto» se enlaza con el documento fijo", () => {
  const r = classifyLine("PREPARACIÓN DEL MACUTO MARCHA LARGA");
  assert.equal(r.type, "fijo");
  assert.equal(r.fijo, "macuto");
});
