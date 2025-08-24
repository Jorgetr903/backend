const mongoose = require("mongoose");

const RecursoSchema = new mongoose.Schema({
  titulo: { type: String, required: true },
  descripcion: { type: String },
  categoria: { type: String },
  tipo: { type: String, enum: ["formacion", "actividad", "dinamica"], required: true },
  fecha: { type: Date, default: Date.now },
  tipo_archivo: { type: String, enum: ["pdf", "video", "audio"], required: true },
  url_archivo: { type: String, required: true }
});

module.exports = mongoose.model("Recurso", RecursoSchema);
