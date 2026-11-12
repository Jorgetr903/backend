// services/plannings/basedatos.js
// «Base de Datos CSP»: Excel (normalmente protegido con contraseña) con las
// tiendas y alergias, los grupos de nivel y de trabajo, la enfermería y la
// organización de coches y autobuses.
//
//  - La contraseña se usa una sola vez, en memoria, para descifrar el archivo
//    al subirlo. No se guarda ni se escribe en ningún registro.
//  - Cada hoja se clasifica por su nombre (corregible a mano).
//  - Con el nombre de un monitor se averigua su grupo de nivel.

const { norm } = require("./textutil");
const { loadWorkbook, plainText } = require("./xlsxReader");

const ROLES_HOJA = [
  { id: "grupos_nivel", nombre: "Grupos de nivel (tiendas, niños y alergias)", destinos: ["todos"] },
  { id: "grupos_trabajo", nombre: "Grupos de trabajo", destinos: ["todos"] },
  { id: "servicio", nombre: "Servicio del comedor", destinos: ["todos"] },
  { id: "enfermeria", nombre: "Enfermería", destinos: ["enfermeria", "director"] },
  { id: "transporte", nombre: "Coches y autobuses", destinos: ["enfermeria", "coordinadores", "director"] },
  { id: "ignorar", nombre: "No incluir", destinos: [] },
];

/** Rol de una hoja según su nombre (null si no se reconoce) */
function rolPorNombre(nombre) {
  const n = norm(nombre);
  if (/enfermer/.test(n)) return "enfermeria";
  if (/coche|autobus|\bbus\b|transporte|vehiculo/.test(n)) return "transporte";
  if (/grupos? (de )?trabajo|\btrabajo\b/.test(n)) return "grupos_trabajo";
  if (/servicio|comedor|fregado/.test(n)) return "servicio";
  if (/tienda|grupos? (de )?nivel|\bnivel\b|pequen|median|mayor|alergi/.test(n)) return "grupos_nivel";
  return null;
}

function destinosPorDefecto(rol) {
  const r = ROLES_HOJA.find((x) => x.id === rol);
  return r ? r.destinos : [];
}

// ───────────────────────── Cifrado ─────────────────────────

const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function estaCifrado(buf) {
  return !!buf && buf.length > 8 && buf.subarray(0, 8).equals(CFB);
}

/**
 * Devuelve el .xlsx en claro. Si está cifrado, necesita la contraseña.
 * Errores con `codigo`: PASSWORD_REQUERIDA | PASSWORD_INCORRECTA | CIFRADO_NO_SOPORTADO
 */
async function descifrar(buf, password) {
  if (!estaCifrado(buf)) return buf;
  if (!password) {
    throw Object.assign(new Error("El Excel está protegido con contraseña: escríbela en el recuadro «Contraseña» de la Base de Datos CSP y vuelve a subirlo."), { status: 400, codigo: "PASSWORD_REQUERIDA" });
  }
  const officeCrypto = require("officecrypto-tool");
  try {
    return await officeCrypto.decrypt(buf, { password: String(password) });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/password|incorrect|contrase/i.test(m)) {
      throw Object.assign(new Error("La contraseña del Excel no es correcta."), { status: 400, codigo: "PASSWORD_INCORRECTA" });
    }
    throw Object.assign(new Error("No se ha podido abrir el Excel protegido (formato de cifrado no soportado). Guárdalo sin contraseña y súbelo de nuevo."), { status: 400, codigo: "CIFRADO_NO_SOPORTADO" });
  }
}

// ───────────────────────── Hojas ─────────────────────────

async function nombresDeHojas(buf) {
  const wb = await loadWorkbook(buf);
  return wb.worksheets.map((w) => w.name);
}

// ───────────────────────── Grupo de nivel de un monitor ─────────────────────────

const claveNivel = (n) => norm(n).replace(/\s+/g, "").slice(0, 5);

/** Palabras del nombre buscado ("María López" → ["maria","lopez"]) */
function palabras(nombre) {
  return norm(nombre)
    .split(" ")
    .filter((w) => w.length >= 2);
}

function contiene(textoNorm, ws) {
  if (!ws.length) return false;
  const set = new Set(textoNorm.split(" "));
  return ws.every((w) => set.has(w));
}

/**
 * Busca a un monitor por su nombre en las hojas indicadas y deduce su nivel
 * por el nombre de la hoja o por el título de sección que tiene encima.
 *
 * @param {{buffer:Buffer, hojas:string[]}[]} fuentes
 * @param {string} nombre
 * @param {string[]} niveles
 * @returns {Promise<{encontrado:boolean, niveles:string[], apariciones:object[]}>}
 */
async function nivelDeMonitor(fuentes, nombre, niveles) {
  const ws = palabras(nombre);
  const out = { encontrado: false, niveles: [], apariciones: [] };
  if (!ws.length) return out;
  const claves = niveles.map((n) => ({ nivel: n, clave: claveNivel(n) })).filter((x) => x.clave.length >= 3);
  const nivelDeTexto = (t) => {
    const s = norm(t).replace(/\s+/g, "");
    if (!s || s.length > 50) return null;
    const hit = claves.filter((c) => s.includes(c.clave));
    return hit.length === 1 ? hit[0].nivel : null;
  };

  for (const f of fuentes) {
    const wb = await loadWorkbook(f.buffer);
    for (const sheet of wb.worksheets) {
      if (f.hojas && !f.hojas.includes(sheet.name)) continue;
      const nivelHoja = nivelDeTexto(sheet.name);
      const R = Math.min(sheet.rowCount, 600);
      const C = Math.min(sheet.columnCount, 60);
      // títulos de sección: por columna y por fila
      const porColumna = new Map(); // col -> [{r, nivel}]
      const porFila = []; // [{r, nivel}]
      const hallazgos = [];
      for (let r = 1; r <= R; r++) {
        for (let c = 1; c <= C; c++) {
          const cell = sheet.getCell(r, c);
          if (cell.value == null) continue;
          const t = plainText(cell).replace(/\s+/g, " ");
          if (!t) continue;
          const nv = nivelDeTexto(t);
          if (nv) {
            if (!porColumna.has(c)) porColumna.set(c, []);
            porColumna.get(c).push({ r, nivel: nv });
            porFila.push({ r, nivel: nv });
          }
          if (contiene(norm(t), ws)) hallazgos.push({ r, c, texto: t });
        }
      }
      for (const h of hallazgos) {
        let nivel = nivelHoja;
        let via = nivelHoja ? "hoja" : null;
        if (!nivel) {
          const col = (porColumna.get(h.c) || []).filter((x) => x.r <= h.r).pop();
          if (col) {
            nivel = col.nivel;
            via = "columna";
          } else {
            const fila = porFila.filter((x) => x.r <= h.r).pop();
            if (fila) {
              nivel = fila.nivel;
              via = "sección";
            }
          }
        }
        out.apariciones.push({ hoja: sheet.name, fila: h.r, nivel: nivel || null, via });
      }
    }
  }
  const conNivel = out.apariciones.filter((a) => a.nivel);
  out.niveles = [...new Set(conNivel.map((a) => a.nivel))];
  out.encontrado = out.apariciones.length > 0;
  return out;
}

module.exports = { ROLES_HOJA, rolPorNombre, destinosPorDefecto, estaCifrado, descifrar, nombresDeHojas, nivelDeMonitor, claveNivel };
