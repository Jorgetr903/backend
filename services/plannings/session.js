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
const EXT_OK = new Set([".docx", ".xlsx", ".pdf", ".png", ".jpg", ".jpeg"]);
const IMG_EXT = new Set([".png", ".jpg", ".jpeg"]);

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

function sanitizeConfig(c) {
  const anio = parseInt(c.anio, 10);
  const niveles = Array.isArray(c.niveles) ? c.niveles.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 8) : NIVELES_DEFECTO;
  return {
    anio: anio >= 2000 && anio <= 2100 ? anio : new Date().getFullYear(),
    niveles: niveles.length ? niveles : NIVELES_DEFECTO,
    plannings: Array.isArray(c.plannings) ? c.plannings.map(String) : [],
    lema: c.lema != null ? String(c.lema).slice(0, 200) : "",
    enfermera: c.enfermera != null ? String(c.enfermera).slice(0, 60) : "",
    tema: c.tema != null ? String(c.tema).slice(0, 80) : "",
    bloques: c.bloques && typeof c.bloques === "object" ? c.bloques : {},
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

/**
 * Registra un archivo (ya escrito en la carpeta de la sesión).
 */
async function registerFile(s, { categoria, originalname, filePath, size }) {
  if (categoria === "auto") categoria = autoCategoria(originalname);
  if (!CATEGORIAS.some((c) => c.id === categoria)) throw Object.assign(new Error("Categoría no válida"), { status: 400 });
  const filename = fixFilename(originalname);
  const ext = path.extname(filename).toLowerCase();
  if (!EXT_OK.has(ext)) {
    fs.rmSync(filePath, { force: true });
    throw Object.assign(new Error(`"${filename}": solo se admiten archivos .docx, .xlsx, .pdf, imágenes PNG/JPG para el logo (o un .zip con ellos)`), { status: 400 });
  }
  if (IMG_EXT.has(ext) !== (categoria === "logo")) {
    fs.rmSync(filePath, { force: true });
    throw Object.assign(new Error(IMG_EXT.has(ext) ? `"${filename}": las imágenes solo se admiten en la categoría «Logo del año»` : `"${filename}": en «Logo del año» solo se admite una imagen PNG o JPG`), { status: 400 });
  }
  if (s.docs.size >= LIMITS.maxFiles) {
    fs.rmSync(filePath, { force: true });
    throw Object.assign(new Error(`Máximo ${LIMITS.maxFiles} archivos por sesión`), { status: 400 });
  }
  if (totalBytes(s) + size > LIMITS.maxTotal) {
    fs.rmSync(filePath, { force: true });
    throw Object.assign(new Error("Se ha superado el tamaño total permitido para la sesión"), { status: 400 });
  }
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
  if (IMG_EXT.has(ext)) {
    const head = (await fs.promises.readFile(filePath)).subarray(0, 4);
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const jpg = head[0] === 0xff && head[1] === 0xd8;
    if (!png && !jpg) {
      fs.rmSync(filePath, { force: true });
      throw Object.assign(new Error(`"${filename}" no es una imagen PNG o JPG válida`), { status: 400 });
    }
  }
  if (ext === ".docx") {
    doc.info = await readDocxInfo(await fs.promises.readFile(filePath));
    if (doc.info.ok && doc.info.title && doc.info.title.length <= 90) doc.titulo = doc.info.title;
  } else if (ext === ".xlsx") {
    // validación mínima: es un zip con xl/workbook.xml
    try {
      const z = await JSZip.loadAsync(await fs.promises.readFile(filePath));
      if (!z.file("xl/workbook.xml")) throw new Error("falta xl/workbook.xml");
    } catch (e) {
      fs.rmSync(filePath, { force: true });
      throw Object.assign(new Error(`"${filename}" no es un Excel (.xlsx) válido`), { status: 400 });
    }
  }
  s.docs.set(doc.id, doc);
  s.results = null; // cualquier cambio invalida lo generado
  return doc;
}

/** Descomprime un .zip en la carpeta de la sesión (con límites) */
async function addZip(s, categoria, zipPath, originalname) {
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
    added.push(await registerFile(s, { categoria, originalname: entry.name.split("/").pop(), filePath: fp, size: buf.length }));
  }
  fs.rmSync(zipPath, { force: true });
  return { added, skipped };
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
  secureDelete(d.path);
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

module.exports = { create, get, destroy, registerFile, addZip, removeDoc, sanitizeConfig, touch, LIMITS, ROOT, newId };
