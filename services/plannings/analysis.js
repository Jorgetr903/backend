// services/plannings/analysis.js
// Fase 2 y 3: análisis automático de los documentos subidos y construcción
// de la vista de revisión (con incidencias). También produce el "modelo"
// resuelto que usa el generador.

const fs = require("fs");
const crypto = require("crypto");
const { parseTimetable, dayItems } = require("./timetable");
const { parseTurnos, resolveDay } = require("./turnos");
const { matchItem, cleanActivityText, tier: confTier } = require("./matcher");
const { parseOracionText, detectLevel } = require("./classify");
const { norm } = require("./textutil");
const BDX = require("./basedatos");

// ───────────────────────── Catálogo ─────────────────────────

const CATEGORIAS = [
  { id: "general", nombre: "Información general", ayuda: "Tabla principal, turnos, contactos de monitores y, si no usas la Base de Datos CSP, grupos de nivel/trabajo y servicio" },
  { id: "base_datos", nombre: "Base de Datos CSP", ayuda: "Excel con tiendas y alergias, grupos de nivel y de trabajo, enfermería y coches/autobuses. Si tiene contraseña, escríbela al subirlo (se usa una sola vez y no se guarda)" },
  { id: "logo", nombre: "Logo del año", ayuda: "Imagen SVG, PNG o JPG con el logo de este año: sale en el índice y en «Teléfonos de interés»" },
  { id: "actividades", nombre: "Actividades (solo las que no estén en la app)", ayuda: "Las actividades se cogen solas de la biblioteca de la app (primero las del año, después las de otros años). Sube aquí solo las que falten o quieras cambiar (Word o PDF)" },
  { id: "oraciones", nombre: "Oraciones", ayuda: "Un Word o PDF por oración; el nombre indica el día y si es de noche" },
  { id: "dinamicas", nombre: "Dinámicas por nivel (solo las que no estén en la app)", ayuda: "Las dinámicas del año se cogen solas de la biblioteca de la app. Sube aquí solo las que falten o quieras cambiar" },
  { id: "alergias", nombre: "Alergias (documento aparte)", ayuda: "Solo si las alergias no están ya en la Base de Datos CSP. Datos sensibles: solo van a enfermería, coordinadores y director" },
  { id: "menu", nombre: "Menú", ayuda: "Solo enfermería y director" },
];

// Los destinos son identificadores de planning o clases ("enfermeria" = todos los plannings de enfermería)
const ESPECIALES = [
  { id: "enfermeria", clase: "enfermeria", nombre: "Planning Enfermería", requiere: ["base_datos"] },
  { id: "coordinadores", clase: "coordinadores", nombre: "Planning Coordinadores", requiere: ["base_datos"] },
  { id: "director", clase: "director", nombre: "Planning Director", requiere: ["base_datos"] },
];

const DESTINOS_DEFECTO = {
  alergias: ["enfermeria", "coordinadores", "director"],
  menu: ["enfermeria", "director"],
};

const NIVELES_DEFECTO = ["Pequeños", "Medianos", "Mayores"];

function slug(s) {
  return norm(s).replace(/\s+/g, "-") || "nivel";
}

/** ¿Un destino ("todos", id o clase) incluye a este planning? */
function paraPlanning(destinos, p) {
  return (destinos || []).some((x) => x === "todos" || x === p.id || x === p.clase);
}

/**
 * @param {object} config
 * @param {{grupos:{id:string,nombre:string,nivel:string|null,nombres:string[]}[]}} [enf] plannings de enfermería (uno por grupo de nivel)
 */
function listPlannings(config, enf) {
  const niveles = (config.niveles && config.niveles.length ? config.niveles : NIVELES_DEFECTO).map((n) => String(n).trim()).filter(Boolean);
  const especiales = [];
  for (const e of ESPECIALES) {
    if (e.clase === "enfermeria" && enf && enf.grupos && enf.grupos.length) {
      for (const g of enf.grupos) especiales.push({ ...e, id: g.id, nombre: g.nombre, nivel: g.nivel, nombres: g.nombres, tipo: "especial" });
    } else especiales.push({ ...e, tipo: "especial" });
  }
  return [...niveles.map((n) => ({ id: `nivel-${slug(n)}`, clase: "nivel", nombre: `Planning ${n}`, tipo: "nivel", nivel: n, requiere: ["dinamicas"] })), ...especiales];
}

// ───────────────────────── Lectura con caché ─────────────────────────

async function readBuf(doc) {
  return fs.promises.readFile(doc.path);
}

async function parsedTimetable(doc) {
  if (!doc._tt) doc._tt = await parseTimetable(await readBuf(doc));
  return doc._tt;
}
async function parsedTurnos(doc) {
  if (!doc._tu) doc._tu = await parseTurnos(await readBuf(doc));
  return doc._tu;
}

/** Rol de un documento de información general deducido del nombre (si el nombre es claro) */
function roleByName(doc) {
  const n = norm(doc.nombre);
  if (/\bcontactos?\b|telefonos? (de )?(los )?monitores|\bmonitores\b/.test(n)) return "contactos";
  if (/grupos? (de )?trabajo/.test(n)) return "grupos_trabajo";
  if (/grupos? (de )?nivel|\btiendas?\b|\bpequenos\b|\bmedianos\b|\bmayores\b/.test(n)) return "grupos_nivel";
  if (doc.ext === ".xlsx" && /servicios?|comedor|fregado|distribucion/.test(n)) return "servicio";
  return null;
}

