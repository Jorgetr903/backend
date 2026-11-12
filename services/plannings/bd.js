// services/plannings/bd.js
// Acceso a la biblioteca de la app (colección "Recurso" de MongoDB): las
// actividades y dinámicas que se suben cada año como PDF. El generador las
// usa directamente, sin tener que volver a subirlas.
//
// Los PDF están en Cloudinary (https://res.cloudinary.com/…) o, los antiguos,
// en public/uploads. Solo se descargan los que hacen falta al generar.

const fs = require("fs");
const path = require("path");

const UPLOADS_DIR = path.resolve(__dirname, "..", "..", "public", "uploads");
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const HOSTS_PERMITIDOS = [/(^|\.)cloudinary\.com$/i];

// Para pruebas: sustituye el acceso real a MongoDB / Cloudinary
let provider = null;
function setProvider(p) {
  provider = p;
}

/** Catálogo (solo metadatos) de actividades y dinámicas */
async function listCatalog() {
  if (provider) return provider.listCatalog();
  const mongoose = require("mongoose");
  if (mongoose.connection.readyState !== 1) throw new Error("la base de datos no está conectada");
  const Recurso = require("../../models/Recurso");
  const rows = await Recurso.find({ tipo: { $in: ["actividad", "dinamica"] } }, { titulo: 1, tipo: 1, anio: 1, momento: 1, grupo: 1, archivoUrl: 1, fecha: 1 })
    .sort({ fecha: 1, _id: 1 })
    .lean();
  return rows
    .filter((r) => r.titulo && r.archivoUrl)
    .map((r) => ({
      id: String(r._id),
      titulo: String(r.titulo).trim(),
      tipo: r.tipo === "dinamica" ? "dinamica" : "actividad",
      anio: Number.isInteger(r.anio) ? r.anio : null,
      momento: r.momento || null,
      grupo: r.grupo || null,
      url: r.archivoUrl,
      fecha: r.fecha ? new Date(r.fecha).getTime() : 0,
    }));
}

async function readLimited(res) {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > MAX_PDF_BYTES) throw new Error("el archivo es demasiado grande");
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_PDF_BYTES) throw new Error("el archivo es demasiado grande");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Descarga el PDF de un recurso del catálogo */
async function fetchPdf(entry) {
  if (provider) return provider.fetchPdf(entry);
  const raw = String(entry.url || "");
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !HOSTS_PERMITIDOS.some((re) => re.test(u.hostname))) {
      throw new Error("la dirección del archivo no es de la biblioteca de la app");
    }
    const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(45000) });
    if (!res.ok) throw new Error(`no se pudo descargar (HTTP ${res.status})`);
    return readLimited(res);
  }
  // archivo antiguo guardado en public/uploads
  let rel = decodeURIComponent(raw).replace(/^\/+/, "").replace(/^public\//, "").replace(/^uploads\//, "");
  const full = path.resolve(UPLOADS_DIR, rel);
  if (!full.startsWith(UPLOADS_DIR + path.sep)) throw new Error("ruta de archivo no válida");
  return fs.promises.readFile(full);
}

module.exports = { listCatalog, fetchPdf, setProvider, MAX_PDF_BYTES };
