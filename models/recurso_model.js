const mongoose = require('mongoose');

const RecursoSchema = new mongoose.Schema({
  titulo: { type: String, required: true },
  descripcion: { type: String },
  tipo: { type: String, required: true }, // formacion, actividad, dinamica
  anio: { type: String }, // solo actividades
  momento: { type: String }, // solo actividades: Mañana, Tarde, Velada, Olimpiada
  tema: { type: String }, // solo dinámicas
  grupo: { type: String }, // solo dinámicas: Pequeños, Medianos, Mayores
  archivoUrl: { type: String, required: true },
  fecha: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Recurso', RecursoSchema);
