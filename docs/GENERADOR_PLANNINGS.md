# Generador automático de plannings (CSP)

Rama: `feature/generador-plannings`. Todo es gratuito: sin servicios externos, sin cambios en Render ni Docker.

## Cómo se usa

1. Abre la app → **Generador de plannings** (o directamente `https://<tu-backend>/planning.html`). Pide la misma clave que la subida de recursos.
2. **Preparar el campamento**: año, niveles (por defecto Pequeños, Medianos, Mayores), tema del año (cabecera, p. ej. «Rumbo a la Eternidad»), lema y **enfermeros/as** (separados por comas; opcional).
3. **Documentos**: sube todo junto (también un `.zip`). Se clasifica por el nombre y puedes mover cualquier archivo:
   - Excel → *Información general*: tabla principal, tabla de turnos y **contactos de monitores** (portada).
   - **Base de Datos CSP** (`.xlsx`, puede tener contraseña): hojas de tiendas con alergias / grupos de nivel, grupos de trabajo, servicio de comedor, enfermería y coches y autobuses. Cada hoja se reconoce por su nombre y se puede corregir en la pantalla. **Contraseña**: escríbela en el recuadro de la pantalla antes de subir el Excel; solo se usa en esa petición para abrirlo y no se guarda (el archivo abierto queda en la carpeta temporal de la sesión hasta borrarla).
   - Imagen **SVG**, PNG o JPG → *Logo del año* (índice y teléfonos). El SVG se convierte a PNG en el servidor.
   - `ORACIÓN …` → *Oraciones* (el nombre da el día, p. ej. `L27`, y `(noche)` si es de noche). Word o PDF.
   - `Alergias…`, `Menú…` → su categoría. El resto → *Actividades*.
   - **Actividades y dinámicas de la app**: se leen solas de la biblioteca (PDF subidos a la app). Para cada actividad se busca primero la de **este año**, y si no está, la de **otros años** (la más reciente). Un documento que subas aquí tiene prioridad sobre la app. Solo hay que subir lo que falte.
4. **Revisión previa**: por día, actividad ↔ documento (clara / probable / dudosa / sin coincidencia), responsables y enfermeros. Lo que corrijas a mano tiene prioridad.
5. **Qué plannings generar**: todos los aplicables vienen marcados (los bloques fijos se incluyen siempre).
6. **Generar**. Si quedan problemas por resolver sale un aviso de confirmación con la lista; si confirmas, se genera igualmente (lo que falta no se incluye y queda listado al principio de `INFORME.txt`). Resultado: un único ZIP (Word editable + PDF si hay LibreOffice + `INFORME.txt`).

### Enfermería
Para cada enfermero/a se busca su nombre en las hojas de grupos de nivel de la Base de Datos CSP y se añaden a su planning las dinámicas de ese nivel. Si hay enfermeros de **distintos niveles** se generan varios plannings de enfermería (uno por nivel); si comparten nivel, comparten planning. Si un nombre no aparece se pide elegir su nivel en la pantalla (si no, sale un planning «sin grupo» sin dinámicas).

## Reglas implementadas

