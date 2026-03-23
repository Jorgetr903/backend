const express = require("express");
const connectDB = require("./config/db"); // tu conexión a MongoDB
const cors = require("cors");
const path = require("path");

const app = express();

// Conectar a MongoDB
connectDB();

app.use(cors({
  origin: ["https://cspweb.onrender.com", "https://recursos-monitores.onrender.com", "https://appcsp.onrender.com", "http://localhost", /^http:\/\/localhost(:\d+)?$/],
}));
app.use(express.json());

// Servir archivos estáticos de la carpeta public
app.use(express.static(path.join(__dirname, "public")));

app.get("/uploads/:file", (req, res) => {
  const filePath = path.join(__dirname, "public/uploads", req.params.file);

  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) return res.status(404).send("Archivo no encontrado");

    // Headers importantes para abrir PDFs en PWA/web sin descargar
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Access-Control-Allow-Origin", "*"); // o tu lista de dominios
    res.sendFile(filePath);
  });
});

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
