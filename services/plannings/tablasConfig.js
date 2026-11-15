// services/plannings/tablasConfig.js
//
// Configuración central del diseño de las tablas del planning. Aquí (y no en la lógica de generación)
// viven los colores, anchos, tipos de letra y medidas: se cambian sin tocar el código que construye las tablas.
// Los datos (monitores, acampados, observaciones, coordinadores…) cambian cada año; esto no.

// Colores en HEX. «fila»: pastel suave de los bloques; «monitor»: algo más intenso (columna del monitor y títulos).
const COLOR_PEQUENOS = "DEEAF6"; // azul pastel
const COLOR_PEQUENOS_MONITOR = "9DC3E6"; // azul medio suave
const COLOR_MEDIANOS = "FFF2CC"; // amarillo pastel
const COLOR_MEDIANOS_MONITOR = "FFD966"; // amarillo medio suave
const COLOR_MAYORES = "E2F0D9"; // verde pastel
const COLOR_MAYORES_MONITOR = "A9D18E"; // verde medio suave
const COLOR_NEUTRO = "F2F2F2";
const COLOR_NEUTRO_MONITOR = "D9D9D9";

const TIENDAS = {
  paleta: {
    pequenos: { fila: COLOR_PEQUENOS, monitor: COLOR_PEQUENOS_MONITOR },
    medianos: { fila: COLOR_MEDIANOS, monitor: COLOR_MEDIANOS_MONITOR },
    mayores: { fila: COLOR_MAYORES, monitor: COLOR_MAYORES_MONITOR },
    neutro: { fila: COLOR_NEUTRO, monitor: COLOR_NEUTRO_MONITOR },
  },
  nombreNivel: { pequenos: "PEQUEÑOS", medianos: "MEDIANOS", mayores: "MAYORES" },
  // Reparto del ancho útil (A4 vertical): monitor, nombre, apellidos, observaciones
  anchos: [0.18, 0.2, 0.29, 0.33],
  anchoMinObservaciones: 0.25, // las demás columnas pueden crecer a costa de esta si hay palabras largas
  // Tamaños de letra (pt), uniformes dentro de cada categoría
  fuentes: { titulo: 12, encabezado: 9, monitor: 9.5, nombre: 9.5, apellidos: 9.5, observaciones: 9 },
  // Grosor de los bordes (w:sz, octavos de punto)
  bordes: { exterior: 12, interior: 4, bloque: 8, color: "000000" },
  alturaMinFila: 300, // twips
  alturaTitulo: 400,
  alturaEncabezado: 340,
  margenCelda: { l: 70, r: 70, t: 20, b: 20 },
  // Página A4 vertical
  pagina: { top: 1134, right: 850, bottom: 1200, left: 850, header: 511, footer: 960 },
  // Se usa este porcentaje de la altura útil al repartir las filas entre páginas (margen para diferencias entre Word y LibreOffice)
  aprovechamientoPagina: 0.93,
  encabezados: ["MONITOR / RESPONSABLE", "NOMBRE", "APELLIDOS", "OBSERVACIONES MÉDICAS / INFORMACIÓN RELEVANTE"],
};

module.exports = { TIENDAS };
