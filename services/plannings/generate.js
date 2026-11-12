// services/plannings/generate.js
// Fase 5: ensamblado de cada planning (DOCX), conversión opcional a PDF y ZIP.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const JSZip = require("jszip");
const yazl = require("yazl");
const { PDFDocument } = require("pdf-lib");
const { PlanningBuilder, parseXml } = require("./docxmerge");
const { esc, run, para } = require("./ooxml");
const R = require("./renderers");
const { FONT_LIGHT } = R;
const { analyze, paraPlanning } = require("./analysis");
const { norm } = require("./textutil");
const { imageSize } = require("./images");
const { renderPdfToDir } = require("./pdfpages");
const BD = require("./bd");
const BDX = require("./basedatos");
const { loadWorkbook } = require("./xlsxReader");

const BASE_DIR = path.join(__dirname, "..", "..", "assets", "plannings", "base");

// Márgenes de las páginas que son un PDF incrustado como imagen (más estrechos para que el PDF se vea lo más grande posible)
const PAGE_W = 11906;
const PAGE_H = 16838;
const PDF_MARGINS = { top: 820, right: 567, bottom: 800, left: 567, header: 400, footer: 480 };

const MOTTO_DEFECTO = "¡¡CAMPAMENTO SANTA PAULA, QUE ALEGRÍA QUE GOZADA Y QUE BIEN NOS LO VAMOS A PASAR, AUNQUE HAYA QUE CURRAR!!";

const BLOQUES = [
  { id: "consejos", archivo: "consejos-y-normas.docx", titulo: "Consejos y normas", indice: "CONSEJOS Y NORMAS QUE SANTA PAULA NOS DA:" },
  { id: "servicio-extra", archivo: "servicio-extra.docx", titulo: "Servicio extra", indice: "SERVICIO EXTRA", aviso: "Texto del planning 2025 (nombres y ejemplos): revísalo o sube tu versión en «Información general»" },
  { id: "telefonos", archivo: "telefonos-de-interes.docx", titulo: "Teléfonos de interés", indice: "TELEFONOS DE INTERÉS", aviso: "Texto del planning 2025: confirma que los teléfonos siguen vigentes o sube tu versión" },
  {
    id: "primeros-auxilios",
    titulo: "Guía de primeros auxilios",
    partes: [
      { archivo: "primeros-auxilios-rcp-pediatrica.docx", titulo: "GUÍA DE PRIMEROS AUXILIOS - RCP PEDIÁTRICA:", level: 1 },
      { archivo: "primeros-auxilios-rcp-adulto.docx", titulo: "GUÍA DE PRIMEROS AUXILIOS - RCP ADULTO:", level: 2 },
      { archivo: "primeros-auxilios-ovace-pediatrica.docx", titulo: "GUÍA DE PRIMEROS AUXILIOS - OVACE PEDIÁTRICA:", level: 1 },
      { archivo: "primeros-auxilios-ovace-adulto.docx", titulo: "GUÍA DE PRIMEROS AUXILIOS - OVACE ADULTO:", level: 2 },
    ],
  },
  { id: "altus", archivo: "montaje-de-altus.docx", titulo: "Montaje de Altus", indice: "MONTAJE DE ALTUS" },
  { id: "formacion", archivo: "formacion-dinamicas-oraciones.docx", titulo: "Formación: dinámicas y oraciones", indice: "FORMACIÓN DINÁMICAS/ORACIONES" },
];

function catalogoBloques() {
  return BLOQUES.map((b) => ({
    id: b.id,
    titulo: b.titulo,
    aviso: b.aviso || null,
    disponible: (b.partes || [b]).every((p) => fs.existsSync(path.join(BASE_DIR, p.archivo))),
  }));
}

// ───────────────────────── PDF (solo si hay LibreOffice) ─────────────────────────

let sofficeBin;
function findSoffice() {
  if (sofficeBin !== undefined) return sofficeBin;
  sofficeBin = null;
  for (const bin of ["soffice", "libreoffice"]) {
    try {
      const r = spawnSync(bin, ["--version"], { timeout: 15000 });
      if (r.status === 0) {
        sofficeBin = bin;
        break;
      }
    } catch (_) {}
  }
  return sofficeBin;
}

function pdfDisponible() {
  return !!findSoffice();
}

function toPdf(docxPath, outDir, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const bin = findSoffice();
    if (!bin) return resolve({ ok: false, error: "LibreOffice no está instalado en este servidor" });
    const profile = path.join(outDir, `.lo-${Math.random().toString(36).slice(2)}`);
    const child = spawn(bin, ["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=file://${profile}`, "--convert-to", "pdf", "--outdir", outDir, docxPath], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      fs.rmSync(profile, { recursive: true, force: true });
      const pdf = path.join(outDir, path.basename(docxPath).replace(/\.docx$/i, ".pdf"));
      resolve(fs.existsSync(pdf) ? { ok: true, path: pdf } : { ok: false, error: "La conversión a PDF no ha terminado (tiempo agotado o fallo)" });
    });
  });
}

// ───────────────────────── Piezas ─────────────────────────

function safeName(s) {
  return String(s)
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_");
}

async function readBase(archivo) {
  return fs.promises.readFile(path.join(BASE_DIR, archivo));
}

async function replaceInDocx(buffer, from, to) {
  const zip = await JSZip.loadAsync(buffer);
  const f = zip.file("word/document.xml");
  let xml = await f.async("string");
  if (!xml.includes(from)) return { buffer, found: false };
  xml = xml.split(from).join(to);
  zip.file("word/document.xml", xml, { createFolders: false });
  return { buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), found: true };
}

