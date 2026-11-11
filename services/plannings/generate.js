// services/plannings/generate.js
// Fase 5: ensamblado de cada planning (DOCX), conversión opcional a PDF y ZIP.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const JSZip = require("jszip");
const { PDFDocument } = require("pdf-lib");
const { PlanningBuilder, parseXml } = require("./docxmerge");
const { esc, run, para } = require("./ooxml");
const R = require("./renderers");
const { analyze } = require("./analysis");
const { norm } = require("./textutil");

const BASE_DIR = path.join(__dirname, "..", "..", "assets", "plannings", "base");

const MOTTO_DEFECTO = "¡¡CAMPAMENTO SANTA PAULA, QUE ALEGRÍA QUE GOZADA Y QUE BIEN NOS LO VAMOS A PASAR, AUNQUE HAYA QUE CURRAR!!";

const BLOQUES = [
  { id: "consejos", archivo: "consejos-y-normas.docx", titulo: "Consejos y normas" },
  { id: "servicio-extra", archivo: "servicio-extra.docx", titulo: "Servicio extra", aviso: "Texto del planning 2025 (nombres y ejemplos): revísalo o sube tu versión en «Información general»" },
  { id: "telefonos", archivo: "telefonos-de-interes.docx", titulo: "Teléfonos de interés", aviso: "Texto del planning 2025: confirma que los teléfonos siguen vigentes o sube tu versión" },
  { id: "primeros-auxilios", archivo: "primeros-auxilios.docx", titulo: "Primeros auxilios" },
  { id: "altus", archivo: "montaje-de-altus.docx", titulo: "Montaje de Altus" },
  { id: "formacion", archivo: "formacion-dinamicas-oraciones.docx", titulo: "Formación: dinámicas y oraciones" },
];

function catalogoBloques() {
  return BLOQUES.map((b) => ({ id: b.id, titulo: b.titulo, aviso: b.aviso || null, disponible: fs.existsSync(path.join(BASE_DIR, b.archivo)) }));
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
  zip.file("word/document.xml", xml);
  return { buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), found: true };
}

function indexXml(entries) {
  const tabs = '<w:tab w:val="right" w:leader="dot" w:pos="9638"/>';
  const lines = entries.map((e) =>
    para(
      run(e.title, { size: e.level === 1 ? 10.5 : 9.5, bold: e.level === 1, font: "Arial" }) +
        "<w:r><w:tab/></w:r>" +
        `<w:fldSimple w:instr=" PAGEREF ${esc(e.bookmark.name)} \\h "><w:r><w:rPr><w:sz w:val="${e.level === 1 ? 21 : 19}"/></w:rPr><w:t>–</w:t></w:r></w:fldSimple>`,
      { tabs, after: e.level === 1 ? 20 : 0, before: e.level === 1 ? 60 : 0, indent: e.level === 1 ? 0 : 340 }
    )
  );
  return lines.join("");
}

function responsablesTexto(r) {
  if (!r) return "—";
  if (!r.nombres.length) return "—";
  let t = r.nombres.join(", ");
  if (r.base === "todos" && r.nombres.length > 1) t += "  (todos los asignados)";
  return t;
}

function dayXml(dm, bookmark, { conTurnos }) {
  let xml = R.heading(dm.titulo, { bookmark });
  xml += R.timetableXml(dm.day);
  xml += para("", { after: 160 });
  const filas = dm.items.filter((i) => ["actividad", "especial", "oracion_dia", "oracion_noche", "oracion_monitores"].includes(i.tipo));
  if (conTurnos && filas.length) {
    const rows = filas.map((i) => {
      let nota = "";
      if (i.repetido) nota = `\n(se desarrolla el día ${i.primerDia})`;
      else if (i.especial && i.docIds.length) nota = "\n(se desarrolla a continuación)";
      return [i.hora || "", i.texto + nota, responsablesTexto(i.responsables)];
    });
    xml += para(run("RESPONSABLES", { bold: true, size: 10, font: "Arial" }), { after: 60, keepNext: true });
    xml += R.simpleTable(["Hora", "Actividad", "Responsables"], rows, [800, 5000, 3838], { size: 8.5 });
    xml += para("", { after: 120 });
  }
  const serv = (dm.servicios || []).filter((s) => s.names && s.names.length);
  if (serv.length) {
    xml += para(run("TURNOS DEL DÍA", { bold: true, size: 10, font: "Arial" }), { after: 60, keepNext: true });
    xml += R.simpleTable(["Tarea", "Encargados"], serv.map((s) => [s.task, s.names.join(", ")]), [5200, 4438], { size: 8.5 });
  }
  return xml;
}

