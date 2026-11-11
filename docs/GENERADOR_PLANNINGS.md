# Generador automático de plannings (CSP)

Rama: `feature/generador-plannings`. Todo es gratuito: sin servicios externos, sin cambios en Render ni Docker.

## Cómo se usa

1. Abre la app → **Generador de plannings** (o directamente `https://<tu-backend>/planning.html`). Pide la misma clave que la subida de recursos.
2. **Preparar el campamento**: año, niveles (por defecto Pequeños, Medianos, Mayores), tema del año (sale en la cabecera, p. ej. «Rumbo a la Eternidad»), lema y nombre de la enfermera (opcionales).
3. **Documentos**: sube todo junto (también un `.zip`). Se clasifica por el nombre y puedes mover cualquier archivo:
   - Excel → *Información general*. Se detecta por contenido cuál es la tabla principal y cuál la de turnos; el resto por el nombre (cámbialo en el desplegable si no acierta): **contactos de monitores** (`contactos`/`monitores`; obligatorio, va en la portada), **grupos de nivel** (`grupos de nivel`, `tiendas`, `pequeños`…: monitores con los niños de su tienda y alergias), **grupos de trabajo** y **servicio del comedor** (`servicio`, `comedor`…).
   - Imagen PNG/JPG → *Logo del año* (índice y bloque de teléfonos).
   - `ORACIÓN …` → *Oraciones* (el nombre da el día, p. ej. `L27`, `L-27`, y si es de noche: `(noche)` / `NOCHE`).
   - `Alergias…`, `Menú…`, `Dinámicas…` → su categoría. El resto → *Actividades*.
4. **Revisión previa**: por día, actividad ↔ documento (clara / probable / dudosa / sin coincidencia), responsables y oraciones. Lo que corrijas a mano tiene prioridad.
5. **Qué plannings generar**: todos los aplicables vienen marcados.
6. **Generar** → un único botón de descarga con un ZIP (Word editable + PDF de cada planning + `INFORME.txt`).

No se genera mientras haya incidencias críticas (documentos obligatorios pendientes, responsables dudosos, actividades sin documento…).

## Reglas implementadas

- El orden lo fija la tabla principal; los días se identifican por su etiqueta (`L20`, `M21`…), no por posición.
- Cada día: tabla de horario → oración del día → actividades en orden (documento Word original) → oración de la noche (siempre al final del día).
- Olimpiadas y Tiempo libre dirigido solo se desarrollan la primera vez; en el resto de días aparecen en el horario con «se desarrolla el día X».
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
- Los PDF subidos como documentos de actividades no se pueden incrustar en un Word (se marcan como incidencia: sube el `.docx`).
- Memoria: se genera un solo planning a la vez para caber en los 512 MB del plan gratuito. Límites: 25 MB por documento, 100 MB por zip, 300 MB por sesión.
- La guía de primeros auxilios es una guía fija del planning 2025 incluida como imagen apaisada (4 páginas: RCP y OVACE pediátrica/adulto): se ve completa pero no es texto editable.
- Si no subes el logo del año, el índice no lo lleva y el bloque de teléfonos conserva el logo de 2025 (el informe lo avisa). Las fotos de los monitores/coordinadores del planning 2025 no se reproducen.
- Si los grupos de nivel/trabajo/servicio llegan como Word en vez de Excel, se incluyen tal cual (con su formato) pero no se filtran por nivel.
- La tabla del día hereda del Excel las filas y las celdas combinadas; si un día es muy denso, la letra baja (mínimo 6 pt, el informe avisa por debajo de 7 pt).
- Sin sesión persistente: si Render duerme o reinicia el servidor, hay que volver a subir los archivos.

## API (`/api/plannings`, cabecera `x-upload-key`)

`POST /sesiones` · `GET /sesiones/:id` · `PATCH /sesiones/:id` · `POST /sesiones/:id/documentos` (multipart: `categoria` o `auto`, `archivos[]`) · `DELETE /sesiones/:id/documentos/:docId` · `POST /sesiones/:id/generar` · `GET /sesiones/:id/descarga` · `DELETE /sesiones/:id`
