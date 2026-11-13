// services/plannings/pdfworker.js
//
// Proceso hijo que convierte PDF → contenido editable (ver pdflayout.js).
// Vive aparte para que la conversión (pdf.js necesita bastante memoria) tenga
// su propio límite de memoria y, si algún PDF la agota, no se lleve por
// delante al servidor. Se recicla solo para devolver la memoria.
//
// Mensajes: {id, input, outFile} → {id, ok, error?}. El modelo se guarda en
// `outFile` (JSON) y cada imagen en `outFile.img<N>`.

const fs = require("fs");
const { convertPdf } = require("./pdflayout");

const MAX_DOCS = 12; // se reinicia después de tantos PDF
const MAX_RSS = 300 * 1024 * 1024; // o al superar esta memoria

let done = 0;

async function handle({ id, input, outFile }) {
  const model = await convertPdf(fs.readFileSync(input));
  const eids = new Map(); // enc → número de imagen
  const json = JSON.stringify(model, (k, v) => {
    if (k === "enc" && v && v.buf) {
      if (!eids.has(v)) {
        const n = eids.size;
        eids.set(v, n);
        fs.writeFileSync(`${outFile}.img${n}`, v.buf, { mode: 0o600 });
      }
      return { eid: eids.get(v), ext: v.ext, w: v.w, h: v.h };
    }
    return v;
  });
  fs.writeFileSync(outFile, json, { mode: 0o600 });
}

process.on("message", async (msg) => {
  try {
    await handle(msg);
    process.send({ id: msg.id, ok: true });
  } catch (e) {
    process.send({ id: msg.id, ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
  done++;
  if (done >= MAX_DOCS || process.memoryUsage().rss > MAX_RSS) process.exit(0);
});
process.send && process.send({ ready: true });
