// routes/plannings.js
//
// API del generador automático de plannings. Todas las rutas exigen la
// clave compartida (x-upload-key). Los archivos viven en una carpeta
// temporal por sesión que se borra al terminar o a las 3 h sin actividad.

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const checkUploadKey = require("../middleware/checkUploadKey");
const S = require("../services/plannings/session");
const { analyze, CATEGORIAS, listPlannings } = require("../services/plannings/analysis");
const { ROLES_HOJA } = require("../services/plannings/basedatos");
const { generate, catalogoBloques, pdfDisponible } = require("../services/plannings/generate");

const router = express.Router();
router.use(checkUploadKey);
router.use(express.json({ limit: "512kb" }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error("[plannings]", err);
    res.status(status).json({ mensaje: status >= 500 ? "Error interno del generador de plannings" : err.message });
  });

function loadSession(req, res, next) {
  const s = S.get(req.params.id);
  if (!s) return res.status(404).json({ mensaje: "La sesión no existe o ha caducado. Empieza de nuevo." });
  req.sesion = s;
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(req.sesion.dir, "files")),
  filename: (req, file, cb) => cb(null, S.newId(8) + path.extname(file.originalname || "").toLowerCase().slice(0, 6)),
});
const upload = multer({ storage, limits: { fileSize: S.LIMITS.maxZip, files: 60 } });

let generando = false; // un solo ensamblado a la vez: protege la memoria del plan gratuito

async function estadoCompleto(s) {
  const { review } = await analyze(s);
  return {
    id: s.id,
    config: s.config,
    categorias: CATEGORIAS.map((c) => ({ id: c.id, nombre: c.nombre })),
    bloques: catalogoBloques(), // siempre se incluyen todos: solo informativo
    pdfDisponible: pdfDisponible(),
    revision: review,
    generacion: s.job ? { estado: s.job.estado, progreso: s.job.progreso, error: s.job.error || null, informe: s.job.informe || null } : null,
  };
}

// 1. Crear sesión (fase 1: preparar campamento)
router.post(
  "/sesiones",
  wrap(async (req, res) => {
    const s = S.create(req.body || {});
    res.status(201).json({ id: s.id, config: s.config, categorias: CATEGORIAS, plannings: listPlannings(s.config) });
  })
);

// 2. Estado + análisis + revisión (fases 2, 3 y 4)
router.get(
  "/sesiones/:id",
  loadSession,
  wrap(async (req, res) => {
    res.json(await estadoCompleto(req.sesion));
  })
);

// 3. Subir documentos a una categoría
router.post("/sesiones/:id/documentos", loadSession, upload.array("archivos", 60), wrap(async (req, res) => {
  const s = req.sesion;
  const categoria = String((req.body && req.body.categoria) || "");
  // contraseña del Excel protegido (Base de Datos CSP): solo se usa para descifrar, no se guarda
  const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
  const files = req.files || [];
  const added = [];
  const skipped = [];
  const errores = [];
  if (categoria !== "auto" && !CATEGORIAS.some((c) => c.id === categoria)) {
    files.forEach((f) => fs.rmSync(f.path, { force: true }));
    return res.status(400).json({ mensaje: "Categoría no válida" });
  }
  for (const f of files) {
    try {
      if (path.extname(f.originalname || "").toLowerCase() === ".zip") {
        const r = await S.addZip(s, categoria, f.path, f.originalname, password);
        added.push(...r.added.map((d) => d.nombre));
        skipped.push(...r.skipped);
      } else if (f.size > S.LIMITS.maxFile) {
        fs.rmSync(f.path, { force: true });
        errores.push(`"${f.originalname}" supera los ${Math.round(S.LIMITS.maxFile / 1048576)} MB permitidos`);
      } else {
        const d = await S.registerFile(s, { categoria, originalname: f.originalname, filePath: f.path, size: f.size, password });
        added.push(d.nombre);
      }
    } catch (e) {
      fs.rmSync(f.path, { force: true });
      errores.push(e.message);
    }
  }
  res.status(errores.length && !added.length ? 400 : 200).json({ anadidos: added, ignorados: skipped, errores });
}));

