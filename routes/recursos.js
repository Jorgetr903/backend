const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const mongoose = require("mongoose");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");
const checkUploadKey = require("../middleware/checkUploadKey");
const Recurso = require("../models/Recurso");

const TIPOS_VALIDOS = ["formacion", "actividad", "dinamica"];

function sanitizeFilename(originalName) {
  const extension = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, extension);
  const safeBaseName = baseName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return `${safeBaseName || "archivo"}${extension}`;
}

// ── Los PDFs se guardan en Cloudinary (ya no en el disco de Render) ──
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "recursos_csp",
    resource_type: "raw", // conserva el PDF tal cual
    public_id: (req, file) => {
      // Multer recibe el nombre del archivo como latin1 aunque el navegador
      // lo envie en UTF-8, y los acentos y la ñ llegan rotos. Lo recomponemos
      // antes de limpiarlo. El nombre acaba en ".pdf": la app lo necesita.
      const nombreUtf8 = Buffer.from(file.originalname, "latin1").toString("utf8");
      return `${Date.now()}-${sanitizeFilename(nombreUtf8)}`;
    },
  },
});

function pdfFileFilter(req, file, cb) {
  const esPdfPorTipo = file.mimetype === "application/pdf";
  const esPdfPorExtension = path.extname(file.originalname).toLowerCase() === ".pdf";

  if (esPdfPorTipo && esPdfPorExtension) {
    cb(null, true);
  } else {
    cb(new Error("SOLO_PDF"));
  }
}

const upload = multer({
  storage,
  fileFilter: pdfFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB (limite del plan gratuito de Cloudinary)
});

// Si algo falla despues de subir el PDF, lo borramos de Cloudinary
// para no dejar archivos huerfanos.
async function borrarSubida(file) {
  if (!file || !file.filename) return;
  try {
    await cloudinary.uploader.destroy(file.filename, { resource_type: "raw" });
  } catch (err) {
    console.error("No se pudo borrar el archivo de Cloudinary:", err);
  }
}

function limpiar(valor) {
  return typeof valor === "string" ? valor.trim() : "";
}

// Reglas de cada tipo (coinciden con los filtros de la app):
//  - actividad: año + momento
//  - dinamica:  año + grupo
//  - formacion: solo titulo, descripcion y PDF
function validarCampos(body) {
  const titulo = limpiar(body.titulo);
  const tipo = limpiar(body.tipo);
  const descripcion = limpiar(body.descripcion);

  if (!titulo) return { error: "El título es obligatorio" };
  if (!TIPOS_VALIDOS.includes(tipo)) return { error: "El tipo no es válido" };

  const datos = { titulo, tipo };
  if (descripcion) datos.descripcion = descripcion;

  if (tipo === "actividad" || tipo === "dinamica") {
    const anio = Number(limpiar(body.anio));
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
      return { error: "El año no es válido" };
    }
    datos.anio = anio;
  }

  if (tipo === "actividad") {
    const momento = limpiar(body.momento);
    if (!momento) return { error: "El momento es obligatorio en las actividades" };
    datos.momento = momento;
  }

  if (tipo === "dinamica") {
    const grupo = limpiar(body.grupo);
    if (!grupo) return { error: "El grupo es obligatorio en las dinámicas" };
    datos.grupo = grupo;
  }

  return { datos };
}

// El formulario la usa para comprobar la clave ANTES de subir el PDF
router.get("/comprobar-clave", checkUploadKey, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true });
});

router.post("/subir", checkUploadKey, upload.single("archivo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ mensaje: "No se ha recibido ningún archivo" });
    }

    const { error, datos } = validarCampos(req.body);
    if (error) {
      await borrarSubida(req.file);
      return res.status(400).json({ mensaje: error });
    }

    datos.archivoUrl = req.file.path; // URL permanente en Cloudinary

    const nuevoRecurso = new Recurso(datos);
    await nuevoRecurso.save();
    res.json({ mensaje: "Recurso subido correctamente", recurso: nuevoRecurso });
  } catch (err) {
    console.error(err);
    await borrarSubida(req.file);
    res.status(500).json({ mensaje: "Error al subir el recurso" });
  }
});

router.get("/", async (req, res) => {
  try {
    const { tipo, anio, momento, grupo, q, sort, page = 1, limit = 20 } = req.query;

    const filtro = {};

    if (tipo) filtro.tipo = tipo;
    if (anio) filtro.anio = Number(anio);
    if (momento) filtro.momento = momento;
    if (grupo) filtro.grupo = grupo;

    if (q && q.trim() !== "") {
      const regex = new RegExp(q.trim(), "i");
      filtro.$or = [{ titulo: regex }, { descripcion: regex }];
    }

    const sortMap = {
      recent: { fecha: -1 },
      oldest: { fecha: 1 },
      alpha: { titulo: 1 },
    };
    const sortBy = sortMap[sort] || sortMap.recent;

    const recursos = await Recurso.find(filtro)
      .sort(sortBy)
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    res.json(recursos);
  } catch (err) {
    console.error("Error al obtener recursos:", err);
    res.status(500).json({ mensaje: "Error al obtener los recursos" });
  }
});

router.get("/years", async (req, res) => {
  try {
    const years = await Recurso.distinct("anio", { tipo: "actividad" });
    years.sort((a, b) => b - a);
    res.json(years);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener los anios" });
  }
});

router.get("/years-dinamicas", async (req, res) => {
  try {
    const years = await Recurso.distinct("anio", { tipo: "dinamica" });
    years.sort((a, b) => b - a);
    res.json(years);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener los anios de dinamicas" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ mensaje: "ID de recurso no valido" });
    }

    const recurso = await Recurso.findById(req.params.id);

    if (!recurso) {
      return res.status(404).json({ mensaje: "Recurso no encontrado" });
    }

    return res.json(recurso);
  } catch (err) {
    console.error("Error al obtener recurso:", err);
    return res.status(500).json({ mensaje: "Error al obtener el recurso" });
  }
});

module.exports = router;