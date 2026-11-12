// services/plannings/session.js
// Sesiones de trabajo del generador: carpeta temporal por sesión, estado en
// memoria, caducidad automática y borrado de archivos (datos sensibles:
// alergias, teléfonos de padres). Nada sale del servidor.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const JSZip = require("jszip");
const { readDocxInfo } = require("./docinfo");
const { fixFilename } = require("./textutil");
const { baseName, autoCategoria } = require("./classify");
const { CATEGORIAS, NIVELES_DEFECTO } = require("./analysis");
const { imageSize, looksLikeSvg, svgToPng } = require("./images");
const { pdfInfo } = require("./pdfpages");
const BD = require("./bd");
const BDX = require("./basedatos");

const ROOT = path.join(os.tmpdir(), "csp-plannings");
const TTL_MS = 3 * 60 * 60 * 1000; // 3 h sin actividad
const LIMITS = {
  maxFile: 25 * 1024 * 1024,
  maxZip: 100 * 1024 * 1024,
  maxFiles: 300,
  maxTotal: 300 * 1024 * 1024,
  maxSessions: 8,
  zipEntries: 400,
};
const EXT_OK = new Set([".docx", ".xlsx", ".pdf", ".png", ".jpg", ".jpeg", ".svg"]);
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".svg"]);

const sessions = new Map();

function newId(n = 8) {
  return crypto.randomBytes(n).toString("hex");
}

function touch(s) {
  s.touchedAt = Date.now();
}

function create(config = {}) {
  if (sessions.size >= LIMITS.maxSessions) {
    const err = new Error("Hay demasiadas sesiones abiertas en el servidor. Cierra alguna o espera unos minutos.");
    err.status = 429;
    throw err;
  }
  const id = newId(10);
  const dir = path.join(ROOT, id);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true, mode: 0o700 });
  const s = {
    id,
    dir,
    createdAt: Date.now(),
    touchedAt: Date.now(),
    config: sanitizeConfig(config),
    docs: new Map(),
    overrides: { items: {}, categorias: {} },
    results: null,
    busy: false,
  };
  sessions.set(id, s);
  return s;
}

/** "Mar, Pablo y Ana" → ["Mar","Pablo","Ana"] */
function listaDeNombres(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,;\n]|\s+y\s+/i);
  const out = [];
  for (const x of arr) {
    const n = String(x).replace(/\s+/g, " ").trim().slice(0, 60);
    if (n && !out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out.slice(0, 8);
}

function sanitizeConfig(c) {
  const anio = parseInt(c.anio, 10);
  const niveles = Array.isArray(c.niveles) ? c.niveles.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 8) : NIVELES_DEFECTO;
  const enfermeros = listaDeNombres(c.enfermeros != null ? c.enfermeros : c.enfermera);
  const nivelEnfermeros = {};
  if (c.nivelEnfermeros && typeof c.nivelEnfermeros === "object") {
    for (const [k, v] of Object.entries(c.nivelEnfermeros)) if (enfermeros.includes(k) && v) nivelEnfermeros[k] = String(v).slice(0, 40);
  }
  return {
    anio: anio >= 2000 && anio <= 2100 ? anio : new Date().getFullYear(),
    niveles: niveles.length ? niveles : NIVELES_DEFECTO,
    noPlannings: Array.isArray(c.noPlannings) ? c.noPlannings.map(String).slice(0, 40) : [],
    lema: c.lema != null ? String(c.lema).slice(0, 200) : "",
    enfermeros,
    nivelEnfermeros,
    tema: c.tema != null ? String(c.tema).slice(0, 80) : "",
  };
}

function get(id) {
  const s = sessions.get(String(id || ""));
  if (s) touch(s);
  return s || null;
}

function totalBytes(s) {
  let t = 0;
  for (const d of s.docs.values()) t += d.size;
  return t;
}

function numSubidos(s) {
  let n = 0;
  for (const d of s.docs.values()) if (d.origen !== "bd") n++;
  return n;
}

/**
 * Registra un archivo (ya escrito en la carpeta de la sesión).
 * `password` solo se usa para descifrar un Excel protegido; no se guarda.
 */
