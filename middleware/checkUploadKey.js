// middleware/checkUploadKey.js
//
// Protege la subida de recursos con una clave compartida.
// Compara la cabecera "x-upload-key" con la variable de entorno
// UPLOAD_KEY del servidor. Si no esta configurada, nadie puede subir.

function checkUploadKey(req, res, next) {
  const claveCorrecta = process.env.UPLOAD_KEY;

  if (!claveCorrecta) {
    console.error("UPLOAD_KEY no esta configurada en las variables de entorno");
    return res
      .status(500)
      .json({ mensaje: "El servidor no tiene configurada la clave de subida" });
  }

  const claveRecibida = req.headers["x-upload-key"];

  if (!claveRecibida || claveRecibida !== claveCorrecta) {
    return res.status(401).json({ mensaje: "Clave de acceso incorrecta" });
  }

  next();
}

module.exports = checkUploadKey;