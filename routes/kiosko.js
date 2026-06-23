const express = require('express');
const router = express.Router();
const Kiosko = require('../models/Kiosko');

// ─────────────────────────────────────────────
// GET /api/kiosko/:anio
// Devuelve el cuaderno completo de un año
// ─────────────────────────────────────────────
router.get('/:anio', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) {
      return res.status(404).json({ error: `No hay cuaderno para el año ${anio}` });
    }
    res.json(kiosko);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/kiosko
// Crea un nuevo cuaderno para un año
// Body: { anio: 2026, acampados: [{nombre, apellidos, totalTraido?}] }
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { anio, acampados } = req.body;
    if (!anio) return res.status(400).json({ error: 'El campo anio es obligatorio' });

    const existe = await Kiosko.findOne({ anio });
    if (existe) return res.status(409).json({ error: `Ya existe un cuaderno para ${anio}` });

    const kiosko = new Kiosko({ anio, acampados: acampados || [] });
    await kiosko.save();
    res.status(201).json(kiosko);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/kiosko/:anio/acampados
// Añade uno o varios acampados al cuaderno
// Body: { acampados: [{nombre, apellidos, totalTraido?}] }
// ─────────────────────────────────────────────
router.post('/:anio/acampados', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampados } = req.body;

    if (!acampados || !Array.isArray(acampados)) {
      return res.status(400).json({ error: 'Se esperaba un array de acampados' });
    }

    let kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) {
      kiosko = new Kiosko({ anio, acampados: [] });
    }

    kiosko.acampados.push(...acampados);
    await kiosko.save();
    res.status(201).json(kiosko);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/kiosko/:anio/acampados/:acampadoId/dinero
// Establece o actualiza el dinero traído por un acampado
// Body: { totalTraido: 50 }
// ─────────────────────────────────────────────
router.patch('/:anio/acampados/:acampadoId/dinero', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampadoId } = req.params;
    const { totalTraido } = req.body;

    if (totalTraido === undefined) {
      return res.status(400).json({ error: 'El campo totalTraido es obligatorio' });
    }

    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: 'Cuaderno no encontrado' });

    const acampado = kiosko.acampados.id(acampadoId);
    if (!acampado) return res.status(404).json({ error: 'Acampado no encontrado' });

    acampado.totalTraido = totalTraido;
    await kiosko.save();
    res.json(acampado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/kiosko/:anio/acampados/:acampadoId/gastos
// Registra un gasto diario para un acampado
// Body: { dia: 1, cantidad: 2.5, descripcion?: "Patatas", fecha?: "2026-07-01" }
// ─────────────────────────────────────────────
router.post('/:anio/acampados/:acampadoId/gastos', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampadoId } = req.params;
    const { dia, cantidad} = req.body;

    if (!dia || cantidad === undefined) {
      return res.status(400).json({ error: 'Los campos dia y cantidad son obligatorios' });
    }

    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: 'Cuaderno no encontrado' });

    const acampado = kiosko.acampados.id(acampadoId);
    if (!acampado) return res.status(404).json({ error: 'Acampado no encontrado' });

    acampado.gastos.push({ dia, cantidad});
    await kiosko.save();
    res.status(201).json(acampado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/kiosko/:anio/acampados/:acampadoId/gastos/:index
// Elimina un gasto concreto (por índice dentro del array de gastos)
// ─────────────────────────────────────────────
router.delete('/:anio/acampados/:acampadoId/gastos/:index', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampadoId } = req.params;
    const idx = parseInt(req.params.index);

    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: 'Cuaderno no encontrado' });

    const acampado = kiosko.acampados.id(acampadoId);
    if (!acampado) return res.status(404).json({ error: 'Acampado no encontrado' });

    if (idx < 0 || idx >= acampado.gastos.length) {
      return res.status(400).json({ error: 'Índice de gasto inválido' });
    }

    acampado.gastos.splice(idx, 1);
    await kiosko.save();
    res.json(acampado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/kiosko/:anio/acampados/:acampadoId
// Elimina un acampado del cuaderno
// ─────────────────────────────────────────────
router.delete('/:anio/acampados/:acampadoId', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampadoId } = req.params;

    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: 'Cuaderno no encontrado' });

    kiosko.acampados = kiosko.acampados.filter(
      a => a._id.toString() !== acampadoId
    );
    await kiosko.save();
    res.json({ message: 'Acampado eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/kiosko/:anio/sync?since=<timestamp>
// Devuelve datos actualizados desde una fecha (para sync offline)
// ─────────────────────────────────────────────
router.get('/:anio/sync', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: 'Cuaderno no encontrado' });

    res.json({
      anio: kiosko.anio,
      updatedAt: kiosko.updatedAt,
      acampados: kiosko.acampados
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
