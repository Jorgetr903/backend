// services/plannings/contactos.js
//
// Archivo de contactos de los monitores (nombre, correo, teléfono). Se reconoce por el contenido de las
// columnas y no por su posición: sirve con o sin fila de cabecera, con las columnas en cualquier orden,
// con filas vacías, con «Nombre» y «Apellidos» separados y con varias hojas.

const { loadWorkbook, plainText } = require("./xlsxReader");
const { norm } = require("./textutil");

const RE_EMAIL = /[^\s<>;,()"']+@[^\s<>;,()"']+\.[A-Za-z]{2,}/g;
const esEmail = (t) => /@/.test(t);
const digitos = (t) => (String(t).match(/\d/g) || []).length;
// teléfono: sobre todo dígitos (con espacios, puntos, guiones, paréntesis, prefijo +34)
const esTelefono = (t) => {
  const s = String(t).trim();
  return digitos(s) >= 7 && digitos(s) <= 15 && /^[+\d][\d\s.\-()/]*$/.test(s.replace(/\s*(y|o|\/|-)\s*(?=\+?\d)/gi, " "));
};
const esCabecera = (t) => /^(nombres?|apellidos?|monitor(es|a|as)?|nombre y apellidos?|correos?( electronico)?|e-?mail|mail|telefonos?|movil(es)?|tel\.?|telf\.?|contacto|numero|nº|n°)\b/.test(norm(t));

function limpiaTelefono(t) {
  const s = String(t).trim().replace(/\s+/g, " ");
  const d = s.replace(/\D/g, "");
  // 9 dígitos españoles → «600 000 001»; en otro caso se respeta lo escrito
  if (/^\+?(34)?\s?\d[\d\s.\-]*$/.test(s) && (d.length === 9 || (d.length === 11 && d.startsWith("34")))) {
    const n = d.slice(-9);
    return `${s.startsWith("+") || d.length === 11 ? "+34 " : ""}${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  return s;
}

/**
 * Lee las filas de contactos de un Excel.
 * @returns {{filas: {nombre:string,email:string,telefono:string}[], avisos: string[], error: string|null}}
 */
async function parseContactos(buffer, nombreArchivo = "el archivo de contactos") {
  const out = { filas: [], avisos: [], error: null };
  let wb;
  try {
    wb = await loadWorkbook(buffer);
  } catch (e) {
    out.error = `No se ha podido abrir ${nombreArchivo} como Excel (${e.message}).`;
    return out;
  }
  for (const ws of wb.worksheets) {
    const R = Math.min(ws.rowCount, 600);
    const C = Math.min(ws.columnCount, 12);
    const filas = [];
    for (let r = 1; r <= R; r++) {
      const cel = [];
      for (let c = 1; c <= C; c++) cel.push(plainText(ws.getCell(r, c)).replace(/\s*\n\s*/g, " ").trim());
      if (cel.some(Boolean)) filas.push({ r, cel });
    }
    if (!filas.length) continue;
    // clasificación de las columnas por su contenido
    const cuenta = (f) => Array.from({ length: C }, (_, c) => filas.filter((x) => x.cel[c] && f(x.cel[c])).length);
    const nEmail = cuenta(esEmail);
    const nTel = cuenta(esTelefono);
    const colEmail = nEmail.some((n) => n > 0) ? nEmail.indexOf(Math.max(...nEmail)) : -1;
    const colTel = nTel.some((n) => n > 0) ? nTel.indexOf(Math.max(...nTel.map((n, i) => (i === colEmail ? -1 : n)))) : -1;
    // cabecera: primera fila con palabras de cabecera y sin correo ni teléfono
    const cab = filas.find((x) => x.cel.some((t) => t && esCabecera(t)) && !x.cel.some((t) => esEmail(t) || esTelefono(t)));
    // columnas de nombre: las de texto con letras que no son correo ni teléfono
    const textual = cuenta((t) => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2}/.test(t) && !esEmail(t) && !esTelefono(t));
    let colsNombre = [];
    if (cab) {
      cab.cel.forEach((t, c) => {
        if (t && c !== colEmail && c !== colTel && /^(nombres?|apellidos?|monitor|monitora|monitores|nombre y apellidos?)\b/.test(norm(t))) colsNombre.push(c);
      });
    }
    if (!colsNombre.length) {
      const mejor = textual.indexOf(Math.max(...textual.map((n, i) => (i === colEmail || i === colTel ? -1 : n))));
      if (mejor >= 0 && textual[mejor] > 0) colsNombre = [mejor];
    }
    if (!colsNombre.length || (colEmail < 0 && colTel < 0)) {
      out.avisos.push(`La hoja «${ws.name}» no tiene columnas reconocibles de nombre y de correo o teléfono; se ha ignorado.`);
      continue;
    }
    if (colEmail < 0) out.avisos.push(`La hoja «${ws.name}» no tiene ninguna columna de correos.`);
    if (colTel < 0) out.avisos.push(`La hoja «${ws.name}» no tiene ninguna columna de teléfonos.`);
    for (const f of filas) {
      if (cab && f.r <= cab.r) continue; // título y cabecera
      const nombre = colsNombre.map((c) => f.cel[c]).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const celE = colEmail >= 0 ? f.cel[colEmail] : "";
      const celT = colTel >= 0 ? f.cel[colTel] : "";
      if (!nombre && !celE && !celT) continue;
      if (f.cel.filter(Boolean).length >= 2 && f.cel.filter(Boolean).every((t) => esCabecera(t))) continue; // cabecera repetida
      const emails = (celE.match(RE_EMAIL) || []).map((e) => e.replace(/[.,;]+$/, ""));
      if (celE && !emails.length) out.avisos.push(`Fila ${f.r} de «${ws.name}»: el correo «${celE}» no parece un correo válido.`);
      if (!nombre) {
        out.avisos.push(`Fila ${f.r} de «${ws.name}»: hay correo o teléfono pero falta el nombre; no se ha incluido.`);
        continue;
      }
      if (celT && !esTelefono(celT)) out.avisos.push(`Fila ${f.r} de «${ws.name}» (${nombre}): el teléfono «${celT}» tiene un formato raro; se copia tal cual.`);
      if (!emails.length && !celT) {
        // una fila de un solo texto en una hoja con datos puede ser un título o una nota
        if (filas.length > 3 && f.cel.filter(Boolean).length === 1) continue;
      }
      out.filas.push({ nombre, email: emails.join(" / "), telefono: celT ? limpiaTelefono(celT) : "" });
    }
  }
  // duplicados exactos (mismo nombre y mismo correo)
  const vistos = new Set();
  out.filas = out.filas.filter((f) => {
    const k = `${norm(f.nombre)}|${f.email.toLowerCase()}`;
    if (vistos.has(k)) {
      out.avisos.push(`«${f.nombre}» aparece repetido en el archivo de contactos; se incluye una sola vez.`);
      return false;
    }
    vistos.add(k);
    return true;
  });
  const sinEmail = out.filas.filter((f) => !f.email).map((f) => f.nombre);
  const sinTel = out.filas.filter((f) => !f.telefono).map((f) => f.nombre);
  if (sinEmail.length && sinEmail.length < out.filas.length) out.avisos.push(`Sin correo: ${sinEmail.slice(0, 6).join(", ")}${sinEmail.length > 6 ? "…" : ""}.`);
  if (sinTel.length && sinTel.length < out.filas.length) out.avisos.push(`Sin teléfono: ${sinTel.slice(0, 6).join(", ")}${sinTel.length > 6 ? "…" : ""}.`);
  if (!out.filas.length) out.error = `No se ha encontrado ningún monitor con nombre y correo o teléfono en ${nombreArchivo}. Comprueba que tiene una columna con los nombres, otra con los correos y otra con los teléfonos.`;
  return out;
}

module.exports = { parseContactos, esEmail, esTelefono, limpiaTelefono };
