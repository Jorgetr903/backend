const mongoose = require('mongoose');

// Schema para cada gasto diario
// NOTA: se han eliminado los campos 'descripcion' y 'fecha'
const GastoSchema = new mongoose.Schema({
  dia: {
    type: Number,
    required: true
  },
  cantidad: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

// Schema para cada acampado
const AcampadoSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: true,
    trim: true
  },
  apellidos: {
    type: String,
    required: true,
    trim: true
  },
  totalTraido: {
    type: Number,
    default: 0,
    min: 0
  },
  gastos: {
    type: [GastoSchema],
    default: []
  }
}, { _id: true });

// Virtuals calculados (no se guardan en BD, se calculan al vuelo)
AcampadoSchema.virtual('totalGastado').get(function () {
  return this.gastos.reduce((sum, g) => sum + g.cantidad, 0);
});

AcampadoSchema.virtual('saldo').get(function () {
  return this.totalTraido - this.gastos.reduce((sum, g) => sum + g.cantidad, 0);
});

AcampadoSchema.set('toJSON', { virtuals: true });
AcampadoSchema.set('toObject', { virtuals: true });

// Schema principal: un documento por año de campamento
const KioskoSchema = new mongoose.Schema({
  anio: {
    type: Number,
    required: true,
    unique: true
  },
  acampados: {
    type: [AcampadoSchema],
    default: []
  }
}, { timestamps: true }); // timestamps añade createdAt y updatedAt automáticamente

// Ordenar acampados por nombre antes de guardar
KioskoSchema.pre('save', function (next) {
  this.acampados.sort((a, b) =>
    a.nombre.localeCompare(b.nombre, 'es') ||
    a.apellidos.localeCompare(b.apellidos, 'es')
  );
  next();
});

module.exports = mongoose.model('Kiosko', KioskoSchema);
