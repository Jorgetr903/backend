// services/plannings/analysis.js
// Fase 2 y 3: análisis automático de los documentos subidos y construcción
// de la vista de revisión (con incidencias). También produce el "modelo"
// resuelto que usa el generador.

const fs = require("fs");
const { parseTimetable, dayItems } = require("./timetable");
const { parseTurnos, resolveDay } = require("./turnos");
const { matchItem } = require("./matcher");
const { parseOracionText, detectLevel } = require("./classify");
const { norm } = require("./textutil");

// ───────────────────────── Catálogo ─────────────────────────

const CATEGORIAS = [
  { id: "general", nombre: "Información general", ayuda: "Tabla principal, turnos, contactos de monitores, grupos de nivel y de trabajo, servicio de comedor, servicio extra, teléfonos" },
  { id: "logo", nombre: "Logo del año", ayuda: "Imagen PNG o JPG con el logo de este año: sale en el índice y en «Teléfonos de interés»" },
  { id: "actividades", nombre: "Actividades generales", ayuda: "Un Word por actividad" },
  { id: "oraciones", nombre: "Oraciones", ayuda: "Un Word por oración; el nombre indica el día y si es de día o de noche" },
  { id: "dinamicas", nombre: "Dinámicas por nivel", ayuda: "Un Word por nivel" },
  { id: "alergias", nombre: "Alergias", ayuda: "Datos sensibles: solo van a los plannings que los necesitan" },
  { id: "menu", nombre: "Menú", ayuda: "Solo enfermería y director" },
  { id: "enfermeria", nombre: "Enfermería", ayuda: "Documentos propios del planning de enfermería" },
  { id: "coordinacion", nombre: "Coordinación", ayuda: "Documentos propios del planning de coordinadores" },
  { id: "direccion", nombre: "Dirección", ayuda: "Documentos propios del planning del director" },
  { id: "otros", nombre: "Otros", ayuda: "Tú decides a qué plannings va cada documento" },
];

const ESPECIALES = [
  { id: "enfermeria", nombre: "Planning Enfermería", requiere: ["alergias", "menu", "enfermeria"] },
  { id: "coordinadores", nombre: "Planning Coordinadores", requiere: ["coordinacion", "alergias"] },
  { id: "director", nombre: "Planning Director", requiere: ["direccion", "alergias", "menu"] },
];

const DESTINOS_DEFECTO = {
  alergias: ["enfermeria", "coordinadores", "director"],
  menu: ["enfermeria", "director"],
  enfermeria: ["enfermeria"],
  coordinacion: ["coordinadores"],
  direccion: ["director"],
  otros: [],
};

const NIVELES_DEFECTO = ["Pequeños", "Medianos", "Mayores"];

function slug(s) {
  return norm(s).replace(/\s+/g, "-") || "nivel";
}

