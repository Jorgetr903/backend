const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const Kiosko = require('../models/Kiosko');

// ─────────────────────────────────────────────────────────────────
// GET /api/kiosko/:anio/export/pdf?modo=completo   (por defecto)
// GET /api/kiosko/:anio/export/pdf?modo=blanco
//
// modo=completo → PDF con todos los gastos registrados
// modo=blanco   → PDF con las páginas vacías para imprimir antes
//                 del campamento (igual que la plantilla original)
// ─────────────────────────────────────────────────────────────────
router.get('/:anio/export/pdf', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const modo = req.query.modo === 'blanco' ? 'blanco' : 'completo';

    const kiosko = await Kiosko.findOne({ anio });
    if (!kiosko) {
      return res.status(404).json({ error: `Cuaderno ${anio} no encontrado` });
    }

    const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: false });

    const nombreArchivo = modo === 'blanco'
      ? `Cuaderno_Kiosko_${anio}_EnBlanco.pdf`
      : `Cuaderno_Kiosko_${anio}_Completo.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    doc.pipe(res);

    // Portada
    _generarPortada(doc, anio);

    // Una página por acampado
    kiosko.acampados.forEach(acampado => {
      if (modo === 'blanco') {
        _generarPaginaEnBlanco(doc, acampado);
      } else {
        _generarPaginaCompleta(doc, acampado);
      }
    });

    doc.end();

  } catch (err) {
    // Si ya se empezó a enviar el PDF, no podemos enviar JSON
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/kiosko/:anio
// Devuelve el cuaderno completo de un año
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// GET /api/kiosko/:anio/sync
// Devuelve datos actualizados (para sincronización offline en Flutter)
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// POST /api/kiosko
// Crea un nuevo cuaderno para un año
// Body: { anio: 2026, acampados: [{nombre, apellidos, totalTraido?}] }
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
// Añade uno o varios acampados al cuaderno
// Body: { acampados: [{nombre, apellidos, totalTraido?}] }
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// PATCH /api/kiosko/:anio/acampados/:acampadoId/dinero
// Actualiza el dinero traído por un acampado
// Body: { totalTraido: 50 }
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
// Registra un gasto diario
// Body: { dia: 1, cantidad: 2.5 }
// ─────────────────────────────────────────────────────────────────
router.post('/:anio/acampados/:acampadoId/gastos', async (req, res) => {
  try {
    const anio = parseInt(req.params.anio);
    const { acampadoId } = req.params;
    // descripcion y fecha eliminados según decisión del proyecto
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
// Elimina un gasto por su índice en el array
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
// Elimina un acampado del cuaderno
// ─────────────────────────────────────────────────────────────────
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


// ═══════════════════════════════════════════════════════════════════
//  FUNCIONES AUXILIARES DE GENERACIÓN DE PDF
// ═══════════════════════════════════════════════════════════════════

// Colores corporativos del cuaderno
const AZUL = '#1A5FA8';
const GRIS_LINEA = '#CCCCCC';
const GRIS_CABECERA = '#F0F4FA';

function _generarPortada(doc, anio) {
  doc.addPage();

  const { width, height } = doc.page;

  // Fondo azul claro diagonal (simulado con rectángulo)
  doc.rect(0, 0, width, height).fill('#D6EAF8');

  // Rectángulo blanco central (el "cuaderno")
  const margenH = 60;
  const margenV = 80;
  doc
    .roundedRect(margenH, margenV, width - margenH * 2, height - margenV * 2, 8)
    .fillAndStroke('white', GRIS_LINEA);

  // Título
  doc
    .fillColor(AZUL)
    .fontSize(42)
    .font('Helvetica-Bold')
    .text('CUADERNO', 0, height / 2 - 80, { align: 'center' });

  doc
    .fontSize(42)
    .text('DEL KIOSKO', 0, height / 2 - 25, { align: 'center' });

  // Año
  doc
    .fontSize(18)
    .fillColor('#4A90D9')
    .font('Helvetica')
    .text(`CSP ${anio}`, 0, height / 2 + 50, { align: 'center' });
}

function _generarPaginaEnBlanco(doc, acampado) {
  doc.addPage();

  const { width } = doc.page;
  const margenIzq = 40;
  const margenDer = width - 40;
  const anchoUtil = margenDer - margenIzq;

  // Nombre del acampado
  doc
    .fillColor(AZUL)
    .fontSize(16)
    .font('Helvetica-Bold')
    .text(`${acampado.nombre} ${acampado.apellidos}`, margenIzq, 50, {
      width: anchoUtil,
      align: 'center'
    });

  // Línea separadora bajo el nombre
  doc
    .moveTo(margenIzq, 75)
    .lineTo(margenDer, 75)
    .strokeColor(AZUL)
    .lineWidth(1.5)
    .stroke();

  // "Total traído:" con espacio para rellenar a mano
  doc
    .fillColor('black')
    .fontSize(11)
    .font('Helvetica-Bold')
    .text('Total traído:', margenIzq, 90);

  // Línea punteada para escribir el importe a mano
  doc
    .moveTo(margenIzq + 85, 103)
    .lineTo(margenIzq + 200, 103)
    .strokeColor(GRIS_LINEA)
    .lineWidth(0.8)
    .stroke();

  // Cabecera de la tabla
  _dibujarCabecera(doc, 118, margenIzq, anchoUtil);

  // 10 filas vacías para rellenar a mano
  let y = 143;
  for (let i = 0; i < 10; i++) {
    _dibujarFilaVacia(doc, y, margenIzq, anchoUtil);
    y += 22;
  }
}

function _generarPaginaCompleta(doc, acampado) {
  doc.addPage();

  const { width } = doc.page;
  const margenIzq = 40;
  const margenDer = width - 40;
  const anchoUtil = margenDer - margenIzq;

  // Nombre del acampado
  doc
    .fillColor(AZUL)
    .fontSize(16)
    .font('Helvetica-Bold')
    .text(`${acampado.nombre} ${acampado.apellidos}`, margenIzq, 50, {
      width: anchoUtil,
      align: 'center'
    });

  // Línea separadora
  doc
    .moveTo(margenIzq, 75)
    .lineTo(margenDer, 75)
    .strokeColor(AZUL)
    .lineWidth(1.5)
    .stroke();

  // Total traído (con valor rellenado)
  const totalTraido = Number(acampado.totalTraido) || 0;
  doc
    .fillColor('black')
    .fontSize(11)
    .font('Helvetica-Bold')
    .text('Total traído:', margenIzq, 90);

  doc
    .font('Helvetica')
    .fillColor(AZUL)
    .text(`${totalTraido.toFixed(2)} €`, margenIzq + 88, 90);

  // Cabecera de la tabla
  _dibujarCabecera(doc, 118, margenIzq, anchoUtil);

  // Filas con datos
  let y = 143;
  let acumulado = 0;

  if (acampado.gastos && acampado.gastos.length > 0) {
    acampado.gastos.forEach(g => {
      const cantidad = Number(g.cantidad) || 0;
      acumulado += cantidad;

      // Fondo alternado suave
      if (acampado.gastos.indexOf(g) % 2 === 0) {
        doc
          .rect(margenIzq, y - 3, anchoUtil, 20)
          .fill('#F7FAFD');
      }

      doc.fillColor('black').font('Helvetica').fontSize(10);

      // Columna Día
      doc.text(`${g.dia}`, margenIzq + 5, y, { width: 60, align: 'center' });

      // Columna Gastado
      doc.text(`${cantidad.toFixed(2)} €`, margenIzq + 5 + 65, y, {
        width: 120,
        align: 'center'
      });

      // Columna Total acumulado
      doc
        .fillColor(acumulado > totalTraido ? '#CC0000' : '#1A7A40')
        .text(`${acumulado.toFixed(2)} €`, margenIzq + 5 + 65 + 125, y, {
          width: anchoUtil - 65 - 125 - 10,
          align: 'center'
        });

      // Línea separadora entre filas
      doc
        .moveTo(margenIzq, y + 17)
        .lineTo(margenDer, y + 17)
        .strokeColor(GRIS_LINEA)
        .lineWidth(0.4)
        .stroke();

      y += 22;
    });
  } else {
    // Sin gastos registrados
    doc
      .fillColor(GRIS_LINEA)
      .fontSize(10)
      .font('Helvetica')
      .text('Sin gastos registrados', margenIzq, y + 5, {
        width: anchoUtil,
        align: 'center'
      });
  }

  // Resumen final al pie
  const totalGastado = Number(acampado.totalGastado) || acampado.gastos.reduce((s, g) => s + Number(g.cantidad), 0);
  const saldo = totalTraido - totalGastado;

  const yResumen = Math.max(y + 15, 680);

  doc
    .moveTo(margenIzq, yResumen)
    .lineTo(margenDer, yResumen)
    .strokeColor(AZUL)
    .lineWidth(1)
    .stroke();

  doc.fontSize(10).font('Helvetica-Bold');

  doc.fillColor('black').text('Total gastado:', margenIzq, yResumen + 8);
  doc.fillColor('#CC3300').text(`${totalGastado.toFixed(2)} €`, margenIzq + 100, yResumen + 8);

  doc.fillColor('black').text('Saldo restante:', margenIzq + 200, yResumen + 8);
  doc.fillColor(saldo >= 0 ? '#1A7A40' : '#CC0000').text(
    `${saldo.toFixed(2)} €`,
    margenIzq + 300,
    yResumen + 8
  );
}

// Dibuja la cabecera de la tabla (compartida por ambos modos)
function _dibujarCabecera(doc, y, margenIzq, anchoUtil) {
  // Fondo de la cabecera
  doc
    .rect(margenIzq, y - 3, anchoUtil, 20)
    .fill(GRIS_CABECERA);

  // Línea superior e inferior de la cabecera
  doc
    .rect(margenIzq, y - 3, anchoUtil, 20)
    .strokeColor(AZUL)
    .lineWidth(0.8)
    .stroke();

  // Líneas verticales de separación de columnas
  doc
    .moveTo(margenIzq + 65, y - 3)
    .lineTo(margenIzq + 65, y + 17)
    .strokeColor(AZUL)
    .lineWidth(0.5)
    .stroke();

  doc
    .moveTo(margenIzq + 190, y - 3)
    .lineTo(margenIzq + 190, y + 17)
    .strokeColor(AZUL)
    .lineWidth(0.5)
    .stroke();

  // Textos de cabecera
  doc.fillColor(AZUL).fontSize(10).font('Helvetica-Bold');
  doc.text('Día', margenIzq + 5, y, { width: 60, align: 'center' });
  doc.text('Gastado', margenIzq + 70, y, { width: 115, align: 'center' });
  doc.text('Total acumulado', margenIzq + 195, y, {
    width: anchoUtil - 195,
    align: 'center'
  });
}

// Dibuja una fila vacía con línea punteada (para el modo en blanco)
function _dibujarFilaVacia(doc, y, margenIzq, anchoUtil) {
  // Líneas verticales de columnas
  doc
    .moveTo(margenIzq + 65, y - 3)
    .lineTo(margenIzq + 65, y + 19)
    .strokeColor(GRIS_LINEA)
    .lineWidth(0.4)
    .stroke();

  doc
    .moveTo(margenIzq + 190, y - 3)
    .lineTo(margenIzq + 190, y + 19)
    .strokeColor(GRIS_LINEA)
    .lineWidth(0.4)
    .stroke();

  // Línea horizontal inferior de la fila
  doc
    .moveTo(margenIzq, y + 19)
    .lineTo(margenIzq + anchoUtil, y + 19)
    .strokeColor(GRIS_LINEA)
    .lineWidth(0.4)
    .stroke();

  // Marco exterior de la fila
  doc
    .rect(margenIzq, y - 3, anchoUtil, 22)
    .strokeColor(GRIS_LINEA)
    .lineWidth(0.4)
    .stroke();
}

module.exports = router;