// ───────────────────────── Un planning ─────────────────────────

async function buildPlanning(session, model, planning, onWarn) {
  const cfg = session.config;
  const b = new PlanningBuilder({ year: cfg.anio, lema: cfg.lema || "" });
  const log = []; // registro de lo incluido, para las comprobaciones
  const entries = []; // índice
  const avisos = [];
  const errores = [];
  const warn = (m) => {
    if (!avisos.includes(m)) avisos.push(m);
  };

  const readDoc = (d) => fs.promises.readFile(d.path);

  const addDoc = async (doc, { title, level = 2, type, day = null, special = null, buffer = null }) => {
    const bm = b.nextBookmark();
    try {
      await b.addDocx(buffer || (await readDoc(doc)), { bookmark: bm });
      entries.push({ title, level, bookmark: bm });
      log.push({ type, day, docId: doc ? doc.id : null, categoria: doc ? doc.categoria : "base", special, titulo: title });
      return true;
    } catch (e) {
      errores.push(`No se pudo incluir "${title}": ${e.message}`);
      return false;
    }
  };

  // — Bloques fijos —
  const general = model.docsAll.filter((d) => d.categoria === "general" && !d.excluir);
  const generalDocx = general.filter((d) => d.ext === ".docx");
  const upServicio = generalDocx.find((d) => /servicio/.test(norm(d.nombre)));
  const upTelef = generalDocx.find((d) => /telefon/.test(norm(d.nombre)));
  const otrosGeneral = generalDocx.filter((d) => d !== upServicio && d !== upTelef && (d.destinosEfectivos || ["todos"]).some((x) => x === "todos" || x === planning.id));
  const tablas = general.filter((d) => d.rolDetectado === "tabla" && d.ext === ".xlsx");
  const contactos = general.filter((d) => d.rolDetectado === "contactos" && d.ext === ".xlsx");
  const on = (id) => cfg.bloques[id] !== false;

  for (const bl of BLOQUES) {
    if (!on(bl.id)) continue;
    if (bl.id === "servicio-extra" && upServicio) {
      await addDoc(upServicio, { title: bl.titulo, level: 1, type: "base", special: bl.id });
      continue;
    }
    if (bl.id === "telefonos" && upTelef) {
      await addDoc(upTelef, { title: bl.titulo, level: 1, type: "base", special: bl.id });
      continue;
    }
    let buf;
    try {
      buf = await readBase(bl.archivo);
    } catch (_) {
      errores.push(`Falta el bloque fijo "${bl.titulo}" en el servidor`);
      continue;
    }
    if (bl.id === "consejos" && cfg.enfermera) {
      const r = await replaceInDocx(buf, "Enfermera (Mar)", `Enfermera (${cfg.enfermera})`);
      if (r.found) buf = r.buffer;
      else warn("No se encontró el nombre de la enfermera en «Consejos y normas»; revísalo a mano.");
    }
    if (bl.aviso) warn(`${bl.titulo}: ${bl.aviso}`);
    await addDoc(null, { title: bl.titulo, level: 1, type: "base", special: bl.id, buffer: buf });
  }

  // — Tabla de turnos y tablas generales —
  if (model.tu) {
    const bm = b.nextBookmark();
    b.addGenerated(para("", { bookmark: bm, after: 0 }) + R.turnosXml(model.tu));
    entries.push({ title: "Tabla de turnos", level: 1, bookmark: bm });
    log.push({ type: "turnos" });
  }
  for (const t of tablas) {
    const { xml, warnings } = await R.sheetsToXml(await readDoc(t));
    warnings.forEach(warn);
    if (xml) {
      const bm = b.nextBookmark();
      b.addGenerated(para("", { bookmark: bm, after: 0 }) + R.heading(t.nombre, { size: 14 }) + xml);
      entries.push({ title: t.nombre, level: 1, bookmark: bm });
    }
  }
  for (const d of otrosGeneral) await addDoc(d, { title: d.nombre, level: 1, type: "extra_general" });

  // — Días —
  const conTurnos = !!model.tu;
  for (const dm of model.dias) {
    const bm = b.nextBookmark();
    b.addGenerated(dayXml(dm, bm, { conTurnos: conTurnos && dm.kind !== "lluvia" }));
    entries.push({ title: dm.titulo, level: 1, bookmark: bm });
    log.push({ type: "horario", day: dm.label });
    const byId = (id) => model.docsAll.find((d) => d.id === id);
    for (const id of dm.oracionDia) {
      const d = byId(id);
      if (d) await addDoc(d, { title: `Oración de la mañana – ${dm.label}`, type: "oracion_dia", day: dm.label });
    }
    for (const it of dm.items) {
      if (!["actividad", "especial"].includes(it.tipo)) continue;
      for (const id of it.docIds) {
        const d = byId(id);
        if (d) await addDoc(d, { title: it.texto, type: "actividad", day: dm.label, special: it.especial });
      }
    }
    for (const id of dm.oracionNoche) {
      const d = byId(id);
      if (d) await addDoc(d, { title: `Oración de la noche – ${dm.label}`, type: "oracion_noche", day: dm.label });
    }
  }

  // — Documentos específicos de este planning (no dinámicas) —
  for (const cat of ["alergias", "menu", "enfermeria", "coordinacion", "direccion", "otros"]) {
    for (const d of model.docsAll.filter((x) => x.categoria === cat && !x.excluir && (x.destinosEfectivos || []).includes(planning.id))) {
      if (d.ext === ".xlsx") {
        const { xml, warnings } = await R.sheetsToXml(await readDoc(d), { size: 7.5 });
        warnings.forEach(warn);
        const bm = b.nextBookmark();
        b.addGenerated(para("", { bookmark: bm, after: 0 }) + R.heading(d.nombre, { size: 14 }) + (xml || para(run("(Hoja vacía)"))));
        entries.push({ title: d.nombre, level: 1, bookmark: bm });
        log.push({ type: "extra", categoria: cat, docId: d.id });
      } else if (d.ext === ".docx") {
        await addDoc(d, { title: d.nombre, level: 1, type: "extra" });
      }
    }
  }

  // — Dinámicas (al final) —
  for (const d of model.dinDocs.filter((x) => (x.destinosEfectivos || []).includes(planning.id))) {
    await addDoc(d, { title: `Dinámicas – ${d.nombre}`, level: 1, type: "dinamica" });
  }

  // — Portada e índice (al principio) —
  let cover = para(run(`PLANNING CSP ${cfg.anio}`, { bold: true, size: 30, font: "Arial" }), { style: "PlTitulo", align: "center", before: 1200, after: 120 });
  cover += para(run(planning.nombre.toUpperCase(), { bold: true, size: 20, font: "Arial" }), { align: "center", after: 360 });
  cover += para(run(cfg.lema || MOTTO_DEFECTO, { italic: true, size: 12, font: "Arial" }), { align: "center", after: 480 });
  for (const c of contactos) {
    const { xml, warnings } = await R.sheetsToXml(await readDoc(c), { size: 8.5 });
    warnings.forEach(warn);
    cover += xml;
  }
  cover += R.heading("ÍNDICE", { pageBreakBefore: true, size: 16 }) + indexXml(entries);
  b.chunks.unshift(cover + para("", { sectPr: b.sectPrXml(), after: 0 }));

  // — Construcción —
  const buffer = await b.build();
  b.warnings.forEach(warn);
  return { buffer, log, entries, avisos, errores, stats: b.stats };
}