- El orden lo fija la tabla principal; los días se identifican por su etiqueta (`L20`, `M21`…), no por posición.
- Cada día: tabla de horario → oración del día → actividades en orden (documento Word original) → oración de la noche (siempre al final del día).
- Olimpiadas y Tiempo libre dirigido (cualquier variante: «TL y TL Dirigido», «… y Quiosco», «… (torneos) y Quiosco») solo se desarrollan la primera vez; en el resto de días aparecen en el horario con «se desarrolla el día X».
- Días de lluvia: sin oraciones ni actividades con documento, y no cuentan como pendientes. El primer día no lleva oración de la mañana; todos los demás sí (falta → pendiente). La oración de la noche es opcional: si no hay documento no se marca nada. «Alarido» no es una actividad con documento.
- Responsables (tabla de turnos): un único nombre en negrita → solo ese; ninguno en negrita → todos los asignados; si no está claro → pendiente de revisión (nunca se adivina). `Act. tarde 1/2` se ordena por hora; `Act. mañana`, `Velada`, `Oración` / `Oración noche` también.
- **Estructura de cada planning** (como el de 2025): portada (título + tabla de contactos de todos los monitores + lema) → índice (con el logo del año) → consejos y normas → servicio extra → teléfonos → guías de primeros auxilios (4 páginas apaisadas) → Altus → formación → **tabla de turnos** → **grupos de nivel** (Pequeños, Medianos, Mayores) → **grupos de trabajo** → **servicio del comedor** → **planning general** (varias páginas apaisadas, 5 días por página) → días (tabla del día + oración + actividades + oración de la noche) → documentos propios del planning → dinámicas.
- **Formato**: texto base Calibri 11 (títulos Calibri Light), cabecera «CSP año / tema» y número de página como en 2025. Las tablas generadas (turnos, grupos, planning general, cada día) van en páginas **apaisadas**; la tabla de cada día ocupa una sola página, con varias columnas (hora + una por grupo), celdas combinadas y colores del Excel, y los **responsables dentro de la tabla** («Resp: NOMBRES») junto con «Servir», «Guardia» y «Quiosco» en las filas de comida, buenas noches y tiempo libre cuando la tabla de turnos los indica.
- Los Word que subes (actividades, oraciones, dinámicas…) **conservan su tipo de letra, márgenes, tamaño y orientación** originales (se fusiona el XML de cada Word con sus estilos, numeración e imágenes; no se pasa a texto plano).
- Los planning por nivel solo llevan la hoja de su nivel de la tabla de grupos de nivel (datos de los niños); enfermería, coordinadores y director llevan todas.
- Dinámicas de cada nivel al final de su planning. Alergias y menú solo van a los plannings de destino (editable por documento).
- Bloques fijos del planning anterior (consejos y normas, servicio extra, teléfonos, primeros auxilios, Altus, formación) viven en `assets/plannings/base/`. *Servicio extra* y *Teléfonos* son del 2025: salen con aviso; sube tu versión en «Información general» (un Word cuyo nombre contenga `servicio` o `telefono`) para sustituirlos.
- Unas 25 comprobaciones automáticas por planning (páginas apaisadas, Calibri 11, días y orden, cada día en una página, responsables dentro de la tabla, orden de los bloques, oraciones, olimpiadas/TLD una vez, datos sensibles, portada/índice/logo…) recogidas en el informe. Además el DOCX se ha validado contra el esquema de Word.

## Privacidad

Los archivos se guardan en una carpeta temporal del servidor por sesión, se sobrescriben y borran al terminar («Borrar todos los archivos») o a las 3 h sin actividad, y las carpetas huérfanas se borran al arrancar. No se envía nada a servicios externos.

## Limitaciones conocidas

- **PDF**: solo se genera si el servidor tiene LibreOffice (`soffice`). Render (Node nativo) no lo trae: allí se entregan los DOCX y el informe lo avisa. Abre el DOCX en Word → Exportar a PDF. Los números de página del índice son campos de Word: Word los actualiza al abrir (acepta el aviso de «actualizar campos»); en el PDF de LibreOffice ya salen calculados.
- Los **PDF** (la biblioteca de la app y los subidos) se incrustan en el Word como **imágenes de cada página** (≈120 ppp, hasta 150 páginas por PDF): se ven igual pero **no son texto editable**, y hacen que cada Word pese ~20-30 MB.
- Memoria: se genera un solo planning a la vez, pero convertir los PDF a imágenes necesita ~0,7-0,9 GB de RAM en pruebas, **más de los 512 MB de Render gratis**: si el servidor se queda sin memoria la generación falla. Alternativas: generar en local (`node server.js`) o subir temporalmente la instancia. Límites: 25 MB por documento, 100 MB por zip, 300 MB por sesión.
- La guía de primeros auxilios es una guía fija del planning 2025 incluida como imagen apaisada (4 páginas: RCP y OVACE pediátrica/adulto): se ve completa pero no es texto editable.
- Si no subes el logo del año, el índice no lo lleva y el bloque de teléfonos conserva el logo de 2025 (el informe lo avisa). Las fotos de los monitores/coordinadores del planning 2025 no se reproducen.
- Si los grupos de nivel/trabajo/servicio llegan como Word en vez de Excel, se incluyen tal cual (con su formato) pero no se filtran por nivel.
- La tabla del día hereda del Excel las filas y las celdas combinadas; si un día es muy denso, la letra baja (mínimo 6 pt, el informe avisa por debajo de 7 pt).
- Sin sesión persistente: si Render duerme o reinicia el servidor, hay que volver a subir los archivos.

## API (`/api/plannings`, cabecera `x-upload-key`)

`POST /sesiones` · `GET /sesiones/:id` · `PATCH /sesiones/:id` · `POST /sesiones/:id/documentos` (multipart: `categoria` o `auto`, `archivos[]`) · `DELETE /sesiones/:id/documentos/:docId` · `POST /sesiones/:id/generar` (JSON `{plannings:[ids], confirmarProblemas:true}`; sin confirmar y con problemas responde 409 `requiereConfirmacion`) · `POST /sesiones/:id/biblioteca/actualizar` · `GET /sesiones/:id/descarga` · `DELETE /sesiones/:id`
