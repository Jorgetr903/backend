const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const Recurso = require("../models/Recurso");

// Configuración de Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

// Endpoint para subir recurso
router.post("/subir", upload.single("archivo"), async (req, res) => {
  try {
    const { titulo, descripcion, tipo, anio, momento, tema, grupo } = req.body;
    const archivoUrl = `/uploads/${req.file.filename}`;

    const nuevoRecurso = new Recurso({
      titulo,
      descripcion,
      tipo,
      anio: anio ? Number(anio) : undefined, // aseguramos que sea número
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

// Listar recursos con filtros opcionales
router.get("/", async (req, res) => {
  try {
    const { tipo, anio, momento, tema, grupo, q, sort, page = 1, limit = 20 } = req.query;

    let filtro = {};

    if (tipo) filtro.tipo = tipo;
    if (anio) filtro.anio = Number(anio); // convertir a número
    if (momento) filtro.momento = momento;
    if (tema) filtro.tema = tema;
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