// 4. Borrar un documento
router.delete(
  "/sesiones/:id/documentos/:docId",
  loadSession,
  wrap(async (req, res) => {
    if (!S.removeDoc(req.sesion, req.params.docId)) return res.status(404).json({ mensaje: "Documento no encontrado" });
    res.json({ ok: true });
  })
);

// 5. Correcciones manuales (tienen prioridad sobre lo detectado)
router.patch(
  "/sesiones/:id",
  loadSession,
  wrap(async (req, res) => {
    const s = req.sesion;
    const b = req.body || {};
    if (b.config) {
      s.config = S.sanitizeConfig({ ...s.config, ...b.config });
    }
    if (b.items && typeof b.items === "object") {
      for (const [key, v] of Object.entries(b.items)) {
        if (v === null) {
          delete s.overrides.items[key];
          continue;
        }
        const o = { ...(s.overrides.items[key] || {}) };
        if (v.sinDocumento === true) {
          o.sinDocumento = true;
          delete o.docIds;
        } else if (v.sinDocumento === false) delete o.sinDocumento;
        if (Array.isArray(v.docIds)) {
          const ids = v.docIds.filter((id) => s.docs.has(id));
          if (ids.length) {
            o.docIds = ids;
            delete o.sinDocumento;
          } else delete o.docIds;
        }
        if (v.confirmado) o.confirmado = true;
        if (Array.isArray(v.nombres)) {
          const n = v.nombres.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 12);
          if (n.length) o.nombres = n;
          else delete o.nombres;
        }
        if (Object.keys(o).length) s.overrides.items[key] = o;
        else delete s.overrides.items[key];
      }
    }
    if (b.categorias && typeof b.categorias === "object") {
      for (const [c, v] of Object.entries(b.categorias)) {
        if (!CATEGORIAS.some((x) => x.id === c)) continue;
        if (v === "na") s.overrides.categorias[c] = "na";
        else delete s.overrides.categorias[c];
      }
    }
    if (b.docs && typeof b.docs === "object") {
      for (const [id, v] of Object.entries(b.docs)) {
        const d = s.docs.get(id);
        if (!d || !v) continue;
        if ("excluir" in v) d.excluir = !!v.excluir;
        if (Array.isArray(v.destinos)) d.destinos = v.destinos.map(String).slice(0, 12);
        if ("nivel" in v) d.nivel = v.nivel ? String(v.nivel).slice(0, 40) : null;
        if ("dia" in v) d.dia = v.dia ? String(v.dia).toUpperCase().slice(0, 4) : null;
        if ("noche" in v) d.noche = v.noche == null ? null : !!v.noche;
        if (v.hojas && typeof v.hojas === "object" && d.categoria === "base_datos") {
          d.hojasCfg = d.hojasCfg || {};
          for (const [nombre, h] of Object.entries(v.hojas)) {
            if (!(d.hojas || []).includes(nombre)) continue;
            if (h === null) {
              delete d.hojasCfg[nombre];
              continue;
            }
            const cur = { ...(d.hojasCfg[nombre] || {}) };
            if (typeof h.rol === "string" && ROLES_HOJA.some((r) => r.id === h.rol)) cur.rol = h.rol;
            if (Array.isArray(h.destinos)) cur.destinos = h.destinos.map((x) => String(x).slice(0, 40)).slice(0, 12);
            d.hojasCfg[nombre] = cur;
          }
        }
        if (typeof v.rol === "string" && d.categoria === "general" && ["principal", "turnos", "contactos", "grupos_nivel", "grupos_trabajo", "servicio", "tabla", "documento"].includes(v.rol)) d.rol = v.rol;
        if (typeof v.categoria === "string" && CATEGORIAS.some((c) => c.id === v.categoria)) {
          d.categoria = v.categoria;
          d.destinos = null;
        }
      }
    }
    s.results = null;
    res.json(await estadoCompleto(s));
  })
);