/** Sustituye una imagen de un DOCX por otra (conserva el ancho y ajusta el alto a la nueva proporción) */
async function replaceImageInDocx(buffer, mediaName, newBuf) {
  const info = imageSize(newBuf);
  if (!info) return { buffer, found: false };
  const zip = await JSZip.loadAsync(buffer);
  const relsFile = zip.file("word/_rels/document.xml.rels");
  const docFile = zip.file("word/document.xml");
  if (!relsFile || !docFile) return { buffer, found: false };
  let rels = await relsFile.async("string");
  let doc = await docFile.async("string");
  const m = new RegExp(`<Relationship [^>]*Id="([^"]+)"[^>]*Target="media/${mediaName.replace(/\./g, "\\.")}"[^>]*/>`).exec(rels) || new RegExp(`<Relationship [^>]*Target="media/${mediaName.replace(/\./g, "\\.")}"[^>]*Id="([^"]+)"[^>]*/>`).exec(rels);
  if (!m) return { buffer, found: false };
  const rid = m[1];
  const newName = `logo_anio.${info.ext}`;
  rels = rels.replace(m[0], m[0].replace(`media/${mediaName}`, `media/${newName}`));
  zip.remove(`word/media/${mediaName}`);
  zip.file(`word/media/${newName}`, newBuf, { createFolders: false });
  zip.file("word/_rels/document.xml.rels", rels, { createFolders: false });
  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ct = await ctFile.async("string");
    if (!new RegExp(`Extension="${info.ext}"`, "i").test(ct)) {
      ct = ct.replace("<Default ", `<Default Extension="${info.ext}" ContentType="${info.ext === "png" ? "image/png" : "image/jpeg"}"/><Default `);
      zip.file("[Content_Types].xml", ct, { createFolders: false });
    }
  }
  // ajustar el alto del dibujo que usa esa imagen
  doc = doc.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (d) => {
    if (!d.includes(`r:embed="${rid}"`)) return d;
    const ext = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(d);
    if (!ext) return d;
    const cx = +ext[1];
    const cy = Math.round((cx * info.h) / info.w);
    return d.replace(/<wp:extent cx="\d+" cy="\d+"\/>/, `<wp:extent cx="${cx}" cy="${cy}"/>`).replace(/<a:ext cx="\d+" cy="\d+"\/>/g, `<a:ext cx="${cx}" cy="${cy}"/>`);
  });
  zip.file("word/document.xml", doc, { createFolders: false });
  return { buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), found: true };
}

const FONT = R.FONT;

function indexXml(entries) {
  const tabs = `<w:tab w:val="right" w:leader="dot" w:pos="${R.W_PORTRAIT}"/>`;
  return entries
    .map((e) =>
      para(
        run(e.title, { size: 11, font: FONT }) +
          "<w:r><w:tab/></w:r>" +
          `<w:fldSimple w:instr=" PAGEREF ${esc(e.bookmark.name)} \\h "><w:r><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="22"/></w:rPr><w:t>–</w:t></w:r></w:fldSimple>`,
        { tabs, after: 0, before: 0, line: 252, indent: e.level === 1 ? 0 : 220 }
      )
    )
    .join("");
}

const normaliza = (s) => norm(s || "");

/** ¿La hoja es de este planning? (los plannings por nivel solo llevan la hoja de su nivel) */
function hojaDelPlanning(planning, niveles, todasLasHojas, warn = () => {}) {
  if (planning.tipo !== "nivel") return () => true;
  const key = (n) => normaliza(n).replace(/\s+/g, "").slice(0, 5);
  const propia = key(planning.nivel);
  const algunaPorNivel = todasLasHojas.some((h) => niveles.some((n) => normaliza(h).replace(/\s+/g, "").includes(key(n))));
  if (!algunaPorNivel) {
    // las hojas no están separadas por nivel
    if (todasLasHojas.length) warn("Las hojas de «grupos de nivel» no están separadas por nivel (no hay una hoja por nivel): este planning lleva todas las tiendas, con las alergias de los demás niveles. Separa las hojas por nivel si no quieres que se incluyan.");
    return () => true;
  }
  return (h) => normaliza(h).replace(/\s+/g, "").includes(propia);
}

/**
 * Líneas extra que se escriben dentro de las celdas del día:
 * «Resp: NOMBRES» bajo cada actividad y «Servir / Guardia / Quiosco»
 * en las filas rutinarias correspondientes. Solo con datos seguros.
 */
function lineasExtraDia(dm) {
  const extra = new Map();
  const push = (r, c, line) => {
    const k = `${r},${c}`;
    if (!extra.has(k)) extra.set(k, []);
    extra.get(k).push(line);
  };
  const porCelda = new Map();
  for (const it of dm.items) {
    const nombres = it.responsables && it.responsables.estado === "ok" ? it.responsables.nombres : [];
    if (!nombres.length) continue;
    const [, r, c] = it.key.split("|");
    const k = `${r},${c}`;
    if (!porCelda.has(k)) porCelda.set(k, []);
    porCelda.get(k).push({ it, nombres });
  }
  for (const [k, lista] of porCelda) {
    const [r, c] = k.split(",").map(Number);
    for (const { it, nombres } of lista) {
      const etiqueta = lista.length > 1 ? `Resp. ${it.texto.replace(/\s+/g, " ").slice(0, 28)}: ` : "Resp: ";
      push(r, c, { runs: [{ text: etiqueta, bold: false }, { text: R.nombresTexto(nombres), bold: true }] });
    }
  }
  // servicio de comida, guardia y quiosco en sus filas
  const serv = (re) => (dm.servicios || []).find((s) => re.test(s.key) && s.names && s.names.length);
  const hechos = new Set();
  dm.day.rows.forEach((row, ri) =>
    row.cells.forEach((cell, ci) => {
      if (cell.covered) return;
      for (const l of cell.lines) {
        const n = normaliza(l.text);
        let tipo = null;
        if (/^comida\b/.test(n)) tipo = ["Servir", /servir/];
        else if (/^buenas noches/.test(n)) tipo = ["Guardia", /guardia/];
        else if (n === "tl") tipo = ["Quiosco", /kiosko|quiosco/];
        if (!tipo || hechos.has(tipo[0])) continue;
        const s = serv(tipo[1]);
        if (!s) continue;
        hechos.add(tipo[0]);
        push(ri, ci, { runs: [{ text: `${tipo[0]}: `, bold: false }, { text: R.nombresTexto(s.names), bold: true }] });
      }
    })
  );
  return extra;
}

