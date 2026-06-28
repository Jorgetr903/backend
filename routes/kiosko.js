const express = require('express');
const router = express.Router();
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const path = require('path');
const fs = require('fs');
const Kiosko = require('../models/Kiosko');

// ═══════════════════════════════════════════════════════════════════
//  COORDENADAS SOBRE LA PLANTILLA
//  Página landscape A4: 841.9 × 595.3 pts
//  Y medido desde el BORDE INFERIOR (sistema pdf-lib)
//
//  Columnas de la tabla:
//    Día             x = 33  → 291
//    Gastado         x = 291 → 550
//    Total acumulado x = 550 → 808
// ═══════════════════════════════════════════════════════════════════
const L = {
  nombre:      { x: 38,  y: 499, size: 11 },   // nombre del acampado
  totalTraido: { x: 650, y: 499, size: 10 },   // valor tras "Total traído:"
  taparNumero: { x: 748, y: 40,  w: 72, h: 22 }, // cubre "69" del template
  tabla: {
    primeraFilaY: 444,   // Y de la primera fila de datos
    alturaFila:   27.8,  // descenso por cada fila
    maxFilas:     13,    // filas disponibles por página
    dia:       { x: 50,  size: 10 },
    gastado:   { x: 305, size: 10 },
    acumulado: { x: 564, size: 10 },
  },
};

// Ruta a la plantilla (backend/assets/plantilla.pdf)
const PLANTILLA_PATH = path.join(__dirname, '../assets/plantilla.pdf');
const PORTADA_IDX    = 0;   // página 1  → portada
const TEMPLATE_IDX   = 68;  // página 69 → hoja en blanco del acampado

