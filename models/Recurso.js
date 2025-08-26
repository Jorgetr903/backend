// backend/models/Recurso.js
const mongoose = require("mongoose");

const RecursoSchema = new mongoose.Schema({
  titulo: { type: String, required: true },
  descripcion: { type: String },
  tipo: { type: String, required: true }, // formacion, actividad, dinamica
  anio: { type: Number }, // ejemplo: "2025"
  momento: { type: String }, // Mañana, Tarde, Velada, Olimpiada
  tema: { type: String }, // dinámicas
  grupo: { type: String }, // Pequeños, Medianos, Mayores
  archivoUrl: { type: String, required: true }, // ruta al PDF u otro archivo
  fecha: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Recurso", RecursoSchema);
