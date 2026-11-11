# Generador automático de plannings (CSP)

Rama: `feature/generador-plannings`. Todo es gratuito: sin servicios externos, sin cambios en Render ni Docker.

## Cómo se usa

1. Abre la app → **Generador de plannings** (o directamente `https://<tu-backend>/planning.html`). Pide la misma clave que la subida de recursos.
2. **Preparar el campamento**: año, niveles (por defecto Pequeños, Medianos, Mayores), lema y nombre de la enfermera (opcionales).
3. **Documentos**: sube todo junto (también un `.zip`). Se clasifica por el nombre y puedes mover cualquier archivo:
   - Excel → *Información general* (se detecta cuál es la tabla principal y cuál la de turnos por su contenido).
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
- Todas las páginas salen en vertical (A4). Las secciones apaisadas de los Word subidos se pasan a vertical escalando tablas e imágenes.
- Diseño original conservado (se fusiona el XML de cada Word con sus estilos, numeración e imágenes; no se pasa a texto plano).
- Dinámicas de cada nivel al final de su planning. Alergias y menú solo van a los plannings de destino (editable por documento).
- Bloques fijos del planning anterior (consejos y normas, servicio extra, teléfonos, primeros auxilios, Altus, formación) viven en `assets/plannings/base/`. *Servicio extra* y *Teléfonos* son del 2025: salen con aviso; sube tu versión en «Información general» (un Word cuyo nombre contenga `servicio` o `telefono`) para sustituirlos.
- 16+ comprobaciones automáticas por planning (verticalidad, días y orden, oraciones, olimpiadas/TLD una vez, datos sensibles, índice, etc.) recogidas en el informe.

## Privacidad

Los archivos se guardan en una carpeta temporal del servidor por sesión, se sobrescriben y borran al terminar («Borrar todos los archivos») o a las 3 h sin actividad, y las carpetas huérfanas se borran al arrancar. No se envía nada a servicios externos.

## Limitaciones conocidas

- **PDF**: solo se genera si el servidor tiene LibreOffice (`soffice`). Render (Node nativo) no lo trae: allí se entregan los DOCX y el informe lo avisa. Abre el DOCX en Word → Exportar a PDF. Los números de página del índice son campos de Word: Word los actualiza al abrir (acepta el aviso de «actualizar campos»); en el PDF de LibreOffice ya salen calculados.
- Los PDF subidos como documentos de actividades no se pueden incrustar en un Word (se marcan como incidencia: sube el `.docx`).
- Memoria: se genera un solo planning a la vez para caber en los 512 MB del plan gratuito. Límites: 25 MB por documento, 100 MB por zip, 300 MB por sesión.
- Páginas horizontales de la guía de primeros auxilios del año anterior se incluyen como imagen vertical (son una guía fija).
- Sin sesión persistente: si Render duerme o reinicia el servidor, hay que volver a subir los archivos.

## API (`/api/plannings`, cabecera `x-upload-key`)

`POST /sesiones` · `GET /sesiones/:id` · `PATCH /sesiones/:id` · `POST /sesiones/:id/documentos` (multipart: `categoria` o `auto`, `archivos[]`) · `DELETE /sesiones/:id/documentos/:docId` · `POST /sesiones/:id/generar` · `GET /sesiones/:id/descarga` · `DELETE /sesiones/:id`