/** Rol de un documento de "información general" */
async function detectGeneralRole(doc) {
  if (doc.rol) return doc.rol;
  if (doc.ext !== ".xlsx") return roleByName(doc) || "documento";
  try {
    const tt = await parsedTimetable(doc);
    if (tt.days.filter((d) => d.kind === "dia").length >= 2) return "principal";
  } catch (_) {}
  try {
    const tu = await parsedTurnos(doc);
    if (tu.monitors.length >= 2 && tu.days.length >= 2) return "turnos";
  } catch (_) {}
  return roleByName(doc) || "tabla";
}

// ───────────────────────── Emparejamiento por niveles de prioridad ─────────────────────────

const RANK = { clara: 3, probable: 2, dudosa: 1, sin_coincidencia: 0 };
const buenaCoincidencia = (m) => m.confidence === "clara" || m.confidence === "probable";

function firma(docs) {
  return crypto.createHash("md5").update(docs.map((d) => d.id).join(",")).digest("hex").slice(0, 10);
}

/**
 * Empareja una actividad del horario con los documentos disponibles por
 * orden de prioridad: primero lo subido a mano, después la biblioteca de la
 * app del año del campamento y, si no aparece ahí, la de otros años (del más
 * cercano al más lejano). Gana el primer nivel con una coincidencia clara o
 * probable.
 */
function matchTiered(session, it, tiers) {
  const cache = session._matchCache || (session._matchCache = new Map());
  const one = (item, t) => {
    const key = `${item.special || ""}|${item.text}|${t.nombre}|${t.sig}`;
    if (!cache.has(key)) cache.set(key, matchItem(item, t.docs));
    return cache.get(key);
  };
  let best = null;
  for (const t of tiers) {
    if (!t.docs.length) continue;
    const m = one(it, t);
    if (buenaCoincidencia(m) && !m.parcial) return { ...m, tier: t.nombre };
    if (!best || RANK[m.confidence] > RANK[best.confidence] || (RANK[m.confidence] === RANK[best.confidence] && m.score > best.score)) best = { ...m, tier: t.nombre };
  }
  // "A + B": cada parte puede estar en un nivel distinto
  const parts = it.special ? [] : cleanActivityText(it.text).split(/\s*\+\s*/).filter(Boolean);
  if (parts.length > 1) {
    const found = [];
    const usados = [];
    let min = 1;
    for (const part of parts) {
      for (const t of tiers) {
        if (!t.docs.length) continue;
        const m = one({ ...it, text: part, special: null }, t);
        if (buenaCoincidencia(m) && m.docIds.length === 1) {
          if (!found.includes(m.docIds[0])) {
            found.push(m.docIds[0]);
            usados.push(t.nombre);
            min = Math.min(min, m.score);
          }
          break;
        }
      }
    }
    if (found.length) {
      const parcial = found.length < parts.length;
      const cand = { docIds: found, confidence: parcial ? "dudosa" : confTier(min), score: min, candidates: best ? best.candidates : [], parcial, tier: [...new Set(usados)].join(" + ") };
      if (!best || RANK[cand.confidence] > RANK[best.confidence] || (RANK[cand.confidence] === RANK[best.confidence] && cand.docIds.length > best.docIds.length)) return cand;
    }
  }
  return best || { docIds: [], confidence: "sin_coincidencia", score: 0, candidates: [] };
}

// ───────────────────────── Enfermeros ─────────────────────────

/**
 * Para cada enfermero/a averigua su grupo de nivel (buscando su nombre en las
 * tablas de grupos de nivel) y agrupa los plannings de enfermería: uno por
 * cada grupo de nivel distinto.
 */
async function resolverEnfermeros(session, cfg, niveles, baseDocs, nivelDocs) {
  const nombres = cfg.enfermeros || [];
  const items = [];
  if (!nombres.length) return { items, grupos: [] };
  const fuentes = [];
  for (const d of baseDocs) {
    const hojas = (d.hojasEf || []).filter((h) => h.rol === "grupos_nivel").map((h) => h.nombre);
    if (hojas.length) fuentes.push({ doc: d, hojas });
  }
  for (const d of nivelDocs) fuentes.push({ doc: d, hojas: null });
  const cache = session._nurseCache || (session._nurseCache = new Map());
  for (const nombre of nombres) {
    const manual = cfg.nivelEnfermeros && cfg.nivelEnfermeros[nombre];
    if (manual) {
      items.push({ nombre, nivel: manual, via: "manual", estado: "ok" });
      continue;
    }
    if (!fuentes.length) {
      items.push({ nombre, nivel: null, via: null, estado: "sin_datos", motivo: "Falta la Base de Datos CSP (o el Excel de grupos de nivel) para saber su grupo." });
      continue;
    }
    const key = `${nombre}|${niveles.join(",")}|${fuentes.map((f) => `${f.doc.id}:${(f.hojas || []).join("/")}`).join(";")}`;
    if (!cache.has(key)) {
      const fs_ = [];
      for (const f of fuentes) fs_.push({ buffer: await readBuf(f.doc), hojas: f.hojas });
      cache.set(key, await BDX.nivelDeMonitor(fs_, nombre, niveles));
    }
    const r = cache.get(key);
    if (r.niveles.length === 1) items.push({ nombre, nivel: r.niveles[0], via: r.apariciones.find((a) => a.nivel)?.via || null, estado: "ok" });
    else if (r.niveles.length > 1) items.push({ nombre, nivel: null, via: null, estado: "ambiguo", candidatos: r.niveles, motivo: `Aparece en varios grupos de nivel (${r.niveles.join(", ")}). Elige el suyo.` });
    else if (r.encontrado) items.push({ nombre, nivel: null, via: null, estado: "sin_nivel", motivo: "Aparece en las tablas, pero no se sabe de qué nivel es esa hoja o sección. Elige su grupo." });
    else items.push({ nombre, nivel: null, via: null, estado: "no_encontrado", motivo: "No aparece en las tablas de grupos de nivel (¿está escrito igual que en el Excel?). Elige su grupo." });
  }
  const porNivel = new Map();
  for (const it of items) {
    const k = it.nivel || "";
    if (!porNivel.has(k)) porNivel.set(k, []);
    porNivel.get(k).push(it.nombre);
  }
  const varios = porNivel.size > 1;
  const grupos = [...porNivel].map(([k, ns]) => ({
    nivel: k || null,
    nombres: ns,
    id: k ? `enfermeria-${slug(k)}` : varios ? "enfermeria-sin-grupo" : "enfermeria",
    nombre: varios ? `Planning Enfermería (${k || "sin grupo"})` : "Planning Enfermería",
  }));
  return { items, grupos };
}