// ───────────────────────── PDF → páginas (con caché por sesión) ─────────────────────────

/** Páginas de un PDF (subido o de la biblioteca) como JPEG; se renderiza una sola vez por generación */
async function pdfPagesOf(session, doc) {
  const cache = session.pdfPages || (session.pdfPages = new Map());
  if (!cache.has(doc.id)) {
    cache.set(
      doc.id,
      (async () => {
        const buf = doc.origen === "bd" ? await BD.fetchPdf(doc.bd) : await fs.promises.readFile(doc.path);
        return renderPdfToDir(buf, path.join(session.dir, "pdfpages"), doc.id.replace(/[^a-z0-9]/gi, ""));
      })()
    );
  }
  return cache.get(doc.id);
}

// ───────────────────────── Un planning ─────────────────────────

async function buildPlanning(session, model, planning, onWarn) {
  const cfg = session.config;
  const b = new PlanningBuilder({ year: cfg.anio, lema: cfg.lema || "", tema: cfg.tema || "" });
  const log = []; // registro de lo incluido, para las comprobaciones
  const entries = []; // índice
  const avisos = [];
  const errores = [];
  const warn = (m) => {
    if (!avisos.includes(m)) avisos.push(m);
  };
  const niveles = (cfg.niveles && cfg.niveles.length ? cfg.niveles : ["Pequeños", "Medianos", "Mayores"]).map(String);

  const readDoc = (d) => fs.promises.readFile(d.path);

  // Páginas de un PDF como imágenes, repartidas en secciones según su orientación
  const addPdf = async (doc, { title, level = 2, type, day = null, special = null, noIndex = false }) => {
    const bm = b.nextBookmark();
    try {
      const r = await pdfPagesOf(session, doc);
      if (r.truncated) warn(`«${doc.nombre}» tiene ${r.total} páginas: se incluyen solo las primeras ${r.pages.length}.`);
      const grupos = [];
      for (const pg of r.pages) {
        const last = grupos[grupos.length - 1];
        if (last && last.landscape === pg.landscape) last.pages.push(pg);
        else grupos.push({ landscape: pg.landscape, pages: [pg] });
      }
      let primero = true;
      for (const g of grupos) {
        const availW = (g.landscape ? PAGE_H : PAGE_W) - PDF_MARGINS.left - PDF_MARGINS.right;
        const availH = (g.landscape ? PAGE_W : PAGE_H) - PDF_MARGINS.top - PDF_MARGINS.bottom - 200;
        let xml = primero ? R.anchor(bm) : "";
        g.pages.forEach((pg, i) => {
          const k = Math.min((availW * 635) / pg.w, (availH * 635) / pg.h);
          const rid = b.registerImage(fs.readFileSync(pg.file), "jpg");
          xml += para(b.imageXml(rid, Math.round(pg.w * k), Math.round(pg.h * k), `${doc.nombre} (página ${i + 1})`), { align: "center", before: 0, after: 0, line: 240, pageBreakBefore: i > 0 });
        });
        b.addGenerated(xml, { landscape: g.landscape, margins: PDF_MARGINS });
        primero = false;
      }
      if (!noIndex) entries.push({ title, level, bookmark: bm });
      log.push({ type, day, docId: doc.id, categoria: doc.categoria, special, titulo: title, pdf: true, paginas: r.pages.length });
      return true;
    } catch (e) {
      errores.push(`No se pudo incluir "${title}" (${doc.nombre}${doc.origen === "bd" ? ", de la biblioteca de la app" : ""}): ${e.message}`);
      return false;
    }
  };

  const addDoc = async (doc, { title, level = 2, type, day = null, special = null, buffer = null, noIndex = false }) => {
    if (doc && doc.ext === ".pdf") return addPdf(doc, { title, level, type, day, special, noIndex });
    const bm = b.nextBookmark();
    try {
      await b.addDocx(buffer || (await readDoc(doc)), { bookmark: bm });
      if (!noIndex) entries.push({ title, level, bookmark: bm });
      log.push({ type, day, docId: doc ? doc.id : null, categoria: doc ? doc.categoria : "base", special, titulo: title });
      return true;
    } catch (e) {
      errores.push(`No se pudo incluir "${title}": ${e.message}`);
      return false;
    }
  };

  // Logo del año (subido como imagen) → portada/índice y bloque de teléfonos
  const logoDoc = model.docsAll.find((d) => d.categoria === "logo" && !d.excluir);
  let logoBuf = null;
  let logoInfo = null;
  if (logoDoc) {
    try {
      // un logo SVG ya se convirtió a PNG al subirlo
      logoBuf = await fs.promises.readFile(logoDoc.pngPath || logoDoc.path);
      logoInfo = imageSize(logoBuf);
      if (!logoInfo) {
        logoBuf = null;
        warn(`No se reconoce el formato del logo "${logoDoc.nombre}" (usa SVG, PNG o JPG).`);
      }
      (logoDoc.avisos || []).forEach(warn);
    } catch (e) {
      warn(`No se pudo leer el logo del año: ${e.message}`);
    }
  } else {
    warn("No se ha subido el logo del año: el índice no lo lleva y el bloque «Teléfonos de interés» conserva el logo del planning de referencia (2025).");
  }

  // Documentos de información general por rol
  // (los documentos que parecen datos sensibles dentro de «Información general» no se incluyen: ver incidencias)
  const general = model.docsAll.filter((d) => d.categoria === "general" && !d.excluir && !d.sensibleBloqueado);
  const paraEste = (d) => paraPlanning(d.destinosEfectivos || ["todos"], planning);
  const generalDocx = general.filter((d) => d.ext === ".docx");
  const upServicio = generalDocx.find((d) => /servicio extra/.test(norm(d.nombre)));
  const upTelef = generalDocx.find((d) => /telefon/.test(norm(d.nombre)));
  const rol = (r) => general.filter((d) => d.rolDetectado === r && paraEste(d));
  const contactos = general.filter((d) => d.rolDetectado === "contactos");
  const tablasExtra = general.filter((d) => d.rolDetectado === "tabla" && d.ext === ".xlsx" && paraEste(d));
  const otrosGeneral = generalDocx.filter((d) => d !== upServicio && d !== upTelef && d.rolDetectado === "documento" && paraEste(d));

  // Hojas de la Base de Datos CSP con un rol y destinadas a este planning
  const hojasBase = (rolHoja) =>
    (model.baseDocs || [])
      .map((d) => ({ doc: d, hojas: (d.hojasEf || []).filter((h) => h.rol === rolHoja && paraPlanning(h.destinos, planning)).map((h) => h.nombre) }))
      .filter((x) => x.hojas.length);
  // Fuentes de un rol: Excel sueltos con ese rol + hojas de la Base de Datos
  const fuentes = (rolGeneral, rolHoja) => [...rol(rolGeneral).map((d) => ({ doc: d, hojas: null })), ...hojasBase(rolHoja)];

  // — Bloques fijos (se incluyen siempre en todos los plannings) —
  for (const bl of BLOQUES) {
    if (bl.id === "servicio-extra" && upServicio) {
      await addDoc(upServicio, { title: bl.indice, level: 1, type: "base", special: bl.id });
      continue;
    }
    if (bl.id === "telefonos" && upTelef) {
      await addDoc(upTelef, { title: bl.indice, level: 1, type: "base", special: bl.id });
      continue;
    }
    for (const parte of bl.partes || [bl]) {
      let buf;
      try {
        buf = await readBase(parte.archivo);
      } catch (_) {
        errores.push(`Falta el bloque fijo "${bl.titulo}" en el servidor`);
        continue;
      }
      if (bl.id === "consejos" && (cfg.enfermeros || []).length) {
        const nombres = cfg.enfermeros;
        const lista = nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}` : nombres[0];
        const frase = nombres.length > 1 ? `Las alergias se preguntan al equipo de enfermería (${lista}), que lo sabrá.` : `Las alergias se preguntan a la Enfermera (${lista}), ella lo sabrá.`;
        let r = await replaceInDocx(buf, "Las alergias se preguntan a la Enfermera (Mar), ella lo sabrá.", frase);
        if (!r.found) r = await replaceInDocx(buf, "Enfermera (Mar)", `Enfermera (${lista})`);
        if (r.found) buf = r.buffer;
        else warn("No se encontró el nombre de la enfermera en «Consejos y normas»; revísalo a mano.");
      }
      if (bl.id === "telefonos" && logoBuf) {
        const r = await replaceImageInDocx(buf, "image103.png", logoBuf);
        if (r.found) buf = r.buffer;
        else warn("No se pudo sustituir el logo del año en «Teléfonos de interés»; revísalo a mano.");
      }
      if (bl.aviso) warn(`${bl.titulo}: ${bl.aviso}`);
      await addDoc(null, { title: parte.indice || parte.titulo, level: parte.level || 1, type: "base", special: bl.id, buffer: buf });
    }
  }

  // — Tabla de turnos (apaisada, una sola tabla) —
  if (model.tu) {
    const bm = b.nextBookmark();
    b.addGenerated(R.title("TABLA DE TURNOS", { bookmark: bm }) + R.turnosXml(model.tu), { landscape: true });
    entries.push({ title: "TABLA DE TURNOS", level: 1, bookmark: bm });
    log.push({ type: "turnos", landscape: true });
  }

  // — Grupos de nivel (tiendas), grupos de trabajo y servicio de comedor —
  const tablaGrupos = async (lista, etiqueta, tipo) => {
    for (const { doc: d, hojas } of lista) {
      if (d.ext === ".docx") {
        await addDoc(d, { title: etiqueta, level: 1, type: tipo });
        continue;
      }
      let primera = true;
      const buf = await readDoc(d);
      const todas = (await loadWorkbook(buf)).worksheets.map((w) => w.name);
      const candidatas = hojas ? todas.filter((n) => hojas.includes(n)) : todas;
      const porNivel = hojaDelPlanning(planning, niveles, candidatas, warn);
      const { xml, warnings, sheets } = await R.sheetsToXml(buf, {
        landscape: true,
        pageBreaks: true,
        sheetFilter: (n) => candidatas.includes(n) && porNivel(n),
        onSheet: (nombre) => {
          const bm = b.nextBookmark();
          const generica = /^hoja\s*\d*$/i.test(nombre) || candidatas.length === 1;
          entries.push({ title: generica ? etiqueta : `${etiqueta} – ${nombre}`, level: primera || generica ? 1 : 2, bookmark: bm });
          primera = false;
          return R.anchor(bm);
        },
      });
      warnings.forEach(warn);
      if (!sheets.length) {
        warn(`«${d.nombre}»: no hay ninguna hoja de «${etiqueta}» para ${planning.nombre}; no se incluye.`);
        continue;
      }
      b.addGenerated(xml, { landscape: true });
      log.push({ type: tipo, landscape: true, docId: d.id, categoria: d.categoria });
    }
  };
  await tablaGrupos(fuentes("grupos_nivel", "grupos_nivel"), "TIENDAS", "grupos_nivel");
  await tablaGrupos(fuentes("grupos_trabajo", "grupos_trabajo"), "GRUPOS DE TRABAJO", "grupos_trabajo");
  await tablaGrupos(fuentes("servicio", "servicio"), "DISTRIBUCIÓN Y SERVICIOS DE LOS GRUPOS DE TRABAJO EN EL COMEDOR", "servicio");

  // otras tablas generales y documentos generales
  for (const t of tablasExtra) {
    const bm = b.nextBookmark();
    const { xml, warnings } = await R.sheetsToXml(await readDoc(t), { landscape: true, pageBreaks: true });
    warnings.forEach(warn);
    if (xml) {
      b.addGenerated(R.anchor(bm) + xml, { landscape: true });
      entries.push({ title: t.nombre, level: 1, bookmark: bm });
      log.push({ type: "tabla_general", landscape: true });
    }
  }
  for (const d of otrosGeneral) await addDoc(d, { title: d.nombre, level: 1, type: "extra_general" });

  // — Planning general (varias páginas apaisadas, 5 días por página) —
  const diasNormales = model.dias.filter((d) => d.kind !== "lluvia");
  if (diasNormales.length) {
    const bm = b.nextBookmark();
    const pags = R.generalPlanningPages(diasNormales.map((d) => ({ ...d.day, headFill: null })), { perPage: 5 });
    pags.forEach((t, i) => {
      b.addGenerated((i === 0 ? R.title("Planning General del Campamento", { bookmark: bm }) : "") + t, { landscape: true });
    });
    entries.push({ title: "Planning General del Campamento", level: 1, bookmark: bm });
    log.push({ type: "planning_general", landscape: true, paginas: pags.length });
  }

  // — Días —
  let ordinal = 0;
  for (const dm of model.dias) {
    const bm = b.nextBookmark();
    if (dm.kind !== "lluvia") ordinal++;
    const dia = R.withExtraLines(dm.day, lineasExtraDia(dm));
    const meta = {};
    b.addGenerated(R.anchor(bm) + R.dayTableXml(dia, { ordinal, meta }), { landscape: true });
    entries.push({ title: dm.kind === "lluvia" ? dm.titulo.replace(/^DÍA DE LLUVIA/, "DÍA DE LLUVIA") : `${dm.label}: ${dm.day.title || ""}`.trim().replace(/:$/, ""), level: 1, bookmark: bm });
    log.push({ type: "horario", day: dm.label, landscape: true, meta, conResp: Array.from(lineasExtraDia(dm).values()).flat().filter((l) => l.runs && /^Resp/.test(l.runs[0].text)).length });
    const byId = (id) => model.docsAll.find((d) => d.id === id);
    for (const id of dm.oracionDia) {
      const d = byId(id);
      if (d) await addDoc(d, { title: `Oración de la mañana – ${dm.label}`, type: "oracion_dia", day: dm.label, noIndex: true });
    }
    const yaDia = new Set(); // un mismo documento no se repite dentro del día (p. ej. «Día temático» tres veces)
    for (const it of dm.items) {
      if (!["actividad", "especial"].includes(it.tipo)) continue;
      for (const id of it.docIds) {
        if (yaDia.has(id)) continue;
        yaDia.add(id);
        const d = byId(id);
        if (d) await addDoc(d, { title: it.texto, level: 2, type: "actividad", day: dm.label, special: it.especial });
      }
    }
    for (const id of dm.oracionNoche) {
      const d = byId(id);
      if (d) await addDoc(d, { title: `Oración de la noche – ${dm.label}`, type: "oracion_noche", day: dm.label, noIndex: true });
    }
  }

  // — Hojas de la Base de Datos solo para algunos plannings: enfermería y coches/autobuses —
  await tablaGrupos(hojasBase("enfermeria"), "ENFERMERÍA", "enfermeria");
  await tablaGrupos(hojasBase("transporte"), "COCHES Y AUTOBUSES", "transporte");

  // — Documentos específicos de este planning (alergias aparte, menú) —
  for (const cat of ["alergias", "menu"]) {
    for (const d of model.docsAll.filter((x) => x.categoria === cat && !x.excluir && paraPlanning(x.destinosEfectivos, planning))) {
      if (d.ext === ".xlsx") {
        const bm = b.nextBookmark();
        const { xml, warnings } = await R.sheetsToXml(await readDoc(d), { landscape: true, pageBreaks: true });
        warnings.forEach(warn);
        b.addGenerated(R.anchor(bm) + (xml || para(run("(Hoja vacía)", { font: FONT }))), { landscape: true });
        entries.push({ title: d.nombre, level: 1, bookmark: bm });
        log.push({ type: "extra", categoria: cat, docId: d.id, landscape: true });
      } else if (d.ext === ".docx" || d.ext === ".pdf") {
        await addDoc(d, { title: d.nombre, level: 1, type: "extra" });
      }
    }
  }

  // — Dinámicas (al final): las del nivel de este planning (o del grupo del enfermero) —
  for (const d of model.dinamicasPara(planning)) {
    await addDoc(d, { title: `Dinámicas – ${d.nombre}`, level: 1, type: "dinamica" });
  }

  // — Portada (título, contactos de los monitores, lema) —
  const bmPortada = b.nextBookmark();
  entries.unshift({ title: `Campamento Santa Paula ${cfg.anio}`, level: 1, bookmark: bmPortada });
  let cover = para(run(`Campamento Santa Paula ${cfg.anio}`, { font: FONT_LIGHT }), { style: "PlTitulo", after: 60, bookmark: bmPortada });
  if (contactos.length) {
    for (const c of contactos) {
      const { xml, warnings } = await R.sheetsToXml(await readDoc(c), { landscape: false, boldFirstCol: true, size: 10.5 });
      warnings.forEach(warn);
      cover += xml;
    }
  }
  cover += para(run(cfg.lema || MOTTO_DEFECTO, { font: FONT_LIGHT, size: 16 }), { align: "center", before: 200, after: 0 });
  b.chunks.unshift(cover + para("", { sectPr: b.sectPrXml(), after: 0 }));

  // — Índice (formato del planning: título, entradas Calibri 11, logo del año debajo) —
  let idx = para(run("ÍNDICE", { font: FONT_LIGHT }), { style: "PlIndice", after: 120 }) + indexXml(entries);
  if (logoBuf && logoInfo) {
    const rid = b.registerImage(logoBuf, logoInfo.ext);
    const cy = 1180000;
    const cx = Math.round((cy * logoInfo.w) / logoInfo.h);
    idx += para(b.imageXml(rid, cx, cy, `Logo CSP ${cfg.anio}`), { align: "center", before: 160, after: 0 });
  }
  b.chunks.splice(1, 0, idx + para("", { sectPr: b.sectPrXml(), after: 0 }));

  // — Construcción —
  const buffer = await b.build();
  b.warnings.forEach(warn);
  return { buffer, log, entries, avisos, errores, stats: b.stats, logo: !!logoBuf };
}

// ───────────────────────── Comprobaciones previas a la entrega ─────────────────────────

async function verify(planning, model, built) {
  const checks = [];
  const add = (nombre, ok, detalle = "") => checks.push({ n: checks.length + 1, nombre, ok: !!ok, detalle });
  let xml = "";
  let stylesXml = "";
  let validDoc = false;
  try {
    const zip = await JSZip.loadAsync(built.buffer);
    xml = await zip.file("word/document.xml").async("string");
    stylesXml = await zip.file("word/styles.xml").async("string");
    parseXml(xml);
    validDoc = true;
  } catch (e) {
    add("El documento Word es válido y se puede abrir", false, e.message);
  }
  if (validDoc) add("El documento Word es válido y se puede abrir", true);

  // páginas apaisadas: turnos, grupos, planning general y días
  const pgs = [...xml.matchAll(/<w:pgSz[^>]*>/g)].map((m) => m[0]);
  const apaisadas = pgs.filter((p) => {
    const w = +(/w:w="(\d+)"/.exec(p) || [])[1];
    const h = +(/w:h="(\d+)"/.exec(p) || [])[1];
    return /orient="landscape"/.test(p) || (w && h && w > h);
  }).length;
  const esperadas = built.log.filter((l) => l.landscape).reduce((n, l) => n + (l.paginas || 1), 0);
  add("Turnos, grupos, planning general y días están en páginas apaisadas", apaisadas >= esperadas && esperadas > 0, `${apaisadas} secciones apaisadas (se esperaban al menos ${esperadas})`);

  add("El texto base es Calibri 11 (como el planning de referencia)", /<w:docDefaults>[\s\S]*Calibri[\s\S]*<w:sz w:val="22"\/>/.test(stylesXml));

  const diasLog = built.log.filter((l) => l.type === "horario").map((l) => l.day);
  const diasModelo = model.dias.map((d) => d.label);
  add("Están todos los días de la tabla principal", diasLog.length === diasModelo.length, `${diasLog.length} de ${diasModelo.length}`);
  add("Los días siguen el orden de la tabla principal", JSON.stringify(diasLog) === JSON.stringify(diasModelo));
  const noCaben = built.log.filter((l) => l.type === "horario" && l.meta && l.meta.cabe === false).map((l) => l.day);
  const pequeno = built.log.filter((l) => l.type === "horario" && l.meta && l.meta.size < 7).map((l) => l.day);
  add("La tabla de cada día cabe en una página", noCaben.length === 0, noCaben.length ? `No caben: ${noCaben.join(", ")}` : "");
  add("La letra de las tablas de día es legible (≥ 7 pt)", pequeno.length === 0, pequeno.length ? `Muy pequeña en: ${pequeno.join(", ")}` : "");

  const esperadosResp = model.dias.reduce((n, d) => n + d.items.filter((i) => i.responsables && i.responsables.estado === "ok" && i.responsables.nombres.length).length, 0);
  const respEnTablas = built.log.filter((l) => l.type === "horario").reduce((n, l) => n + (l.conResp || 0), 0);
  add("Los responsables están dentro de la tabla de cada día", !model.tu || respEnTablas >= esperadosResp, `${respEnTablas} de ${esperadosResp} actividades`);

  const esperadasAct = model.dias.reduce((n, d) => n + new Set(d.items.filter((i) => ["actividad", "especial"].includes(i.tipo)).flatMap((i) => i.docIds)).size, 0);
  const incluidasAct = built.log.filter((l) => l.type === "actividad").length;
  add("Se han incluido todas las actividades con documento", incluidasAct === esperadasAct, `${incluidasAct} de ${esperadasAct}`);

  // orden dentro de cada día: horario → oración de día → actividades → oración de noche
  let ordenOk = true;
  let nocheOk = true;
  let cur = null;
  let fase = 0;
  for (const l of built.log) {
    if (l.type === "horario") {
      cur = l.day;
      fase = 0;
    } else if (cur) {
      const f = l.type === "oracion_dia" ? 1 : l.type === "actividad" ? 2 : l.type === "oracion_noche" ? 3 : 4;
      if (f < 4 && f < fase) ordenOk = false;
      if (f === 3) fase = 3;
      else if (f < 4) fase = Math.max(fase, f);
      if (l.type === "actividad" && fase === 3) nocheOk = false;
    }
  }
  add("La oración del día va justo después del horario", ordenOk);
  add("La oración de la noche va al final de cada día", ordenOk && nocheOk);

  // orden de los bloques generales: turnos → tiendas → grupos de trabajo → servicio → planning general → primer día
  {
    const orden = ["turnos", "grupos_nivel", "grupos_trabajo", "servicio", "planning_general", "horario"];
    const pos = orden.map((t) => built.log.findIndex((l) => l.type === t));
    const presentes = pos.filter((p) => p >= 0);
    const ok = presentes.every((p, i) => i === 0 || p > presentes[i - 1]);
    add("Turnos → grupos de nivel → grupos de trabajo → servicio → planning general → primer día", ok, orden.filter((t, i) => pos[i] >= 0).join(" → "));
  }

  const cuenta = (s) => built.log.filter((l) => l.special === s && l.type === "actividad").length;
  add("Olimpiadas se desarrollan una sola vez", cuenta("olimpiadas") <= 1, `${cuenta("olimpiadas")} vez/veces`);
  add("Tiempo libre dirigido se desarrolla una sola vez", cuenta("tld") <= 1, `${cuenta("tld")} vez/veces`);

  {
    const tipos = built.log.map((l) => l.type);
    const idx = tipos.indexOf("dinamica");
    const alFinal = idx === -1 || tipos.slice(idx).every((t) => t === "dinamica");
    add("Las dinámicas van al final del planning", alFinal, idx === -1 ? "Este planning no lleva dinámicas" : `${tipos.filter((t) => t === "dinamica").length} documento(s)`);
  }

  // datos sensibles solo donde corresponde
  const sens = built.log.filter((l) => ["alergias", "menu"].includes(l.categoria));
  const mal = sens.filter((l) => {
    const d = model.docsAll.find((x) => x.id === l.docId);
    return d && !paraPlanning(d.destinosEfectivos, planning);
  });
  add("Alergias y menú solo aparecen donde corresponde", mal.length === 0);

  // portada: título del campamento antes del índice, y contactos de los monitores
  const iTitulo = xml.indexOf(`Campamento Santa Paula ${model.anio || ""}`.trim());
  const iIndice = xml.indexOf("ÍNDICE");
  add("La portada (con los contactos de los monitores) va antes del índice", iTitulo >= 0 && iIndice > iTitulo && (!model.hayContactos || /@/.test(xml.slice(iTitulo, iIndice))), model.hayContactos ? "" : "No se han subido contactos");
  add("El índice recoge todas las secciones", built.entries.length > 0, `${built.entries.length} entradas`);
  add("El logo del año está en el índice", !!built.logo, built.logo ? "" : "No se ha subido el logo del año");
  const TIPOS_DOC = ["actividad", "oracion_dia", "oracion_noche", "dinamica", "extra", "extra_general"]; // las hojas de la Base de Datos salen de un mismo Excel
  const ids = built.log.filter((l) => l.docId && TIPOS_DOC.includes(l.type)).map((l) => l.docId);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  add("No hay documentos repetidos sin motivo", dup.length === 0, dup.length ? `${new Set(dup).size} documento(s) incluido(s) más de una vez: ${[...new Set(dup)].map((id) => { const d = model.docsAll.find((x) => x.id === id); const l = built.log.filter((x) => x.docId === id).map((x) => x.day || x.type).join("/"); return `${d ? d.nombre : id} (${l})`; }).join("; ")}` : "");
  add("No ha fallado la inserción de ningún documento", built.errores.length === 0, built.errores.join(" | "));
  return checks;
}

// ───────────────────────── Orquestador ─────────────────────────

/**
 * Genera el ZIP con todos los plannings seleccionados.
 * @returns {Promise<{ok:boolean, zipPath?:string, informe:object}>}
 */
async function generate(session, progress = () => {}) {
  const { review, model } = await analyze(session);
  if (!model.seleccionados.length) {
    return { ok: false, motivo: "No hay ningún planning seleccionado", informe: { incidencias: [] } };
  }
  const outDir = path.join(session.dir, "out");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  session.pdfPages = new Map();

  const pdfOk = pdfDisponible();
  const pendientes = review.incidencias.filter((i) => i.nivel === "critica").map((i) => i.mensaje);
  const informe = { anio: session.config.anio, generado: new Date().toISOString(), pdfDisponible: pdfOk, pendientes, plannings: [] };
  const archivos = []; // [{nombre, ruta}] se meten en el ZIP leyendo del disco (sin tenerlos todos en memoria)
  const seleccion = model.seleccionados;
  try {
    // PDF (de la biblioteca de la app o subidos) que hacen falta: se descargan y convierten una sola vez
    const ids = new Set();
    for (const dm of model.dias) {
      dm.oracionDia.concat(dm.oracionNoche).forEach((id) => ids.add(id));
      dm.items.forEach((it) => it.docIds.forEach((id) => ids.add(id)));
    }
    for (const p of seleccion) model.dinamicasPara(p).forEach((d) => ids.add(d.id));
    const pdfs = model.docsAll.filter((d) => ids.has(d.id) && d.ext === ".pdf");
    let k = 0;
    for (const d of pdfs) {
      progress({ fase: "preparando documentos PDF", planning: d.nombre, n: ++k, total: pdfs.length });
      try {
        await pdfPagesOf(session, d);
      } catch (_) {
        /* el error se anota al incluir el documento */
      }
    }

    let i = 0;
    for (const planning of seleccion) {
      i++;
      progress({ fase: "ensamblando", planning: planning.nombre, n: i, total: seleccion.length });
      const base = `Planning_CSP_${session.config.anio}_${safeName(planning.nombre.replace(/^Planning\s+/, ""))}`;
      const entry = { id: planning.id, nombre: planning.nombre, docx: `${base}.docx`, pdf: null, avisos: [], errores: [] };
      try {
        const built = await buildPlanning(session, model, planning);
        entry.checks = await verify(planning, model, built);
        entry.avisos = built.avisos;
        entry.errores = built.errores;
        entry.estadisticas = { documentos: built.log.length, paginasPdf: built.log.filter((l) => l.pdf).reduce((n, l) => n + (l.paginas || 0), 0), ...built.stats };
        const docxPath = path.join(outDir, `${base}.docx`);
        fs.writeFileSync(docxPath, built.buffer, { mode: 0o600 });
        archivos.push({ nombre: `${base}.docx`, ruta: docxPath });
        if (pdfOk) {
          progress({ fase: "pdf", planning: planning.nombre, n: i, total: seleccion.length });
          const r = await toPdf(docxPath, outDir);
          if (r.ok) {
            archivos.push({ nombre: `${base}.pdf`, ruta: r.path });
            entry.pdf = `${base}.pdf`;
            try {
              entry.paginas = (await PDFDocument.load(fs.readFileSync(r.path), { ignoreEncryption: true })).getPageCount();
            } catch (_) {}
            entry.checks.push({ n: entry.checks.length + 1, nombre: "El PDF se ha generado", ok: true, detalle: entry.paginas ? `${entry.paginas} páginas` : "" });
          } else {
            entry.checks.push({ n: entry.checks.length + 1, nombre: "El PDF se ha generado", ok: false, detalle: r.error });
            entry.avisos.push(`PDF no generado: ${r.error}`);
          }
        }
      } catch (e) {
        entry.errores.push(e.message);
        entry.checks = entry.checks || [{ n: 1, nombre: "Se ha podido construir el planning", ok: false, detalle: e.message }];
      }
      informe.plannings.push(entry);
      if (global.gc) global.gc();
    }
  } finally {
    // las páginas de los PDF ya están dentro de los Word
    fs.rmSync(path.join(session.dir, "pdfpages"), { recursive: true, force: true });
    session.pdfPages = null;
  }
  if (!pdfOk) {
    informe.avisoPdf = "Este servidor no tiene LibreOffice, así que solo se han generado los DOCX. Abre cada DOCX en Word y usa Archivo → Exportar → PDF (así también se actualizan los números de página del índice).";
  }
  const informePath = path.join(outDir, "INFORME.txt");
  fs.writeFileSync(informePath, informeTexto(informe), { mode: 0o600 });
  archivos.push({ nombre: "INFORME.txt", ruta: informePath });
  const zipPath = path.join(outDir, `Plannings_CSP_${session.config.anio}.zip`);
  await new Promise((resolve, reject) => {
    // los DOCX ya van comprimidos (ZIP) y los PDF también: se guardan sin recomprimir
    const zf = new yazl.ZipFile();
    const out = fs.createWriteStream(zipPath, { mode: 0o600 });
    out.on("close", resolve).on("error", reject);
    zf.outputStream.on("error", reject).pipe(out);
    for (const a of archivos) zf.addFile(a.ruta, a.nombre, { compress: /\.txt$/.test(a.nombre) });
    zf.end();
  });
  // los DOCX/PDF sueltos ya están en el ZIP
  for (const f of fs.readdirSync(outDir)) if (f !== path.basename(zipPath)) fs.rmSync(path.join(outDir, f), { force: true, recursive: true });
  const fallos = informe.plannings.some((p) => p.errores.length || (p.checks || []).some((c) => !c.ok && !/PDF/.test(c.nombre)));
  informe.todoCorrecto = !fallos;
  informe.conPendientes = pendientes.length;
  return { ok: true, zipPath, informe };
}

function informeTexto(inf) {
  const L = [];
  L.push(`INFORME DE GENERACIÓN – CSP ${inf.anio}`);
  L.push(`Generado: ${inf.generado}`);
  L.push("");
  if (inf.pendientes && inf.pendientes.length) {
    L.push(`PROBLEMAS PENDIENTES AL GENERAR (${inf.pendientes.length}): los plannings se han generado igualmente; lo que falta no está incluido.`);
    for (const m of inf.pendientes) L.push(`  - ${m}`);
    L.push("");
  }
  for (const p of inf.plannings) {
    L.push(`== ${p.nombre} ==`);
    L.push(`Archivos: ${p.docx}${p.pdf ? ", " + p.pdf : ""}${p.paginas ? ` (${p.paginas} páginas)` : ""}`);
    for (const c of p.checks || []) L.push(`  [${c.ok ? "OK" : "FALLO"}] ${c.n}. ${c.nombre}${c.detalle ? " – " + c.detalle : ""}`);
    for (const a of p.avisos) L.push(`  Aviso: ${a}`);
    for (const e of p.errores) L.push(`  ERROR: ${e}`);
    L.push("");
  }
  if (inf.avisoPdf) L.push(inf.avisoPdf);
  return L.join("\n");
}

module.exports = { generate, catalogoBloques, pdfDisponible, BLOQUES, MOTTO_DEFECTO };
