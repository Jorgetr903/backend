const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");
const path = require("path");

const app = express();
const publicDir = path.join(__dirname, "public");
const uploadsDir = path.join(publicDir, "uploads");

connectDB();

const corsOptions = {
  origin: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Disposition"],
};

app.use(cors(corsOptions));
app.use(express.json());

function encodeContentDispositionFilename(filename) {
  return encodeURIComponent(filename)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}

function resolveUploadPath(filename) {
  const filePath = path.resolve(uploadsDir, filename);
  const uploadsRoot = path.resolve(uploadsDir) + path.sep;

  if (!filePath.startsWith(uploadsRoot)) {
    return null;
  }

  return filePath;
}

app.get("/uploads/:file/download", (req, res, next) => {
  const filePath = resolveUploadPath(req.params.file);

  if (!filePath) {
    return res.status(400).send("Ruta de archivo no valida");
  }

  return res.download(filePath, req.params.file, (err) => {
    if (err && !res.headersSent) {
      next(err);
    }
  });
});

app.use("/uploads", express.static(uploadsDir, {
  setHeaders: (res, filePath) => {
    if (path.extname(filePath).toLowerCase() === ".pdf") {
      const filename = path.basename(filePath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeContentDispositionFilename(filename)}`,
      );
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }
  },
}));

app.use(express.static(publicDir));

app.use("/api/recursos", require("./routes/recursos"));

app.get("/", (req, res) => {
  res.send("Servidor de Recursos Monitores funcionando!");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
