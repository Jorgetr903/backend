const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const Recurso = require("../models/Recurso");

// Configuración multer para subir archivos
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Obtener todos los recursos con filtros opcionales
router.get("/", async (req, res) => {
  try {
    const { tipo, categoria } = req.query;
    let query = {};
    if (tipo) query.tipo = tipo;
    if (categoria) query.categoria = categoria;

    const recursos = await Recurso.find(query).sort({ fecha: -1 });
    res.json(recursos);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener recursos", error });
  }
});

// Subir un recurso
router.post("/upload", upload.single("archivo"), async (req, res) => {
  try {
    const { titulo, descripcion, categoria, tipo } = req.body;
    const tipo_archivo = path.extname(req.file.originalname).substring(1); // pdf, mp4, mp3
    const url_archivo = `/uploads/${req.file.filename}`;

    const recurso = new Recurso({
      titulo,
      descripcion,
      categoria,
      tipo,
      tipo_archivo,
      url_archivo
    });

    await recurso.save();
    res.json({ mensaje: "Recurso subido correctamente", recurso });
  } catch (error) {
    res.status(500).json({ mensaje: "Error al subir recurso", error });
  }
});

// Descargar un recurso
router.get("/download/:id", async (req, res) => {
  try {
    const recurso = await Recurso.findById(req.params.id);
    if (!recurso) return res.status(404).json({ mensaje: "Recurso no encontrado" });
    const filePath = path.join(__dirname, "..", recurso.url_archivo);
    res.download(filePath);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al descargar recurso", error });
  }
});

module.exports = router;
