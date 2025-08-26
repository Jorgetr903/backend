const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const Recurso = require('../models/recurso_model');

// Configuración de Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Endpoint para subir recurso
router.post('/subir', upload.single('archivo'), async (req, res) => {
  try {
    const { titulo, descripcion, tipo, anio, momento, tema, grupo } = req.body;
    const archivoUrl = `/uploads/${req.file.filename}`;

    const nuevoRecurso = new Recurso({
      titulo,
      descripcion,
      tipo,
      anio,
      momento,
      tema,
      grupo,
      archivoUrl
    });

    await nuevoRecurso.save();
    res.json({ mensaje: 'Recurso subido correctamente', recurso: nuevoRecurso });
  } catch (err) {
    console.error(err);
    res.status(500).json({ mensaje: 'Error al subir el recurso' });
  }
});

module.exports = router;