async function registerFile(s, { categoria, originalname, filePath, size, password = "" }) {
  if (categoria === "auto") categoria = autoCategoria(originalname);
  const reject = (msg, status = 400) => {
    fs.rmSync(filePath, { force: true });
    throw Object.assign(new Error(msg), { status });
  };
  if (!CATEGORIAS.some((c) => c.id === categoria)) reject("Categoría no válida");
  const filename = fixFilename(originalname);
  const ext = path.extname(filename).toLowerCase();
  if (!EXT_OK.has(ext)) {
    reject(`"${filename}": solo se admiten archivos .docx, .xlsx, .pdf, imágenes PNG/JPG/SVG para el logo (o un .zip con ellos)`);
  }
  if (IMG_EXT.has(ext) !== (categoria === "logo")) {
    reject(IMG_EXT.has(ext) ? `"${filename}": las imágenes solo se admiten en la categoría «Logo del año»` : `"${filename}": en «Logo del año» solo se admite una imagen (SVG, PNG o JPG)`);
  }
  if (numSubidos(s) >= LIMITS.maxFiles) reject(`Máximo ${LIMITS.maxFiles} archivos por sesión`);
  if (totalBytes(s) + size > LIMITS.maxTotal) reject("Se ha superado el tamaño total permitido para la sesión");
  const doc = {
    id: newId(5),
    categoria,
    filename,
    nombre: baseName(filename),
    ext,
    size,
    path: filePath,
    info: null,
    titulo: "",
    destinos: null,
    excluir: false,
  };
  let buf = await fs.promises.readFile(filePath);

  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
    if (!imageSize(buf)) reject(`"${filename}" no es una imagen PNG o JPG válida`);
  } else if (ext === ".svg") {
    if (!looksLikeSvg(buf)) reject(`"${filename}" no es un SVG válido (o pesa más de 5 MB)`);
    let conv;
    try {
      conv = svgToPng(buf);
    } catch (e) {
      reject(`"${filename}": ${e.message}`);
    }
    doc.pngPath = `${filePath}.png`;
    await fs.promises.writeFile(doc.pngPath, conv.png, { mode: 0o600 });
    doc.avisos = conv.avisos;
  } else if (ext === ".docx") {
    doc.info = await readDocxInfo(buf);
    if (doc.info.ok && doc.info.title && doc.info.title.length <= 90) doc.titulo = doc.info.title;
  } else if (ext === ".pdf") {
    doc.info = await pdfInfo(buf);
  } else if (ext === ".xlsx") {
    if (BDX.estaCifrado(buf) && categoria !== "base_datos") {
      reject(`"${filename}" está protegido con contraseña. Súbelo en la categoría «Base de Datos CSP», escribiendo la contraseña en su recuadro.`);
    }
    if (categoria === "base_datos") {
      // la contraseña solo vive en esta llamada; el archivo descifrado queda en la carpeta temporal de la sesión
      try {
        buf = await BDX.descifrar(buf, password);
      } catch (e) {
        reject(e.message, e.status || 400);
      }
      await fs.promises.writeFile(filePath, buf, { mode: 0o600 });
      doc.size = buf.length;
    }
    // validación mínima: es un zip con xl/workbook.xml
    try {
      const z = await JSZip.loadAsync(buf);
      if (!z.file("xl/workbook.xml")) throw new Error("falta xl/workbook.xml");
    } catch (e) {
      reject(`"${filename}" no es un Excel (.xlsx) válido`);
    }
    if (categoria === "base_datos") {
      try {
        doc.hojas = await BDX.nombresDeHojas(buf);
      } catch (e) {
        reject(`"${filename}": no se ha podido leer el Excel (${String(e.message).slice(0, 80)})`);
      }
      doc.hojasCfg = {};
    }
  }
  buf = null;
  s.docs.set(doc.id, doc);
  s.results = null; // cualquier cambio invalida lo generado
  return doc;
}

