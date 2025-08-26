// routes/recursos.js
const express = require("express");
const router = express.Router();
const Recurso = require("../models/Recurso");

// GET /api/recursos?tipo=dinamica&tema=Confianza&grupo=Mayores
router.get("/", async (req, res) => {
  try {
    const {
      tipo,
      categoria,
      anio,
      momento,
      tema,
      grupo,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};
    if (tipo) query.tipo = tipo;
    if (categoria) query.categoria = categoria;
    if (anio) query.anio = parseInt(anio);
    if (momento) query.momento = momento;
    if (tema) query.tema = tema;
    if (grupo) query.grupo = grupo;

    const recursos = await Recurso.find(query)
      .sort({ fecha: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    res.json(recursos);
  } catch (err) {
    res.status(500).json({ mensaje: "Error al obtener recursos" });
  }
});

module.exports = router;