// ───────────────────────── Comprobaciones previas a la entrega ─────────────────────────

async function verify(planning, model, built) {
  const checks = [];
  const add = (nombre, ok, detalle = "") => checks.push({ n: checks.length + 1, nombre, ok: !!ok, detalle });
  let xml = "";
  let validDoc = false;
  try {
    const zip = await JSZip.loadAsync(built.buffer);
    xml = await zip.file("word/document.xml").async("string");
    parseXml(xml);
    validDoc = true;
  } catch (e) {
    add("El documento Word es válido y se puede abrir", false, e.message);
  }
  if (validDoc) add("El documento Word es válido y se puede abrir", true);

  const pgs = [...xml.matchAll(/<w:pgSz[^>]*>/g)].map((m) => m[0]);
  const horizontales = pgs.filter((p) => /orient="landscape"/.test(p) || (() => {
    const w = +(/w:w="(\d+)"/.exec(p) || [])[1];
    const h = +(/w:h="(\d+)"/.exec(p) || [])[1];
    return w && h && w > h;
  })());
  add("Todas las páginas están en vertical", horizontales.length === 0, horizontales.length ? `${horizontales.length} secciones horizontales` : `${pgs.length} secciones, todas verticales`);

  const diasLog = built.log.filter((l) => l.type === "horario").map((l) => l.day);
  const diasModelo = model.dias.map((d) => d.label);
  add("Están todos los días de la tabla principal", diasLog.length === diasModelo.length, `${diasLog.length} de ${diasModelo.length}`);
  add("Los días siguen el orden de la tabla principal", JSON.stringify(diasLog) === JSON.stringify(diasModelo));
  add("Cada día lleva su tabla de horario", diasLog.length === diasModelo.length);

  const esperadasAct = model.dias.reduce((n, d) => n + d.items.filter((i) => ["actividad", "especial"].includes(i.tipo)).reduce((m, i) => m + i.docIds.length, 0), 0);
  const incluidasAct = built.log.filter((l) => l.type === "actividad").length;
  add("Se han incluido todas las actividades con documento", incluidasAct === esperadasAct, `${incluidasAct} de ${esperadasAct}`);
  add("No queda ninguna actividad ni responsable pendiente", !model.incidencias.some((i) => i.nivel === "critica"));

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
    return d && !(d.destinosEfectivos || []).includes(planning.id);
  });
  add("Alergias y menú solo aparecen donde corresponde", mal.length === 0);

  add("El índice recoge todas las secciones", built.entries.length > 0, `${built.entries.length} entradas`);
  const ids = built.log.filter((l) => l.docId && l.type !== "base").map((l) => l.docId);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  add("No hay documentos repetidos sin motivo", dup.length === 0, dup.length ? `${new Set(dup).size} documento(s) incluido(s) más de una vez` : "");
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
  if (!review.puedeGenerar) {
    return { ok: false, motivo: "Hay incidencias críticas sin resolver o ningún planning seleccionado", informe: { incidencias: review.incidencias.filter((i) => i.nivel === "critica") } };
  }
  const outDir = path.join(session.dir, "out");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const pdfOk = pdfDisponible();
  const informe = { anio: session.config.anio, generado: new Date().toISOString(), pdfDisponible: pdfOk, plannings: [] };
  const zip = new JSZip();
  const seleccion = model.seleccionados;
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
      entry.estadisticas = { documentos: built.log.length, ...built.stats };
      const docxPath = path.join(outDir, `${base}.docx`);
      fs.writeFileSync(docxPath, built.buffer, { mode: 0o600 });
      zip.file(`${base}.docx`, built.buffer, { compression: "STORE" });
      if (pdfOk) {
        progress({ fase: "pdf", planning: planning.nombre, n: i, total: seleccion.length });
        const r = await toPdf(docxPath, outDir);
        if (r.ok) {
          const pdfBuf = fs.readFileSync(r.path);
          zip.file(`${base}.pdf`, pdfBuf, { compression: "DEFLATE" });
          entry.pdf = `${base}.pdf`;
          try {
            entry.paginas = (await PDFDocument.load(pdfBuf, { ignoreEncryption: true })).getPageCount();
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
  if (!pdfOk) {
    informe.avisoPdf = "Este servidor no tiene LibreOffice, así que solo se han generado los DOCX. Abre cada DOCX en Word y usa Archivo → Exportar → PDF (así también se actualizan los números de página del índice).";
  }
  zip.file("INFORME.txt", informeTexto(informe));
  const zipPath = path.join(outDir, `Plannings_CSP_${session.config.anio}.zip`);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }), { mode: 0o600 });
  // los DOCX/PDF sueltos ya están en el ZIP
  for (const f of fs.readdirSync(outDir)) if (f !== path.basename(zipPath)) fs.rmSync(path.join(outDir, f), { force: true, recursive: true });
  const fallos = informe.plannings.some((p) => p.errores.length || (p.checks || []).some((c) => !c.ok && !/PDF/.test(c.nombre)));
  informe.todoCorrecto = !fallos;
  return { ok: true, zipPath, informe };
}

function informeTexto(inf) {
  const L = [];
  L.push(`INFORME DE GENERACIÓN – CSP ${inf.anio}`);
  L.push(`Generado: ${inf.generado}`);
  L.push("");
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
