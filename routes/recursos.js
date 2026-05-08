const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const mongoose = require("mongoose");
const Recurso = require("../models/Recurso");

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

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../public/uploads"));
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${sanitizeFilename(file.originalname)}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

router.post("/subir", upload.single("archivo"), async (req, res) => {
  try {
    const { titulo, descripcion, tipo, anio, momento, tema, grupo } = req.body;
    const archivoUrl = `/uploads/${req.file.filename}`;

    const nuevoRecurso = new Recurso({
      titulo,
      descripcion,
      tipo,
      anio: anio ? Number(anio) : undefined,
      momento,
      tema,
      grupo,
      archivoUrl,
    });

    await nuevoRecurso.save();
    res.json({ mensaje: "Recurso subido correctamente", recurso: nuevoRecurso });
  } catch (err) {
    console.error(err);
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