/** Descomprime un .zip en la carpeta de la sesión (con límites) */
async function addZip(s, categoria, zipPath, originalname, password = "") {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(zipPath));
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > LIMITS.zipEntries) throw Object.assign(new Error("El zip tiene demasiados archivos"), { status: 400 });
  const added = [];
  const skipped = [];
  for (const entry of entries) {
    const rawName = fixFilename(entry.name.split("/").pop());
    const ext = path.extname(rawName).toLowerCase();
    if (/(^|\/)__MACOSX\//.test(entry.name) || rawName.startsWith("~$") || rawName.startsWith(".") || !EXT_OK.has(ext)) {
      if (rawName && !rawName.startsWith(".") && !rawName.startsWith("~$") && !/__MACOSX/.test(entry.name)) skipped.push(rawName);
      continue;
    }
    const declared = entry._data && entry._data.uncompressedSize;
    if (declared && declared > LIMITS.maxFile) {
      skipped.push(`${rawName} (demasiado grande)`);
      continue;
    }
    const buf = await entry.async("nodebuffer");
    if (buf.length > LIMITS.maxFile) {
      skipped.push(`${rawName} (demasiado grande)`);
      continue;
    }
    const fp = path.join(s.dir, "files", newId(8) + ext);
    await fs.promises.writeFile(fp, buf, { mode: 0o600 });
    added.push(await registerFile(s, { categoria, originalname: entry.name.split("/").pop(), filePath: fp, size: buf.length, password }));
  }
  fs.rmSync(zipPath, { force: true });
  return { added, skipped };
}

/**
 * Carga (una vez por sesión) el catálogo de actividades y dinámicas de la app
 * y lo añade como documentos "virtuales" (origen "bd"); el PDF solo se
 * descarga al generar.
 */
async function ensureBd(s, force = false) {
  const viejo = s.bd;
  if (viejo && !force && !(viejo.error && Date.now() - viejo.cargado > 30000)) return viejo;
  let items = [];
  let error = null;
  try {
    items = await BD.listCatalog();
  } catch (e) {
    error = String((e && e.message) || e);
  }
  for (const [id, d] of s.docs) if (d.origen === "bd") s.docs.delete(id);
  for (const it of items) {
    const id = `bd-${it.id}`;
    s.docs.set(id, {
      id,
      origen: "bd",
      categoria: it.tipo === "dinamica" ? "dinamicas" : "actividades",
      filename: `${it.titulo}.pdf`,
      nombre: it.titulo,
      ext: ".pdf",
      size: 0,
      path: null,
      info: null,
      titulo: "",
      destinos: null,
      excluir: false,
      bd: it,
      anioBd: it.anio,
    });
  }
  s.bd = { cargado: Date.now(), error, total: items.length };
  s.results = null;
  return s.bd;
}

function secureDelete(file) {
  try {
    const st = fs.statSync(file);
    if (st.isFile() && st.size < 60 * 1024 * 1024) {
      const fd = fs.openSync(file, "r+");
      const chunk = Buffer.alloc(Math.min(st.size, 1024 * 1024));
      let left = st.size;
      let pos = 0;
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        fs.writeSync(fd, chunk, 0, n, pos);
        pos += n;
        left -= n;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
  } catch (_) {
    /* mejor esfuerzo */
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (_) {}
}

function removeDoc(s, id) {
  const d = s.docs.get(id);
  if (!d) return false;
  if (d.path) secureDelete(d.path);
  if (d.pngPath) secureDelete(d.pngPath);
  s.docs.delete(id);
  s.results = null;
  return true;
}

function destroyDirSecure(dir) {
  const walk = (p) => {
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) walk(fp);
      else secureDelete(fp);
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function destroy(id) {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  destroyDirSecure(s.dir);
  return true;
}

function sweep(orphanAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (!s.busy && now - s.touchedAt > TTL_MS) destroy(id);
  }
  // carpetas huérfanas (por un reinicio del servidor)
  try {
    for (const name of fs.readdirSync(ROOT)) {
      if (!sessions.has(name)) {
        const p = path.join(ROOT, name);
        const st = fs.statSync(p);
        if (now - st.mtimeMs >= orphanAgeMs) destroyDirSecure(p);
      }
    }
  } catch (_) {}
}

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
sweep(0); // al arrancar no hay sesiones: cualquier carpeta es un resto y se borra
const timer = setInterval(sweep, 10 * 60 * 1000);
timer.unref();

module.exports = { create, get, destroy, registerFile, addZip, removeDoc, sanitizeConfig, touch, ensureBd, listaDeNombres, LIMITS, ROOT, newId };
