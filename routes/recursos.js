const express = require("express");
const router = express.Router();
const multer = require("multer");
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../cloudinary');
const Recurso = require("../models/Recurso");

// Configuración de Multer
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'Dynamic folders',       // Carpeta en Cloudinary
    format: async (req, file) => 'auto', // Mantiene extensión
  },
});

const upload = multer({ storage });

// Endpoint para subir recurso
router.post("/subir", upload.single("archivo"), async (req, res) => {
  try {
    const { titulo, descripcion, tipo, anio, momento, grupo } = req.body;
    const archivoUrl = req.file.path;

    const nuevoRecurso = new Recurso({
      titulo,
      descripcion,
      tipo,
      anio: anio ? Number(anio) : undefined,
      momento,
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

// Listar recursos con filtros opcionales
router.get("/", async (req, res) => {
  try {
    const { tipo, anio, momento, grupo, q, sort, page = 1, limit = 20 } = req.query;

    let filtro = {};

    if (tipo) filtro.tipo = tipo;
    if (anio) filtro.anio = Number(anio);
    if (momento) filtro.momento = momento;
    if (grupo) filtro.grupo = grupo;

    // Búsqueda por texto en título y descripción
    if (q && q.trim() !== "") {
      const regex = new RegExp(q.trim(), "i");
      filtro.$or = [{ titulo: regex }, { descripcion: regex }];
    }

    // Ordenación
    const sortMap = {
      recent: { fecha: -1 }, // más recientes (default)
      oldest: { fecha: 1 },  // más antiguos
      alpha: { titulo: 1 },  // A → Z
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

module.exports = router;
