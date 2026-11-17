// services/plannings/tablasConfig.js
//
// Configuración central del diseño de las tablas del planning. Aquí (y no en la lógica de generación)
// viven los colores, anchos, tipos de letra y medidas: se cambian sin tocar el código que construye las tablas.
// Los datos (monitores, acampados, observaciones, coordinadores…) cambian cada año; esto no.

// Colores en HEX. «fila»: pastel suave de los bloques; «monitor»: algo más intenso (columna del monitor y títulos).
// Pequeños medido sobre el planning de referencia (DEEAF6 / BDD6EE); Medianos y Mayores siguen la misma relación (80 % / 60 % de aclarado)
const COLOR_PEQUENOS = "DEEAF6"; // azul pastel (bloques alternos)
const COLOR_PEQUENOS_MONITOR = "BDD6EE"; // azul suave (título y columna del monitor)
const COLOR_MEDIANOS = "FFF2CC"; // amarillo pastel
const COLOR_MEDIANOS_MONITOR = "FFE699"; // amarillo suave
const COLOR_MAYORES = "E2F0D9"; // verde pastel
const COLOR_MAYORES_MONITOR = "C5E0B3"; // verde suave
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
  // Reparto del ancho útil: monitor, nombre, apellidos, observaciones
  anchos: [0.18, 0.2, 0.29, 0.33],
  anchoMinObservaciones: 0.25, // las demás columnas pueden crecer a costa de esta si hay palabras largas
  // Tamaños de letra (pt), uniformes dentro de cada categoría
  fuentes: { titulo: 12, encabezado: 9, monitor: 9.5, nombre: 9.5, apellidos: 9.5, observaciones: 9 },
  // Grosor de los bordes (w:sz, octavos de punto)
  // exterior: contorno · bloque: separación entre monitores y vertical monitor|nombre · interior: filas de un mismo monitor
  bordes: { exterior: 12, interior: 4, bloque: 12, color: "000000" },
  // El planning de referencia no lleva fila de encabezado de columnas (solo el título del nivel)
  mostrarEncabezado: false,
  // El título lleva solo «NIVEL - N». Con true añadiría «(Coordinador: X)» leído del banner del Excel
  mostrarCoordinador: false,
  alturaMinFila: 300, // twips
  alturaTitulo: 400,
  alturaEncabezado: 340,
  margenCelda: { l: 70, r: 70, t: 20, b: 20 },
  // Página A4 APAISADA (apaisada: false las pondría en vertical)
  apaisada: true,
  pagina: { top: 1134, right: 765, bottom: 1200, left: 765, header: 511, footer: 960 },
  // Se usa este porcentaje de la altura útil al repartir las filas entre páginas (margen para diferencias entre Word y LibreOffice)
  aprovechamientoPagina: 0.93,
  encabezados: ["MONITOR / RESPONSABLE", "NOMBRE", "APELLIDOS", "OBSERVACIONES MÉDICAS / INFORMACIÓN RELEVANTE"],
};

module.exports = { TIENDAS };