// 6. Generar (en segundo plano para no agotar el tiempo de la petición).
//    Se puede generar aunque queden problemas por resolver, pero hay que confirmarlo.
router.post(
  "/sesiones/:id/generar",
  loadSession,
  wrap(async (req, res) => {
    const s = req.sesion;
    if (generando) return res.status(429).json({ mensaje: "Ya se está generando otro planning en el servidor. Espera un momento." });
    if (s.job && s.job.estado === "generando") return res.status(409).json({ mensaje: "Ya se está generando" });
    let { review } = await analyze(s);
    if (Array.isArray(req.body && req.body.plannings)) {
      const elegidos = new Set(req.body.plannings.map(String));
      s.config.noPlannings = review.plannings.filter((p) => !elegidos.has(p.id)).map((p) => p.id);
      ({ review } = await analyze(s));
    }
    if (!review.puedeGenerar) return res.status(422).json({ mensaje: "No hay ningún planning seleccionado." });
    const problemas = review.incidencias.filter((i) => i.nivel === "critica");
    if (problemas.length && !(req.body && req.body.confirmarProblemas === true)) {
      return res.status(409).json({
        requiereConfirmacion: true,
        mensaje: `Quedan ${problemas.length} problema(s) por resolver. Si generas ahora, lo que falta no se incluirá en los plannings.`,
        criticas: problemas.length,
        problemas: problemas.slice(0, 12).map((i) => i.mensaje),
      });
    }
    generando = true;
    s.busy = true;
    s.job = { estado: "generando", progreso: { fase: "empezando" } };
    res.status(202).json({ estado: "generando" });
    generate(s, (p) => {
      s.job.progreso = p;
    })
      .then((r) => {
        if (r.ok) {
          s.job = { estado: "listo", progreso: { fase: "listo" }, informe: r.informe, zipPath: r.zipPath };
        } else s.job = { estado: "error", error: r.motivo, informe: r.informe };
      })
      .catch((e) => {
        console.error("[plannings] generación", e);
        s.job = { estado: "error", error: "La generación ha fallado: " + e.message };
      })
      .finally(() => {
        generando = false;
        s.busy = false;
        S.touch(s);
      });
  })
);

// Volver a leer la biblioteca de la app (por si se ha subido algo mientras tanto)
router.post(
  "/sesiones/:id/biblioteca/actualizar",
  loadSession,
  wrap(async (req, res) => {
    await S.ensureBd(req.sesion, true);
    res.json(await estadoCompleto(req.sesion));
  })
);

// 7. Descargar el ZIP (un único botón)
router.get(
  "/sesiones/:id/descarga",
  loadSession,
  wrap(async (req, res) => {
    const s = req.sesion;
    if (!s.job || s.job.estado !== "listo" || !s.job.zipPath || !fs.existsSync(s.job.zipPath)) {
      return res.status(409).json({ mensaje: "Todavía no hay nada generado para descargar" });
    }
    const nombre = path.basename(s.job.zipPath);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"; filename*=UTF-8''${encodeURIComponent(nombre)}`);
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(s.job.zipPath).pipe(res);
  })
);

// 8. Terminar: borra todos los archivos de la sesión
router.delete(
  "/sesiones/:id",
  loadSession,
  wrap(async (req, res) => {
    if (req.sesion.busy) return res.status(409).json({ mensaje: "Se está generando; espera a que termine" });
    S.destroy(req.sesion.id);
    res.json({ ok: true });
  })
);

// Errores de la subida (tamaño, demasiados archivos...) con mensaje propio
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === "LIMIT_FILE_SIZE"
        ? `Un archivo supera el máximo permitido (${Math.round(S.LIMITS.maxZip / 1048576)} MB para zip, ${Math.round(S.LIMITS.maxFile / 1048576)} MB por documento)`
        : `Error al subir: ${err.message}`;
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ mensaje: msg });
  }
  next(err);
});

module.exports = router;