// ─────────────────────────────────────────────────────────────────
// GET /api/kiosko/:anio/export/pdf?modo=completo|blanco
// ─────────────────────────────────────────────────────────────────
// IMPORTANTE: esta ruta debe declararse ANTES de GET /:anio
// para que Express no la capture como si "export" fuera el :anio
// ─────────────────────────────────────────────────────────────────
router.get('/:anio/export/pdf', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const modo = req.query.modo === 'blanco' ? 'blanco' : 'completo';

    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) {
      return res.status(404).json({ error: `Cuaderno ${anio} no encontrado` });
    }

    // ── Cargar plantilla ────────────────────────────────────────
    const templateBytes = fs.readFileSync(PLANTILLA_PATH);
    const templatePdf   = await PDFDocument.load(templateBytes);

    // ── Crear PDF de salida ─────────────────────────────────────
    const pdfDoc  = await PDFDocument.create();
    const font    = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontB   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const NEGRO   = rgb(0, 0, 0);
    const AZUL    = rgb(0.1, 0.35, 0.65);
    const BLANCO  = rgb(1, 1, 1);

    // ── Portada (se copia tal cual) ─────────────────────────────
    const [portada] = await pdfDoc.copyPages(templatePdf, [PORTADA_IDX]);
    pdfDoc.addPage(portada);

    // ── Una página por acampado ─────────────────────────────────
    for (const acampado of kiosko.acampados) {
      const [page] = await pdfDoc.copyPages(templatePdf, [TEMPLATE_IDX]);
      pdfDoc.addPage(page);

      const nombre = `${acampado.nombre} ${acampado.apellidos}`.trim();

      // Cubrir el número de página "69" del template
      page.drawRectangle({
        x: L.taparNumero.x,
        y: L.taparNumero.y,
        width:  L.taparNumero.w,
        height: L.taparNumero.h,
        color:  BLANCO,
      });

      // Nombre del acampado (azul, negrita)
      page.drawText(nombre, {
        x:    L.nombre.x,
        y:    L.nombre.y,
        size: L.nombre.size,
        font: fontB,
        color: AZUL,
      });

      // ── Modo completo: dinero traído + gastos ────────────────
      if (modo === 'completo') {
        const totalTraido = Number(acampado.totalTraido) || 0;

        page.drawText(`${totalTraido.toFixed(2)} \u20AC`, {
          x:    L.totalTraido.x,
          y:    L.totalTraido.y,
          size: L.totalTraido.size,
          font,
          color: NEGRO,
        });

        let acumulado = 0;
        const gastos  = acampado.gastos.slice(0, L.tabla.maxFilas);

        gastos.forEach((gasto, i) => {
          const y       = L.tabla.primeraFilaY - i * L.tabla.alturaFila;
          const cantidad = Number(gasto.cantidad) || 0;
          acumulado += cantidad;

          // Día
          page.drawText(String(gasto.dia), {
            x:    L.tabla.dia.x,
            y,
            size: L.tabla.dia.size,
            font,
            color: NEGRO,
          });

          // Gastado
          page.drawText(`${cantidad.toFixed(2)} \u20AC`, {
            x:    L.tabla.gastado.x,
            y,
            size: L.tabla.gastado.size,
            font,
            color: NEGRO,
          });

          // Total acumulado
          page.drawText(`${acumulado.toFixed(2)} \u20AC`, {
            x:    L.tabla.acumulado.x,
            y,
            size: L.tabla.acumulado.size,
            font,
            color: NEGRO,
          });
        });
      }
      // ── Modo blanco: solo el nombre, sin datos ───────────────
      // (la tabla vacía ya viene de la plantilla)
    }

    // ── Serializar y devolver ───────────────────────────────────
    const pdfBytes = await pdfDoc.save();

    const nombreArchivo = modo === 'blanco'
      ? `Cuaderno_Kiosko_${anio}_EnBlanco.pdf`
      : `Cuaderno_Kiosko_${anio}_Completo.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nombreArchivo}"`,
    );
    res.end(Buffer.from(pdfBytes));

  } catch (err) {
    console.error('Error generando PDF:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/kiosko/:anio
// ─────────────────────────────────────────────────────────────────
router.get('/:anio', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: `No hay cuaderno para ${anio}` });
    res.json(kiosko);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/kiosko/:anio/sync
// ─────────────────────────────────────────────────────────────────
router.get('/:anio/sync', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: 'Cuaderno no encontrado' });
    res.json({ anio: kiosko.anio, updatedAt: kiosko.updatedAt, acampados: kiosko.acampados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/kiosko
// Body: { anio, acampados: [{nombre, apellidos, totalTraido?}] }
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// POST /api/kiosko/:anio/acampados
// Body: { acampados: [{nombre, apellidos, totalTraido?}] }
// ─────────────────────────────────────────────────────────────────
router.post('/:anio/acampados', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampados } = req.body;
    if (!Array.isArray(acampados)) {
      return res.status(400).json({ error: 'Se esperaba un array de acampados' });
    }
    let kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) kiosko = new Kiosko({ anio, acampados: [] });
    kiosko.acampados.push(...acampados);
    await kiosko.save();
    res.status(201).json(kiosko);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// PATCH /api/kiosko/:anio/acampados/:acampadoId/dinero
// Body: { totalTraido }
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// POST /api/kiosko/:anio/acampados/:acampadoId/gastos
// Body: { dia, cantidad }
// ─────────────────────────────────────────────────────────────────
router.post('/:anio/acampados/:acampadoId/gastos', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampadoId } = req.params;
    const { dia, cantidad } = req.body;
    if (!dia || cantidad === undefined) {
      return res.status(400).json({ error: 'Los campos dia y cantidad son obligatorios' });
    }
    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: 'Cuaderno no encontrado' });
    const acampado = kiosko.acampados.id(acampadoId);
    if (!acampado) return res.status(404).json({ error: 'Acampado no encontrado' });
    acampado.gastos.push({ dia, cantidad });
    await kiosko.save();
    res.status(201).json(acampado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /api/kiosko/:anio/acampados/:acampadoId/gastos/:index
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// DELETE /api/kiosko/:anio/acampados/:acampadoId
// ─────────────────────────────────────────────────────────────────
router.delete('/:anio/acampados/:acampadoId', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampadoId } = req.params;
    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) return res.status(404).json({ error: 'Cuaderno no encontrado' });
    kiosko.acampados = kiosko.acampados.filter(
      a => a._id.toString() !== acampadoId,
    );
    await kiosko.save();
    res.json({ message: 'Acampado eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;