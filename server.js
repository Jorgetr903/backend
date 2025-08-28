const express = require("express");
const connectDB = require("./config/db"); // tu conexión a MongoDB
const cors = require("cors");
const path = require("path");

const app = express();

// Conectar a MongoDB
connectDB();

app.use(cors());
app.use(express.json());

// Servir archivos estáticos de la carpeta public
app.use(express.static(path.join(__dirname, "public")));

// Servir archivos subidos
app.use("/uploads", express.static(path.join(__dirname, "public/uploads")));

// Rutas de la API
app.use("/api/recursos", require("./routes/recursos"));

// Página de inicio opcional
app.get("/", (req, res) => {
  res.send("Servidor de Recursos Monitores funcionando!");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