// ───────────────────────── Análisis ─────────────────────────

/**
 * @param {object} session {config, docs:Map, overrides}
 * @returns {Promise<{review:object, model:object}>}
 */
async function analyze(session) {
  const S = require("./session");
  await S.ensureBd(session);
  const cfg = session.config;
  const ov = session.overrides || { items: {}, categorias: {} };
  const docsAll = [...session.docs.values()];
  const subidos = docsAll.filter((d) => d.origen !== "bd");
  const incidencias = [];
  const inc = (nivel, codigo, mensaje, ref = {}) =>
    incidencias.push({ id: `${codigo}:${ref.docId || ref.key || ref.dia || ref.categoria || ""}:${incidencias.length}`, nivel, codigo, mensaje, ...ref });
  const niveles = (cfg.niveles && cfg.niveles.length ? cfg.niveles : NIVELES_DEFECTO).map((n) => String(n).trim()).filter(Boolean);

  if (session.bd && session.bd.error) {
    inc("aviso", "bd_no_disponible", `No se ha podido leer la biblioteca de la app (${session.bd.error}). Sube a mano las actividades y dinámicas o pulsa «Actualizar desde la app».`, { categoria: "actividades" });
  }

  // 1. Documentos de "general": roles
  const general = subidos.filter((d) => d.categoria === "general");
  for (const d of general) d.rolDetectado = await detectGeneralRole(d);
  const principal = general.filter((d) => d.rolDetectado === "principal" && !d.excluir);
  const turnosDocs = general.filter((d) => d.rolDetectado === "turnos" && !d.excluir);

  if (!principal.length) inc("critica", "falta_principal", "Falta la tabla principal del campamento (Excel con los días y el horario).", { categoria: "general" });
  if (principal.length > 1) inc("critica", "varias_principal", "Hay más de una tabla principal; marca cuál sobra como 'excluir'. Mientras tanto se usa la primera.", { categoria: "general" });
  if (!turnosDocs.length) inc("critica", "falta_turnos", "Falta la tabla de turnos (Excel con los monitores y sus tareas por día).", { categoria: "general" });
  const contactosDocs = general.filter((d) => d.rolDetectado === "contactos" && !d.excluir);
  if (!contactosDocs.length) inc("critica", "falta_contactos", "Falta la tabla con los nombres, correos y teléfonos de todos los monitores (va en la portada, antes del índice).", { categoria: "general" });
  if (turnosDocs.length > 1) inc("critica", "varias_turnos", "Hay más de una tabla de turnos; marca cuál sobra como 'excluir'. Mientras tanto se usa la primera.", { categoria: "general" });

  // Base de Datos CSP: roles de cada hoja
  const baseDocs = subidos.filter((d) => d.categoria === "base_datos" && !d.excluir);
  for (const d of baseDocs) {
    d.hojasEf = (d.hojas || []).map((nombre) => {
      const c = (d.hojasCfg && d.hojasCfg[nombre]) || {};
      const auto = BDX.rolPorNombre(nombre);
      const rol = c.rol || auto || "ignorar";
      const destinos = c.destinos && c.destinos.length ? c.destinos : BDX.destinosPorDefecto(rol);
      return { nombre, rol, destinos, reconocida: !!(auto || c.rol), manual: !!c.rol };
    });
    for (const h of d.hojasEf) {
      if (!h.reconocida) inc("aviso", "hoja_sin_rol", `La hoja «${h.nombre}» de «${d.nombre}» no se ha reconocido por su nombre y no se incluirá. Indica qué contiene.`, { docId: d.id });
    }
  }

  let tt = null;
  let tu = null;
  if (principal.length >= 1) {
    try {
      tt = await parsedTimetable(principal[0]);
      tt.warnings.forEach((w) => inc("aviso", "tabla_principal", w, { docId: principal[0].id }));
    } catch (e) {
      inc("critica", "principal_ilegible", `No se pudo leer la tabla principal: ${e.message}`, { docId: principal[0].id });
    }
  }
  if (turnosDocs.length >= 1) {
    try {
      tu = await parsedTurnos(turnosDocs[0]);
      tu.warnings.forEach((w) => inc("aviso", "turnos", w, { docId: turnosDocs[0].id }));
    } catch (e) {
      inc("critica", "turnos_ilegible", `No se pudo leer la tabla de turnos: ${e.message}`, { docId: turnosDocs[0].id });
    }
  }

  // 2. Actividades, oraciones y dinámicas (subidas a mano + biblioteca de la app)
  const actUp = subidos.filter((d) => d.categoria === "actividades" && !d.excluir);
  const actBd = docsAll.filter((d) => d.origen === "bd" && d.categoria === "actividades");
  const oraDocs = subidos.filter((d) => d.categoria === "oraciones" && !d.excluir);
  const dinUp = subidos.filter((d) => d.categoria === "dinamicas" && !d.excluir);
  const dinBd = docsAll.filter((d) => d.origen === "bd" && d.categoria === "dinamicas");

  // niveles de prioridad para las actividades: subidas → año del campamento → otros años (de más cercano a más lejano)
  const aniosOtros = [...new Set(actBd.map((d) => d.anioBd).filter((y) => y != null && y !== cfg.anio))].sort((a, b) => {
    const pa = a < cfg.anio ? 0 : 1;
    const pb = b < cfg.anio ? 0 : 1;
    return pa - pb || (a < cfg.anio ? b - a : a - b);
  });
  const mkTier = (nombre, docs) => ({ nombre, docs, sig: firma(docs) });
  const tiers = [
    mkTier("subido", actUp),
    mkTier(`biblioteca ${cfg.anio}`, actBd.filter((d) => d.anioBd === cfg.anio)),
    ...aniosOtros.map((y) => mkTier(`biblioteca ${y}`, actBd.filter((d) => d.anioBd === y))),
    mkTier("biblioteca sin año", actBd.filter((d) => d.anioBd == null)),
  ];
  const actDocsTodas = [...actUp, ...actBd];

  for (const d of [...actUp, ...oraDocs, ...dinUp]) {
    if (d.info && !d.info.ok) inc("critica", "doc_ilegible", `"${d.nombre}": ${d.info.error}`, { docId: d.id });
  }

  // Datos sensibles que no deben ir a "Información general" (se incluiría en todos los plannings)
  for (const d of general) {
    if (d.excluir) continue;
    if (/(alergi|padres|menu|medicaci)/.test(norm(d.nombre)) && !(d.destinos && d.destinos.length)) {
      d.sensibleBloqueado = true;
      inc("critica", "sensible_en_general", `"${d.nombre}" parece contener datos sensibles y está en Información general (iría a todos los plannings), así que NO se incluirá hasta que lo muevas a su categoría o indiques a qué plannings va.`, { docId: d.id, sugerida: /menu/.test(norm(d.nombre)) ? "menu" : "alergias" });
    }
  }

  // Documentos que parecen estar en la categoría equivocada
  for (const d of actUp) {
    if (/\boracion\b/.test(norm(d.nombre))) inc("critica", "categoria_dudosa", `"${d.nombre}" parece una oración pero está en Actividades. Muévelo a Oraciones.`, { docId: d.id, sugerida: "oraciones" });
  }

  // Oraciones: día y tipo a partir del nombre (con corrección manual por documento)
  const oraciones = oraDocs.map((d) => {
    const p = parseOracionText(d.filename);
    const day = d.dia || p.day;
    const night = d.noche != null ? d.noche : p.night;
    return { docId: d.id, nombre: d.nombre, titulo: p.titulo, nombres: p.nombres, dia: day, noche: night, esOracion: p.isOracion };
  });
  for (const o of oraciones) {
    if (!o.dia) inc("critica", "oracion_sin_dia", `No se reconoce el día de la oración "${o.nombre}" por su nombre (usa «ORACIÓN DÍA L27» o «ORACIÓN NOCHE L27»), o elígela a mano en el día que corresponda.`, { docId: o.docId });
    if (!o.esOracion) inc("aviso", "oracion_nombre", `"${o.nombre}" no lleva la palabra ORACIÓN; se ha tratado como oración por estar en esa categoría.`, { docId: o.docId });
  }

  // 3. Modelo de días
  const dias = [];
  const dayLabels = tt ? tt.days.map((d) => d.label) : [];
  const usedOra = new Set();
  const firstSeen = { olimpiadas: null, tld: null };
  let rainCount = 0;
  const rainTotal = tt ? tt.days.filter((d) => d.kind === "lluvia").length : 0;
  const primerDia = tt && tt.days.find((d) => d.kind === "dia") ? tt.days.find((d) => d.kind === "dia").label : null;

  const fuenteDe = (ids) => {
    const f = [];
    for (const id of ids) {
      const d = session.docs.get(id);
      if (!d) continue;
      f.push(d.origen === "bd" ? `biblioteca ${d.anioBd || "sin año"}${d.anioBd && d.anioBd !== cfg.anio ? " (otro año)" : ""}` : "subido");
    }
    return [...new Set(f)].join(" + ");
  };

  if (tt) {
    // validación de días de las oraciones contra el horario
    for (const o of oraciones) {
      if (o.dia && !dayLabels.includes(o.dia)) {
        inc("aviso", "oracion_dia_inexistente", `La oración "${o.nombre}" es del día ${o.dia}, que no está en la tabla principal.`, { docId: o.docId });
      }
    }
    for (const day of tt.days) {
      const isRain = day.kind === "lluvia";
      if (isRain) rainCount++;
      const items = dayItems(day);
      const turnosHasDay = tu && tu.days.includes(day.label);
      if (tu && !isRain && !turnosHasDay) inc("critica", "turnos_sin_dia", `La tabla de turnos no tiene el día ${day.label}.`, { dia: day.label });
      const resp = tu && turnosHasDay ? resolveDay(tu, day.label, items) : { byItem: {}, servicios: [] };

      const dayModel = {
        label: day.label,
        kind: day.kind,
        titulo: isRain ? `DÍA DE LLUVIA${rainTotal > 1 ? ` (${rainCount}/${rainTotal})` : ""}` : `DÍA ${day.label}${day.title ? ` – ${day.title}` : ""}`,
        day,
        items: [],
        oracionDia: [],
        oracionNoche: [],
        servicios: resp.servicios || [],
      };
      // Los días de lluvia no llevan oraciones ni actividades: no hay nada que revisar
      if (isRain) {
        dayModel.nota = "Día de lluvia: no lleva oraciones ni actividades con documento.";
        dias.push(dayModel);
        continue;
      }
      const esPrimero = day.label === primerDia;
      const seenDocs = new Set();
      for (const it of items) {
        const o = ov.items[it.key] || {};
        const entry = {
          key: it.key,
          hora: it.time,
          texto: it.text,
          tipo: it.type,
          especial: it.special,
          docIds: [],
          doc: null,
          responsables: null,
          repetido: false,
        };
        // responsables (solo en días con turnos)
        if (turnosHasDay) {
          const r = resp.byItem[it.key];
          if (o.nombres && o.nombres.length) {
            entry.responsables = { nombres: o.nombres, base: "manual", estado: "ok", tareas: [], candidatos: [] };
          } else if (r) {
            entry.responsables = {
              nombres: r.names || [],
              base: r.basis,
              estado: r.status,
              motivo: r.motivo || null,
              tareas: r.tasks || [],
              candidatos: r.candidates || [],
            };
            if (r.status !== "ok")
              inc("critica", "responsable_dudoso", `${day.label} · ${it.text}: ${r.motivo || "no está claro quién es el responsable"}.`, { key: it.key, dia: day.label });
          } else if (it.type === "actividad" || it.special === "olimpiadas") {
            entry.responsables = { nombres: [], base: null, estado: "pendiente", motivo: "No se ha encontrado ninguna tarea de la tabla de turnos para esta actividad", tareas: [], candidatos: [] };
            inc("critica", "responsable_pendiente", `${day.label} · ${it.text}: sin responsable en la tabla de turnos.`, { key: it.key, dia: day.label });
          }
        }

        if (it.type === "oracion_dia" || it.type === "oracion_noche") {
          const night = it.type === "oracion_noche";
          const cands = oraciones.filter((x) => x.dia === day.label && !!x.noche === night);
          const forced = o.docIds;
          if (o.sinDocumento) entry.doc = { confianza: "sin_documento", nombre: null };
          else if (forced && forced.length) {
            entry.docIds = forced;
            entry.doc = { confianza: "manual", nombre: forced.map((id) => session.docs.get(id)?.nombre).join(" + ") };
            forced.forEach((id) => usedOra.add(id));
          } else if (cands.length === 1) {
            entry.docIds = [cands[0].docId];
            entry.doc = { confianza: "clara", nombre: cands[0].nombre };
            usedOra.add(cands[0].docId);
          } else if (cands.length > 1) {
            entry.doc = { confianza: "dudosa", nombre: null, candidatos: cands.map((c) => ({ docId: c.docId, nombre: c.nombre })) };
            inc("critica", "oracion_duplicada", `${day.label}: hay ${cands.length} oraciones de ${night ? "noche" : "día"}; elige cuál usar.`, { key: it.key, dia: day.label });
          } else if (night) {
            // casi ningún día tiene oración de noche: si no hay documento, simplemente no se incluye
            entry.doc = { confianza: "no_necesita", nombre: null, motivo: "Sin oración de la noche este día" };
          } else if (esPrimero) {
            entry.doc = { confianza: "no_necesita", nombre: null, motivo: "El primer día no lleva oración de la mañana" };
          } else {
            entry.doc = { confianza: "sin_coincidencia", nombre: null };
            inc("critica", "falta_oracion", `${day.label}: falta la oración de la mañana.`, { key: it.key, dia: day.label });
          }
          (night ? dayModel.oracionNoche : dayModel.oracionDia).push(...entry.docIds);
        } else if (it.type === "oracion_monitores") {
          entry.doc = { confianza: "no_necesita", nombre: null };
        } else if (it.special && firstSeen[it.special]) {
          // Olimpiadas y Tiempo libre dirigido (TL y TL dirigido, con o sin quiosco/torneos) solo se
          // desarrollan el primer día en que aparecen; en el resto solo salen en el horario
          entry.repetido = true;
          entry.primerDia = firstSeen[it.special];
          entry.doc = { confianza: "no_necesita", nombre: null, motivo: `Se desarrolla el día ${firstSeen[it.special]}` };
        } else {
          if (it.special) firstSeen[it.special] = day.label;
          // actividad o especial
          if (o.sinDocumento) {
            entry.doc = { confianza: "sin_documento", nombre: null };
          } else if (o.docIds && o.docIds.length) {
            entry.docIds = o.docIds;
            entry.doc = { confianza: "manual", nombre: o.docIds.map((id) => session.docs.get(id)?.nombre).join(" + "), fuente: fuenteDe(o.docIds) };
          } else {
            const m = matchTiered(session, it, tiers);
            entry.doc = {
              confianza: m.confidence,
              score: m.score,
              nombre: m.docIds.map((id) => session.docs.get(id)?.nombre).join(" + ") || null,
              candidatos: m.candidates,
              motivo: m.motivo || (m.parcial ? "Solo una parte del texto tiene documento" : null),
              fuente: fuenteDe(m.docIds),
            };
            if (m.confidence === "clara" || m.confidence === "probable" || (o.confirmado && m.docIds.length)) entry.docIds = m.docIds;
            else if (m.confidence === "dudosa" && m.docIds.length && o.confirmado) entry.docIds = m.docIds;
            if (!entry.docIds.length) {
              inc(
                "critica",
                m.confidence === "dudosa" ? "coincidencia_dudosa" : "actividad_sin_documento",
                m.confidence === "dudosa"
                  ? `${day.label} · ${it.text}: coincidencia dudosa con "${entry.doc.nombre}". Confírmala o elige otro documento.`
                  : `${day.label} · ${it.text}: no hay documento de esta actividad (ni en la app ni subido). Súbelo o márcala como "sin documento".`,
                { key: it.key, dia: day.label }
              );
            }
          }
          // una vez por día para el mismo documento
          entry.docIds = entry.docIds.filter((id) => {
            if (seenDocs.has(id)) return false;
            seenDocs.add(id);
            return true;
          });
        }
        dayModel.items.push(entry);
      }
      dias.push(dayModel);
    }
    // oraciones que no se han usado
    for (const o of oraciones) {
      if (o.dia && dayLabels.includes(o.dia) && !usedOra.has(o.docId)) {
        inc("aviso", "oracion_sin_hueco", `La oración "${o.nombre}" (${o.dia}, ${o.noche ? "noche" : "día"}) no corresponde a ninguna oración del horario; no se incluirá.`, { docId: o.docId });
      }
    }
    // documentos subidos de actividades que no se han usado en ningún día
    const usadas = new Set(dias.flatMap((d) => d.items.flatMap((i) => [...i.docIds])));
    for (const d of actUp) {
      if (!usadas.has(d.id)) inc("aviso", "actividad_sin_uso", `El documento "${d.nombre}" no coincide con ninguna actividad del horario; no se incluirá.`, { docId: d.id });
    }
  }

  // 4. Destinos y niveles de los documentos de categorías específicas
  const nivelDeGrupo = (g) => {
    const k = BDX.claveNivel(g || "");
    return niveles.find((n) => BDX.claveNivel(n) === k && k.length >= 3) || null;
  };
  const nivelesConSubidas = new Set();
  for (const d of dinUp) {
    let nivel = d.nivel || detectLevel(d.filename, niveles);
    if (Array.isArray(nivel)) nivel = null;
    d.nivelDetectado = nivel || null;
    if (!nivel) inc("critica", "dinamica_sin_nivel", `No se reconoce el nivel de "${d.nombre}". Indica a qué nivel pertenece.`, { docId: d.id });
    d.destinosEfectivos = d.destinos && d.destinos.length ? d.destinos : nivel ? [`nivel-${slug(nivel)}`] : [];
    if (nivel) nivelesConSubidas.add(nivel);
  }
  // dinámicas de la biblioteca: solo las del año del campamento y solo para los niveles sin dinámicas subidas a mano
  const dinBdUsadas = [];
  for (const d of dinBd) {
    d.destinosEfectivos = [];
    d.nivelDetectado = null;
    if (d.anioBd !== cfg.anio) continue;
    const nivel = nivelDeGrupo(d.bd.grupo);
    d.nivelDetectado = nivel;
    if (!nivel) {
      inc("aviso", "dinamica_grupo_desconocido", `La dinámica «${d.nombre}» de la app es del grupo «${d.bd.grupo || "sin grupo"}», que no coincide con ningún nivel de este campamento; no se incluirá.`, { docId: d.id });
      continue;
    }
    if (nivelesConSubidas.has(nivel)) continue;
    d.destinosEfectivos = [`nivel-${slug(nivel)}`];
    dinBdUsadas.push(d);
  }
  const dinDocs = [...dinUp, ...dinBdUsadas];

  for (const d of subidos) {
    if (d.excluir) continue;
    if (["alergias", "menu"].includes(d.categoria)) {
      d.destinosEfectivos = d.destinos && d.destinos.length ? d.destinos : DESTINOS_DEFECTO[d.categoria] || [];
    } else if (d.categoria === "general") {
      d.destinosEfectivos = d.destinos && d.destinos.length ? d.destinos : ["todos"];
    }
    if (d.ext === ".pdf" && !["actividades", "oraciones", "dinamicas", "alergias", "menu"].includes(d.categoria)) {
      inc("critica", "pdf_no_insertable", `"${d.nombre}" es un PDF y en esta categoría solo se admiten Word o Excel.`, { docId: d.id });
    }
    if (d.categoria !== "general" && d.ext === ".docx" && d.info && !d.info.ok) inc("critica", "doc_ilegible", `"${d.nombre}": ${d.info.error}`, { docId: d.id });
  }

  // 5. Enfermeros: grupo de nivel de cada uno y plannings de enfermería
  const nivelDocsGeneral = general.filter((d) => d.rolDetectado === "grupos_nivel" && d.ext === ".xlsx" && !d.excluir);
  let enf = { items: [], grupos: [] };
  try {
    enf = await resolverEnfermeros(session, cfg, niveles, baseDocs, nivelDocsGeneral);
  } catch (e) {
    inc("aviso", "enfermeros_error", `No se ha podido buscar a los enfermeros en las tablas: ${e.message}`, {});
  }
  if (!(cfg.enfermeros || []).length) inc("aviso", "sin_enfermeros", "No has indicado ningún enfermero/a: el planning de enfermería saldrá sin dinámicas de nivel y el texto de «Consejos y normas» conservará el nombre del año anterior.", {});
  for (const it of enf.items) {
    if (it.estado !== "ok") inc("critica", "enfermero_sin_nivel", `Enfermero/a «${it.nombre}»: ${it.motivo}`, { enfermero: it.nombre });
  }

  const plannings = listPlannings(cfg, enf);
  const excl = new Set(cfg.noPlannings || []);
  const seleccionados = plannings.filter((p) => !excl.has(p.id));

  // 6. Estado de las categorías y de los plannings
  const reqPor = {};
  for (const p of seleccionados) for (const c of p.requiere) (reqPor[c] = reqPor[c] || []).push(p.id);
  const categorias = CATEGORIAS.map((c) => {
    const docs = subidos.filter((d) => d.categoria === c.id && !d.excluir);
    const na = ov.categorias && ov.categorias[c.id] === "na";
    let estado;
    let motivo = null;
    const nivelesEnFiles = (c.id === "dinamicas" && dinBdUsadas.length) || (c.id === "actividades" && actBd.length);
    if (c.id === "general") {
      estado = principal.length >= 1 && turnosDocs.length >= 1 ? "COMPLETA" : "PENDIENTE";
      if (estado === "PENDIENTE") motivo = "Falta la tabla principal o la de turnos";
    } else if (c.id === "actividades" || c.id === "oraciones") {
      const normales = dias.filter((d) => d.kind !== "lluvia");
      const necesita = normales.some((d, i) => d.items.some((i2) => (c.id === "actividades" ? ["actividad", "especial"].includes(i2.tipo) : i2.tipo === "oracion_dia" && d.label !== primerDia)));
      estado = docs.length || nivelesEnFiles ? "COMPLETA" : necesita && !na ? "PENDIENTE" : "NO APLICABLE";
      if (c.id === "actividades" && actBd.length) motivo = `${actBd.filter((d) => d.anioBd === cfg.anio).length} actividades de ${cfg.anio} y ${actBd.filter((d) => d.anioBd !== cfg.anio).length} de otros años en la app${docs.length ? `, más ${docs.length} subidas` : ""}`;
    } else if (c.id === "dinamicas") {
      estado = docs.length || dinBdUsadas.length ? "COMPLETA" : na ? "NO APLICABLE" : reqPor.dinamicas ? "PENDIENTE" : "NO APLICABLE";
      if (dinBdUsadas.length) motivo = `${dinBdUsadas.length} dinámicas de ${cfg.anio} tomadas de la app${docs.length ? `, más ${docs.length} subidas` : ""}`;
    } else if (na) estado = "NO APLICABLE";
    else if (docs.length) estado = "COMPLETA";
    else estado = reqPor[c.id] ? "PENDIENTE" : "NO APLICABLE";
    if (estado === "PENDIENTE" && c.id !== "general") {
      motivo = reqPor[c.id] ? `La necesitan: ${reqPor[c.id].map((id) => plannings.find((p) => p.id === id).nombre).join(", ")}` : "Faltan documentos";
      inc("critica", "categoria_pendiente", `«${c.nombre}» pendiente. ${motivo}. Súbelos o márcala como "no aplicable".`, { categoria: c.id });
    }
    return { id: c.id, nombre: c.nombre, ayuda: c.ayuda, estado, motivo, marcadaNA: !!na, documentos: docs.length, requeridaPor: reqPor[c.id] || [] };
  });

  // Niveles seleccionados (y enfermeros con nivel) sin dinámicas propias
  const aniosDinamicas = (n) => [...new Set(dinBd.filter((d) => nivelDeGrupo(d.bd.grupo) === n && d.anioBd != null).map((d) => d.anioBd))].sort((a, b) => b - a);
  for (const p of seleccionados.filter((x) => x.nivel)) {
    const tiene = dinDocs.some((d) => paraNivel(d, p));
    if (!tiene && !(ov.categorias && ov.categorias.dinamicas === "na")) {
      const otros = aniosDinamicas(p.nivel);
      inc(
        "critica",
        "nivel_sin_dinamicas",
        `${p.nombre} no tiene dinámicas del nivel «${p.nivel}» para ${cfg.anio}${otros.length ? ` (en la app hay de: ${otros.join(", ")})` : " (ni en la app ni subidas)"}. Súbelas a la app con año ${cfg.anio} o a este generador.`,
        { categoria: "dinamicas", planning: p.id }
      );
    }
  }

  // Aviso de datos sensibles
  const sens = subidos.filter((d) => ["alergias", "menu"].includes(d.categoria) && !d.excluir);
  for (const d of sens) {
    const dest = d.destinosEfectivos || [];
    if (dest.includes("todos") || dest.some((x) => x.startsWith("nivel-"))) {
      inc("aviso", "dato_sensible", `"${d.nombre}" contiene datos sensibles y se incluirá en plannings de nivel. Revisa que sea lo que quieres.`, { docId: d.id });
    }
  }

  // Incidencias duplicadas (la misma incidencia por varias vías)
  const vistos = new Set();
  const incUnicas = incidencias.filter((i) => {
    const k = `${i.codigo}|${i.mensaje}|${i.key || i.docId || ""}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });

  const criticas = incUnicas.filter((i) => i.nivel === "critica");
  const planningsOut = plannings.map((p) => ({
    id: p.id,
    clase: p.clase,
    nombre: p.nombre,
    tipo: p.tipo,
    nivel: p.nivel || null,
    nombres: p.nombres || undefined,
    seleccionado: !excl.has(p.id),
    requiere: p.requiere,
  }));

  const resumenBd = (docs) => {
    const por = {};
    for (const d of docs) por[d.anioBd || "sin año"] = (por[d.anioBd || "sin año"] || 0) + 1;
    return por;
  };
  const review = {
    anio: cfg.anio,
    niveles,
    categorias,
    plannings: planningsOut,
    bd: {
      error: session.bd ? session.bd.error : null,
      actividades: resumenBd(actBd),
      dinamicas: resumenBd(dinBd),
      dinamicasUsadas: dinBdUsadas.length,
    },
    bdActividades: actBd.map((d) => ({ id: d.id, nombre: d.nombre, anio: d.anioBd || null })).sort((a, b) => (b.anio || 0) - (a.anio || 0) || a.nombre.localeCompare(b.nombre, "es")),
    rolesHoja: BDX.ROLES_HOJA.map((r) => ({ id: r.id, nombre: r.nombre })),
    enfermeros: enf.items,
    documentos: subidos.map((d) => ({
      id: d.id,
      categoria: d.categoria,
      nombre: d.nombre,
      archivo: d.filename,
      tamano: d.size,
      tipo: d.ext,
      rol: d.categoria === "general" ? d.rolDetectado : undefined,
      hojas: d.categoria === "base_datos" ? d.hojasEf : undefined,
      destinos: d.destinosEfectivos,
      nivel: d.nivelDetectado || undefined,
      excluir: !!d.excluir,
      aviso: (d.avisos && d.avisos[0]) || (d.info && d.info.ok && d.info.landscape ? "Tiene páginas horizontales; se conservarán tal cual" : undefined) || (d.ext === ".pdf" && d.info && d.info.ok ? `PDF de ${d.info.pages} página(s): se incluirá como imágenes (no editable)` : undefined),
    })),
    dias: dias.map((d) => ({
      label: d.label,
      titulo: d.titulo,
      tipo: d.kind,
      nota: d.nota,
      items: d.items.map((i) => ({
        key: i.key,
        hora: i.hora,
        texto: i.texto,
        tipo: i.tipo,
        especial: i.especial,
        documento: i.doc,
        documentos: i.docIds.map((id) => session.docs.get(id)?.nombre),
        documentoIds: i.docIds,
        manual: !!(ov.items[i.key] && (ov.items[i.key].docIds || ov.items[i.key].sinDocumento || ov.items[i.key].nombres)),
        repetido: i.repetido || undefined,
        primerDia: i.primerDia,
        responsables: i.responsables,
      })),
      servicios: (d.servicios || []).map((s) => ({ tarea: s.task, nombres: s.names, base: s.basis })),
      ordenOraciones: { dia: d.oracionDia.length, noche: d.oracionNoche.length },
    })),
    incidencias: incUnicas,
    puedeGenerar: seleccionados.length > 0,
    criticas: criticas.length,
    avisos: incUnicas.length - criticas.length,
  };

  const dinamicasPara = (p) => dinDocs.filter((d) => paraNivel(d, p));
  return {
    review,
    model: {
      anio: cfg.anio,
      hayContactos: contactosDocs.length > 0,
      dias,
      plannings,
      seleccionados,
      tt,
      tu,
      actDocs: actDocsTodas,
      oraDocs,
      dinDocs,
      dinamicasPara,
      baseDocs,
      enfermeros: enf.items,
      docsAll,
      principal: principal[0],
      turnos: turnosDocs[0],
      incidencias: incUnicas,
    },
  };
}

/** ¿Esta dinámica es del nivel (o del grupo de enfermería con ese nivel) de este planning? */
function paraNivel(d, p) {
  const dest = d.destinosEfectivos || [];
  if (dest.includes(p.id)) return true;
  return !!(p.nivel && p.clase === "enfermeria" && dest.includes(`nivel-${slug(p.nivel)}`));
}

module.exports = { analyze, CATEGORIAS, listPlannings, DESTINOS_DEFECTO, NIVELES_DEFECTO, slug, paraPlanning, paraNivel };