function listPlannings(config) {
  const niveles = (config.niveles && config.niveles.length ? config.niveles : NIVELES_DEFECTO).map((n) => String(n).trim()).filter(Boolean);
  return [
    ...niveles.map((n) => ({ id: `nivel-${slug(n)}`, nombre: `Planning ${n}`, tipo: "nivel", nivel: n, requiere: ["dinamicas"] })),
    ...ESPECIALES.map((e) => ({ ...e, tipo: "especial" })),
  ];
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

// ───────────────────────── Análisis ─────────────────────────

/**
 * @param {object} session {config, docs:Map, overrides}
 * @returns {Promise<{review:object, model:object}>}
 */
async function analyze(session) {
  const cfg = session.config;
  const ov = session.overrides || { items: {}, categorias: {} };
  const docsAll = [...session.docs.values()];
  const incidencias = [];
  const inc = (nivel, codigo, mensaje, ref = {}) =>
    incidencias.push({ id: `${codigo}:${ref.docId || ref.key || ref.dia || ref.categoria || ""}:${incidencias.length}`, nivel, codigo, mensaje, ...ref });

  const plannings = listPlannings(cfg);
  const seleccion = new Set(cfg.plannings && cfg.plannings.length ? cfg.plannings : plannings.map((p) => p.id));
  const seleccionados = plannings.filter((p) => seleccion.has(p.id));

  // 1. Documentos de "general": roles
  const general = docsAll.filter((d) => d.categoria === "general");
  for (const d of general) d.rolDetectado = await detectGeneralRole(d);
  const principal = general.filter((d) => d.rolDetectado === "principal" && !d.excluir);
  const turnosDocs = general.filter((d) => d.rolDetectado === "turnos" && !d.excluir);

  if (!principal.length) inc("critica", "falta_principal", "Falta la tabla principal del campamento (Excel con los días y el horario).", { categoria: "general" });
  if (principal.length > 1) inc("critica", "varias_principal", "Hay más de una tabla principal; marca cuál sobra como 'excluir'.", { categoria: "general" });
  if (!turnosDocs.length) inc("critica", "falta_turnos", "Falta la tabla de turnos (Excel con los monitores y sus tareas por día).", { categoria: "general" });
  const contactosDocs = general.filter((d) => d.rolDetectado === "contactos" && !d.excluir);
  if (!contactosDocs.length) inc("critica", "falta_contactos", "Falta la tabla con los nombres, correos y teléfonos de todos los monitores (va en la portada, antes del índice).", { categoria: "general" });
  if (turnosDocs.length > 1) inc("critica", "varias_turnos", "Hay más de una tabla de turnos; marca cuál sobra como 'excluir'.", { categoria: "general" });

  let tt = null;
  let tu = null;
  if (principal.length === 1) {
    try {
      tt = await parsedTimetable(principal[0]);
      tt.warnings.forEach((w) => inc("aviso", "tabla_principal", w, { docId: principal[0].id }));
    } catch (e) {
      inc("critica", "principal_ilegible", `No se pudo leer la tabla principal: ${e.message}`, { docId: principal[0].id });
    }
  }
  if (turnosDocs.length === 1) {
    try {
      tu = await parsedTurnos(turnosDocs[0]);
      tu.warnings.forEach((w) => inc("aviso", "turnos", w, { docId: turnosDocs[0].id }));
    } catch (e) {
      inc("critica", "turnos_ilegible", `No se pudo leer la tabla de turnos: ${e.message}`, { docId: turnosDocs[0].id });
    }
  }

  // 2. Actividades y oraciones
  const actDocs = docsAll.filter((d) => d.categoria === "actividades" && !d.excluir);
  const oraDocs = docsAll.filter((d) => d.categoria === "oraciones" && !d.excluir);
  const dinDocs = docsAll.filter((d) => d.categoria === "dinamicas" && !d.excluir);

  for (const d of [...actDocs, ...oraDocs, ...dinDocs]) {
    if (d.ext === ".pdf") inc("critica", "pdf_no_insertable", `"${d.nombre}" es un PDF; no se puede insertar dentro del Word. Sube la versión .docx.`, { docId: d.id });
    else if (d.info && !d.info.ok) inc("critica", "doc_ilegible", `"${d.nombre}": ${d.info.error}`, { docId: d.id });
  }

  // Datos sensibles que no deben ir a "Información general" (se incluye en todos los plannings)
  for (const d of general) {
    if (d.excluir) continue;
    if (/(alergi|padres|menu|medicaci)/.test(norm(d.nombre)) && !(d.destinos && d.destinos.length)) {
      inc("critica", "sensible_en_general", `"${d.nombre}" parece contener datos sensibles y está en Información general (iría a todos los plannings). Muévelo a su categoría o indica a qué plannings va.`, { docId: d.id, sugerida: /menu/.test(norm(d.nombre)) ? "menu" : "alergias" });
    }
  }

  // Documentos que parecen estar en la categoría equivocada
  for (const d of actDocs) {
    if (/\boracion\b/.test(norm(d.nombre))) inc("critica", "categoria_dudosa", `"${d.nombre}" parece una oración pero está en Actividades. Muévelo a Oraciones.`, { docId: d.id, sugerida: "oraciones" });
  }

  // Oraciones: día y tipo a partir del nombre (con corrección manual)
  const oraciones = oraDocs.map((d) => {
    const p = parseOracionText(d.filename);
    const day = d.dia || p.day;
    const night = d.noche != null ? d.noche : p.night;
    return { docId: d.id, nombre: d.nombre, titulo: p.titulo, nombres: p.nombres, dia: day, noche: night, esOracion: p.isOracion };
  });
  for (const o of oraciones) {
    if (!o.dia) inc("critica", "oracion_sin_dia", `No se reconoce el día de la oración "${o.nombre}". Indícalo a mano.`, { docId: o.docId });
    if (!o.esOracion) inc("aviso", "oracion_nombre", `"${o.nombre}" no lleva la palabra ORACIÓN; se ha tratado como oración por estar en esa categoría.`, { docId: o.docId });
  }

  // 3. Modelo de días
  const dias = [];
  const dayLabels = tt ? tt.days.map((d) => d.label) : [];
  const usedOra = new Set();
  const firstSeen = { olimpiadas: null, tld: null };
  let rainCount = 0;
  const rainTotal = tt ? tt.days.filter((d) => d.kind === "lluvia").length : 0;

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
          } else {
            entry.doc = { confianza: "sin_coincidencia", nombre: null };
            inc("critica", "falta_oracion", `${day.label}: falta la oración de ${night ? "noche" : "día"}.`, { key: it.key, dia: day.label });
          }
          (night ? dayModel.oracionNoche : dayModel.oracionDia).push(...entry.docIds);
        } else if (it.type === "oracion_monitores") {
          entry.doc = { confianza: "no_necesita", nombre: null };
        } else {
          // actividad o especial
          if (o.sinDocumento) {
            entry.doc = { confianza: "sin_documento", nombre: null };
          } else if (o.docIds && o.docIds.length) {
            entry.docIds = o.docIds;
            entry.doc = { confianza: "manual", nombre: o.docIds.map((id) => session.docs.get(id)?.nombre).join(" + ") };
          } else {
            const m = matchItem(it, actDocs);
            entry.doc = {
              confianza: m.confidence,
              score: m.score,
              nombre: m.docIds.map((id) => session.docs.get(id)?.nombre).join(" + ") || null,
              candidatos: m.candidates,
              motivo: m.motivo || (m.parcial ? "Solo una parte del texto tiene documento" : null),
            };
            if (m.confidence === "clara" || m.confidence === "probable" || (o.confirmado && m.docIds.length)) entry.docIds = m.docIds;
            else if (m.confidence === "dudosa" && m.docIds.length && o.confirmado) entry.docIds = m.docIds;
            if (!entry.docIds.length) {
              inc(
                "critica",
                m.confidence === "dudosa" ? "coincidencia_dudosa" : "actividad_sin_documento",
                m.confidence === "dudosa"
                  ? `${day.label} · ${it.text}: coincidencia dudosa con "${entry.doc.nombre}". Confírmala o elige otro documento.`
                  : `${day.label} · ${it.text}: no hay documento de esta actividad. Sube el Word o márcala como "sin documento".`,
                { key: it.key, dia: day.label }
              );
            }
          }
          // una vez por día para el mismo documento; olimpiadas y TLD solo la primera vez
          entry.docIds = entry.docIds.filter((id) => {
            if (seenDocs.has(id)) return false;
            seenDocs.add(id);
            return true;
          });
          if (it.special && entry.docIds.length) {
            if (firstSeen[it.special]) {
              entry.repetido = true;
              entry.docIdsOcultos = entry.docIds;
              entry.docIds = [];
              entry.primerDia = firstSeen[it.special];
            } else firstSeen[it.special] = day.label;
          }
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
    // documentos de actividades que no se han usado en ningún día
    const usadas = new Set(dias.flatMap((d) => d.items.flatMap((i) => [...i.docIds, ...(i.docIdsOcultos || [])])));
    for (const d of actDocs) {
      if (d.ext !== ".pdf" && !usadas.has(d.id)) inc("aviso", "actividad_sin_uso", `El documento "${d.nombre}" no coincide con ninguna actividad del horario; no se incluirá.`, { docId: d.id });
    }
  }

  // 4. Destinos y niveles de los documentos de categorías específicas
  const niveles = plannings.filter((p) => p.tipo === "nivel").map((p) => p.nivel);
  for (const d of docsAll) {
    if (d.excluir) continue;
    if (d.categoria === "dinamicas") {
      let nivel = d.nivel || detectLevel(d.filename, niveles);
      if (Array.isArray(nivel)) nivel = null;
      d.nivelDetectado = nivel || null;
      if (!nivel) inc("critica", "dinamica_sin_nivel", `No se reconoce el nivel de "${d.nombre}". Indica a qué nivel pertenece.`, { docId: d.id });
      d.destinosEfectivos = d.destinos && d.destinos.length ? d.destinos : nivel ? [`nivel-${slug(nivel)}`] : [];
    } else if (["alergias", "menu", "enfermeria", "coordinacion", "direccion", "otros"].includes(d.categoria)) {
      d.destinosEfectivos = d.destinos && d.destinos.length ? d.destinos : DESTINOS_DEFECTO[d.categoria] || [];
      if (d.categoria === "otros" && !d.destinosEfectivos.length) inc("critica", "otros_sin_destino", `Indica a qué plannings va "${d.nombre}" (categoría Otros).`, { docId: d.id });
    } else if (d.categoria === "general") {
      d.destinosEfectivos = d.destinos && d.destinos.length ? d.destinos : ["todos"];
    }
    if (d.ext === ".pdf" && !["actividades", "oraciones", "dinamicas"].includes(d.categoria)) {
      inc("critica", "pdf_no_insertable", `"${d.nombre}" es un PDF; no se puede insertar dentro del Word. Sube la versión .docx.`, { docId: d.id });
    }
    if (d.categoria !== "general" && d.info && !d.info.ok && d.ext === ".docx") inc("critica", "doc_ilegible", `"${d.nombre}": ${d.info.error}`, { docId: d.id });
  }

  // 5. Estado de las categorías y de los plannings
  const reqPor = {};
  for (const p of seleccionados) for (const c of p.requiere) (reqPor[c] = reqPor[c] || []).push(p.id);
  const categorias = CATEGORIAS.map((c) => {
    const docs = docsAll.filter((d) => d.categoria === c.id && !d.excluir);
    const na = ov.categorias && ov.categorias[c.id] === "na";
    let estado;
    let motivo = null;
    if (c.id === "general") {
      estado = principal.length === 1 && turnosDocs.length === 1 ? "COMPLETA" : "PENDIENTE";
      if (estado === "PENDIENTE") motivo = "Falta la tabla principal o la de turnos";
    } else if (c.id === "actividades" || c.id === "oraciones") {
      const necesita = dias.some((d) => d.items.some((i) => (c.id === "actividades" ? ["actividad", "especial"].includes(i.tipo) : i.tipo.startsWith("oracion_d") || i.tipo === "oracion_noche")));
      estado = docs.length ? "COMPLETA" : necesita && !na ? "PENDIENTE" : "NO APLICABLE";
    } else if (na) estado = "NO APLICABLE";
    else if (docs.length) estado = "COMPLETA";
    else estado = reqPor[c.id] ? "PENDIENTE" : "NO APLICABLE";
    if (estado === "PENDIENTE" && c.id !== "general") {
      motivo = reqPor[c.id] ? `La necesitan: ${reqPor[c.id].map((id) => plannings.find((p) => p.id === id).nombre).join(", ")}` : "Faltan documentos";
      if (!(c.id === "actividades" || c.id === "oraciones") || true) inc("critica", "categoria_pendiente", `Categoría "${c.nombre}" pendiente. ${motivo}. Sube los documentos o márcala como "no aplicable".`, { categoria: c.id });
    }
    return { id: c.id, nombre: c.nombre, ayuda: c.ayuda, estado, motivo, marcadaNA: !!na, documentos: docs.length, requeridaPor: reqPor[c.id] || [] };
  });

  // Niveles seleccionados sin dinámicas propias
  for (const p of seleccionados.filter((x) => x.tipo === "nivel")) {
    const tiene = dinDocs.some((d) => (d.destinosEfectivos || []).includes(p.id));
    if (!tiene && !(ov.categorias && ov.categorias.dinamicas === "na")) {
      inc("critica", "nivel_sin_dinamicas", `El ${p.nombre} no tiene documento de dinámicas del nivel.`, { categoria: "dinamicas", planning: p.id });
    }
  }

  // Aviso de datos sensibles
  const sens = docsAll.filter((d) => ["alergias", "menu"].includes(d.categoria) && !d.excluir);
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
    nombre: p.nombre,
    tipo: p.tipo,
    seleccionado: seleccion.has(p.id),
    requiere: p.requiere,
    bloqueado: seleccion.has(p.id) && criticas.length > 0,
  }));

  const review = {
    anio: cfg.anio,
    niveles,
    categorias,
    plannings: planningsOut,
    documentos: docsAll.map((d) => ({
      id: d.id,
      categoria: d.categoria,
      nombre: d.nombre,
      archivo: d.filename,
      tamano: d.size,
      tipo: d.ext,
      rol: d.categoria === "general" ? d.rolDetectado : undefined,
      destinos: d.destinosEfectivos,
      nivel: d.nivelDetectado || undefined,
      excluir: !!d.excluir,
      aviso: d.info && d.info.ok && d.info.landscape ? "Tiene páginas horizontales; se conservarán tal cual" : undefined,
    })),
    dias: dias.map((d) => ({
      label: d.label,
      titulo: d.titulo,
      tipo: d.kind,
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
    oraciones: oraciones.map((o) => ({ docId: o.docId, nombre: o.nombre, dia: o.dia, tipo: o.noche ? "noche" : "día", titulo: o.titulo || undefined })),
    incidencias: incUnicas,
    puedeGenerar: criticas.length === 0 && seleccionados.length > 0,
    criticas: criticas.length,
    avisos: incUnicas.length - criticas.length,
  };

  return { review, model: { anio: cfg.anio, hayContactos: contactosDocs.length > 0, dias, plannings, seleccionados, tt, tu, actDocs, oraDocs, dinDocs, docsAll, principal: principal[0], turnos: turnosDocs[0], incidencias: incUnicas } };
}

module.exports = { analyze, CATEGORIAS, listPlannings, DESTINOS_DEFECTO, NIVELES_DEFECTO, slug };
