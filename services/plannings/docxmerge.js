// services/plannings/docxmerge.js
//
// Motor que construye un DOCX a partir de muchos documentos Word completos.
//
// En lugar de extraer el texto y reescribirlo, cada documento fuente se
// incorpora a nivel OOXML (el XML interno del .docx):
//   - se conservan párrafos, tablas, imágenes, listas, cuadros de texto...
//   - los estilos del documento fuente se copian con un prefijo propio
//     (así los de un documento nunca pisan a los de otro) junto con los
//     valores por defecto (docDefaults) que ese documento tenía.
//   - la numeración (listas y viñetas) se copia renumerada.
//   - las imágenes se copian con nombres únicos.
//   - cada sección del documento fuente se fuerza a orientación VERTICAL
//     y se le aplica la cabecera/pie estándar del planning.
//   - las tablas e imágenes más anchas que la página vertical se reducen
//     proporcionalmente para no perder información.
//
// Todo se hace en memoria, un documento fuente cada vez (los documentos
// fuente son pequeños), de modo que el planning completo nunca se carga
// como un único DOM de varios MB.

const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const { NS, BASE_PREFIXES, PAGE, esc, run, para } = require("./ooxml");

const W = NS.w;
const R = NS.r;
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const parser = new DOMParser({
  onError: () => {}, // los documentos de Google Docs/Word a veces emiten avisos inocuos
});
const serializer = new XMLSerializer();

function parseXml(str) {
  return parser.parseFromString(str, "text/xml");
}

function els(node, local, uri = W) {
  return Array.from(node.getElementsByTagNameNS(uri, local));
}

function childEls(node, local, uri = W) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && c.localName === local && c.namespaceURI === uri) out.push(c);
  }
  return out;
}

function firstChild(node, local, uri = W) {
  return childEls(node, local, uri)[0] || null;
}

function wval(node) {
  return node ? node.getAttributeNS(W, "val") || node.getAttribute("w:val") : null;
}

function removeNode(n) {
  if (n && n.parentNode) n.parentNode.removeChild(n);
}

function ser(node) {
  return serializer.serializeToString(node);
}

function mimeFor(ext) {
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      bmp: "image/bmp",
      emf: "image/x-emf",
      wmf: "image/x-wmf",
      svg: "image/svg+xml",
      tif: "image/tiff",
      tiff: "image/tiff",
    }[ext] || null
  );
}

const NOFOLDERS = { createFolders: false };


// ───────────────────────── Fuente del cuerpo: Calibri Light 11 ─────────────────────────

/** ¿Es una tabla de material (RECURSOS MATERIALES / MATERIAL FUNGIBLE / NO FUNGIBLE)? Se mira el texto de su primera fila */
function esTablaMaterial(tbl) {
  // algunas tablas empiezan con una fila vacía de separación: se miran las tres primeras
  const trs = childEls(tbl, "tr").slice(0, 3);
  return trs.some((tr) => /material\s+(no\s+)?fungible|recursos\s+materiales/i.test(els(tr, "t").map((t) => t.textContent).join(" ")));
}

const FUENTE_CUERPO = "Calibri Light";
const FUENTE_SIMBOLO = /symbol|wingdings|webdings|segoe ui symbol|segoe ui emoji|emoji/i;

/**
 * Unifica la fuente del texto de cuerpo (actividades, oraciones, dinámicas): todo en Calibri Light
 * y los tamaños sueltos de 10 a 13,5 pt en 11 pt. Se respetan las fuentes de símbolos (viñetas
 * e iconos) y los títulos grandes (≥ 14 pt). Trabaja sobre el XML (documento, estilos, numeración).
 */
function normalizaFuentes(xml) {
  if (!xml) return xml;
  return xml
    .replace(/<w:rFonts\b[^>]*\/>/g, (m) => {
      const vals = [...m.matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]*)"/g)].map((x) => x[1]);
      if (vals.some((v) => FUENTE_SIMBOLO.test(v))) return m;
      return `<w:rFonts w:ascii="${FUENTE_CUERPO}" w:hAnsi="${FUENTE_CUERPO}" w:eastAsia="${FUENTE_CUERPO}" w:cs="${FUENTE_CUERPO}"/>`;
    })
    .replace(/<w:(sz|szCs) w:val="(\d+(?:\.\d+)?)"\/>/g, (m, tag, v) => {
      const n = parseFloat(v);
      return n >= 20 && n <= 27 ? `<w:${tag} w:val="22"/>` : m;
    });
}

class PlanningBuilder {
  /**
   * @param {object} opts {year, lema}
   */
  constructor(opts = {}) {
    this.year = opts.year || "";
    this.lema = opts.lema || "";
    this.tema = opts.tema || ""; // tema del año (p. ej. «Rumbo a la Eternidad»), va en la cabecera
    this.chunks = []; // XML de cuerpo, en orden
    this.styles = []; // XML de estilos copiados
    this.abstractNums = [];
    this.nums = [];
    this.media = new Map(); // nombre -> Buffer
    this.extraRels = []; // relaciones de documento (imágenes, enlaces)
    this.prefixes = { ...BASE_PREFIXES };
    this.counters = { src: 0, rel: 100, media: 0, docPr: 1, abstract: 1, num: 1, bookmark: 1 };
    this.warnings = [];
    this.stats = { sectionsForcedPortrait: 0, tablesScaled: 0, imagesScaled: 0, docs: 0 };
    this.bookmarks = []; // {id, name}
  }

  warn(msg) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  /** Calibri Light 11 en el texto de cuerpo (contenido importado de Word o de PDF) */
  normalizaFuentes(xml) {
    return normalizaFuentes(xml);
  }

  nextBookmark(prefix = "idx") {
    const id = this.counters.bookmark++;
    return { id, name: `${prefix}_${id}` };
  }

  // ───────────────────────── Secciones ─────────────────────────

  /**
   * sectPr estándar del planning. Márgenes y tamaños como en el planning de
   * referencia: vertical (1417/850) o apaisado para tablas (283/425).
   */
  sectPrXml({ type = "nextPage", margins, cols, landscape = false } = {}) {
    const m =
      margins ||
      (landscape
        ? { top: 960, right: 425, bottom: 1200, left: 283, header: 511, footer: 960 }
        : { top: 1360, right: 850, bottom: 1200, left: 1417, header: 511, footer: 960 });
    const w = landscape ? PAGE.h : PAGE.w;
    const h = landscape ? PAGE.w : PAGE.h;
    return (
      `<w:sectPr>` +
      `<w:headerReference w:type="default" r:id="rIdPlHdr"/>` +
      `<w:footerReference w:type="default" r:id="rIdPlFtr"/>` +
      (type ? `<w:type w:val="${type}"/>` : "") +
      `<w:pgSz w:w="${w}" w:h="${h}"${landscape ? ' w:orient="landscape"' : ""}/>` +
      `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="${m.header}" w:footer="${m.footer}" w:gutter="0"/>` +
      (cols || "") +
      `</w:sectPr>`
    );
  }

  /** Ancho útil (twips) de una sección generada */
  textWidth({ landscape = false, margins } = {}) {
    const m = margins || (landscape ? { left: 283, right: 425 } : { left: 1417, right: 850 });
    return (landscape ? PAGE.h : PAGE.w) - m.left - m.right;
  }

  /** Registra una imagen para usarla en XML generado; devuelve su rId */
  registerImage(buffer, ext = "png") {
    const name = `gen${++this.counters.media}.${ext.replace(/^\./, "").toLowerCase()}`;
    this.media.set(name, buffer);
    const rid = `rIdGen${this.counters.rel++}`;
    this.extraRels.push(`<Relationship Id="${rid}" Type="${REL_TYPE}/image" Target="media/${name}"/>`);
    return rid;
  }

  /** <w:drawing> en línea con una imagen ya registrada (cx, cy en EMU) */
  imageXml(rid, cx, cy, descr = "Logo") {
    const id = this.counters.docPr++;
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${id}" name="Imagen ${id}" descr="${descr}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="Imagen ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  }

  /**
   * Añade XML de cuerpo generado por la aplicación y cierra la sección
   * (nueva página + cabecera/pie estándar).
   * @param {string} xml  uno o varios <w:p>/<w:tbl>
   */
  addGenerated(xml, sectOpts = {}) {
    this.chunks.push(xml + para("", { sectPr: this.sectPrXml(sectOpts), after: 0, lineExact: 20 }));
  }

  // ─────────────────── Incorporar un DOCX completo ───────────────────

  /**
   * Incorpora un documento Word completo al final del planning.
   * @param {Buffer} buffer contenido del .docx
   * @param {object} opts {bookmark: {id,name}}  marcador para el índice
   */
  async addDocx(buffer, opts = {}) {
    const zip = await JSZip.loadAsync(buffer);
    const docFile = zip.file("word/document.xml");
    if (!docFile) throw new Error("El archivo no es un documento Word válido (falta word/document.xml)");

    // Algunos exportadores (Google Docs) escriben medidas con decimales (w:hanging="359.00000000000006"),
    // que Word no admite en estos atributos: se redondean a enteros.
    const redondea = (s) => s.replace(/(\sw:[A-Za-z]+=")(-?\d+\.\d+)(")/g, (m, a, v, c) => a + Math.round(parseFloat(v)) + c);
    const [docXml, relsXml, stylesXml, numXml] = (
      await Promise.all([
        docFile.async("string"),
        zip.file("word/_rels/document.xml.rels") ? zip.file("word/_rels/document.xml.rels").async("string") : "",
        zip.file("word/styles.xml") ? zip.file("word/styles.xml").async("string") : "",
        zip.file("word/numbering.xml") ? zip.file("word/numbering.xml").async("string") : "",
      ])
    ).map((s, i) => (i === 1 ? s : redondea(s)));

    const doc = parseXml(docXml);
    const root = doc.documentElement;
    const body = firstChild(root, "body");
    if (!body) throw new Error("Documento Word sin cuerpo");

    // Prefijos de espacio de nombres que usa este documento
    for (let i = 0; i < root.attributes.length; i++) {
      const a = root.attributes[i];
      if (a.name.startsWith("xmlns:")) {
        const p = a.name.slice(6);
        if (!this.prefixes[p]) this.prefixes[p] = a.value;
      }
    }

    const src = ++this.counters.src;
    const prefix = `S${src}_`;

    // 1. Limpiezas que no tienen sentido fuera del documento original
    this._stripUnsupported(body);

    // 2. Relaciones (imágenes, hipervínculos)
    const relMap = await this._copyRelationships(zip, relsXml, doc);

    // 3. Estilos y numeración
    const styleMap = this._copyStyles(stylesXml, numXml, doc, prefix);

    // 4. Identificadores únicos de dibujos
    for (const dp of els(doc, "docPr", NS.wp)) dp.setAttribute("id", String(this.counters.docPr++));

    // 5. Secciones: vertical + cabecera/pie estándar + tablas adaptadas
    this._processSections(body);

    // 6. Marcador para el índice en el primer párrafo
    if (opts.bookmark) this._insertBookmark(body, opts.bookmark);

    // 7. Serializar el cuerpo
    let xml = ser(body);
    xml = xml.replace(/^<w:body[^>]*>/, "").replace(/<\/w:body>\s*$/, "");
    this.chunks.push(this.normalizaFuentes(xml));
    this.stats.docs++;
    return { styleMap, relMap };
  }

  _stripUnsupported(body) {
    // Comentarios, notas al pie y marcadores internos: sus partes no se copian
    const kill = [
      "footnoteReference",
      "endnoteReference",
      "commentReference",
      "commentRangeStart",
      "commentRangeEnd",
      "bookmarkStart",
      "bookmarkEnd",
      "proofErr",
    ];
    for (const k of kill) for (const n of els(body, k)) removeNode(n);
    // Elementos de seguimiento de cambios: se aceptan los cambios tal cual están
    for (const n of els(body, "del")) removeNode(n);
    for (const n of els(body, "delText")) removeNode(n);
    for (const n of els(body, "moveFrom")) removeNode(n);
  }

  async _copyRelationships(zip, relsXml, doc) {
    const map = new Map(); // rId original -> rId nuevo
    if (!relsXml) return map;
    const rels = parseXml(relsXml);
    const relEls = Array.from(rels.getElementsByTagNameNS(REL_NS, "Relationship"));
    const byId = new Map(relEls.map((e) => [e.getAttribute("Id"), e]));

    // Atributos r:* usados en el documento
    const used = new Set();
    const all = doc.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      for (let j = 0; j < e.attributes.length; j++) {
        const a = e.attributes[j];
        if (a.namespaceURI === R || a.name.startsWith("r:")) used.add(a.value);
      }
    }

    for (const id of used) {
      const rel = byId.get(id);
      if (!rel) continue;
      const type = rel.getAttribute("Type") || "";
      const target = rel.getAttribute("Target") || "";
      const mode = rel.getAttribute("TargetMode");
      const newId = `rIdM${this.counters.rel++}`;
      if (type.endsWith("/hyperlink")) {
        this.extraRels.push(
          `<Relationship Id="${newId}" Type="${type}" Target="${esc(target)}"${mode ? ` TargetMode="${mode}"` : ""}/>`
        );
        map.set(id, newId);
      } else if (type.endsWith("/image")) {
        if (mode === "External") {
          this.extraRels.push(`<Relationship Id="${newId}" Type="${type}" Target="${esc(target)}" TargetMode="External"/>`);
          map.set(id, newId);
          continue;
        }
        const path = target.startsWith("/") ? target.slice(1) : `word/${target}`.replace(/word\/\.\.\//, "");
        const f = zip.file(path);
        if (!f) {
          this.warn(`Falta una imagen enlazada (${target}) en un documento fuente`);
          continue;
        }
        const ext = (target.split(".").pop() || "png").toLowerCase();
        const name = `m${++this.counters.media}.${ext}`;
        this.media.set(name, await f.async("nodebuffer"));
        this.extraRels.push(`<Relationship Id="${newId}" Type="${type}" Target="media/${name}"/>`);
        map.set(id, newId);
      }
      // headerReference/footerReference y demás relaciones se descartan a propósito
    }

    // Reescribir referencias r:* en el documento
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      for (let j = 0; j < e.attributes.length; j++) {
        const a = e.attributes[j];
        if (a.namespaceURI === R || a.name.startsWith("r:")) {
          if (a.localName === "id" && (e.localName === "headerReference" || e.localName === "footerReference")) continue;
          if (map.has(a.value)) a.value = map.get(a.value);
        }
      }
    }
    // Elementos que apuntan a partes que no copiamos (gráficos, objetos OLE...)
    for (const n of els(doc, "object")) {
      this.warn("Un documento contiene objetos incrustados (OLE) que no se han podido copiar");
      removeNode(n);
    }
    return map;
  }

  /**
   * Copia los estilos utilizados con prefijo propio y trae consigo los
   * valores por defecto del documento (docDefaults).
   */
  _copyStyles(stylesXml, numXml, doc, prefix) {
    const styleMap = new Map();
    const numMap = new Map();
    const body = firstChild(doc.documentElement, "body");

    // ── estilos del documento fuente
    let sdoc = null;
    const byId = new Map();
    let defaultPara = null;
    let defaultTbl = null;
    let docDefaults = null;
    if (stylesXml) {
      sdoc = parseXml(stylesXml);
      for (const s of els(sdoc, "style")) {
        const id = s.getAttributeNS(W, "styleId");
        byId.set(id, s);
        const isDef = s.getAttributeNS(W, "default");
        if (isDef === "1" || isDef === "true") {
          const t = s.getAttributeNS(W, "type");
          if (t === "paragraph") defaultPara = s;
          if (t === "table") defaultTbl = s;
        }
      }
      docDefaults = els(sdoc, "docDefaults")[0] || null;
    }

    const newId = (id) => `${prefix}${String(id).replace(/[^A-Za-z0-9_]/g, "")}`;
    const defaultsId = `${prefix}DocDefaults`;
    const normalId = defaultPara ? newId(defaultPara.getAttributeNS(W, "styleId")) : `${prefix}Normal`;

    // ── estilos usados en el cuerpo
    const used = new Set();
    for (const t of ["pStyle", "rStyle", "tblStyle"]) {
      for (const n of els(body, t)) {
        const v = wval(n);
        if (v) used.add(v);
      }
    }
    if (defaultPara) used.add(defaultPara.getAttributeNS(W, "styleId"));

    // cierre transitivo: basedOn / link / next
    const queue = Array.from(used);
    while (queue.length) {
      const id = queue.pop();
      const s = byId.get(id);
      if (!s) continue;
      for (const t of ["basedOn", "link", "next"]) {
        const ref = wval(firstChild(s, t));
        if (ref && !used.has(ref) && byId.has(ref)) {
          used.add(ref);
          queue.push(ref);
        }
      }
    }

    // ── numeración
    const numbering = numXml ? parseXml(numXml) : null;
    const absById = new Map();
    const numById = new Map();
    if (numbering) {
      for (const a of els(numbering, "abstractNum")) absById.set(a.getAttributeNS(W, "abstractNumId"), a);
      for (const n of els(numbering, "num")) numById.set(n.getAttributeNS(W, "numId"), n);
    }
    const mapNum = (oldId) => {
      if (oldId === "0") return "0";
      if (numMap.has(oldId)) return numMap.get(oldId);
      const num = numById.get(oldId);
      if (!num) return null;
      const absRef = wval(firstChild(num, "abstractNumId"));
      const abs = absById.get(absRef);
      if (!abs) return null;
      const newAbs = this.counters.abstract++;
      const newNum = this.counters.num++;
      numMap.set(oldId, String(newNum));
      const absClone = abs.cloneNode(true);
      absClone.setAttributeNS(W, "w:abstractNumId", String(newAbs));
      for (const t of ["nsid", "tmpl"]) for (const n of childEls(absClone, t)) removeNode(n);
      // enlaces de nivel a estilos: se conservan solo si el estilo se copia
      for (const ps of els(absClone, "pStyle")) {
        const v = wval(ps);
        if (v && used.has(v)) ps.setAttributeNS(W, "w:val", newId(v));
        else removeNode(ps);
      }
      this.abstractNums.push(normalizaFuentes(ser(absClone)));
      const numClone = num.cloneNode(true);
      numClone.setAttributeNS(W, "w:numId", String(newNum));
      const ref = firstChild(numClone, "abstractNumId");
      if (ref) ref.setAttributeNS(W, "w:val", String(newAbs));
      this.nums.push(ser(numClone));
      return String(newNum);
    };

    // ── estilo de valores por defecto (docDefaults)
    const ddPPr = docDefaults ? els(docDefaults, "pPr")[0] : null;
    const ddRPr = docDefaults ? els(docDefaults, "rPr")[0] : null;
    this.styles.push(
      `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${defaultsId}"><w:name w:val="${defaultsId}"/>` +
        `<w:qFormat/>${ddPPr ? ser(ddPPr) : ""}${ddRPr ? normalizaFuentes(ser(ddRPr)) : ""}</w:style>`
    );

    let hasNormal = false;
    for (const id of used) {
      const s = byId.get(id);
      if (!s) continue;
      const type = s.getAttributeNS(W, "type");
      const clone = s.cloneNode(true);
      clone.setAttributeNS(W, "w:styleId", newId(id));
      clone.setAttributeNS(W, "w:customStyle", "1");
      if (clone.hasAttributeNS(W, "default")) clone.removeAttributeNS(W, "default");
      const nm = firstChild(clone, "name");
      if (nm) nm.setAttributeNS(W, "w:val", newId(id));
      for (const t of ["basedOn", "link", "next"]) {
        const n = firstChild(clone, t);
        if (!n) continue;
        const ref = wval(n);
        if (ref && used.has(ref)) n.setAttributeNS(W, "w:val", newId(ref));
        else removeNode(n);
      }
      // los estilos de párrafo sin "basedOn" heredan los valores por defecto del documento
      if (type === "paragraph" && !firstChild(clone, "basedOn")) {
        const based = clone.ownerDocument.createElementNS(W, "w:basedOn");
        based.setAttributeNS(W, "w:val", defaultsId);
        const nm2 = firstChild(clone, "name");
        if (nm2 && nm2.nextSibling) clone.insertBefore(based, nm2.nextSibling);
        else clone.appendChild(based);
      }
      // numeración dentro del estilo
      for (const ni of els(clone, "numId")) {
        const mapped = mapNum(wval(ni));
        if (mapped == null) {
          const numPr = ni.parentNode;
          removeNode(numPr);
        } else ni.setAttributeNS(W, "w:val", mapped);
      }
      styleMap.set(id, newId(id));
      if (defaultPara && id === defaultPara.getAttributeNS(W, "styleId")) hasNormal = true;
      this.styles.push(normalizaFuentes(ser(clone)));
    }
    if (!hasNormal) {
      this.styles.push(
        `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${normalId}"><w:name w:val="${normalId}"/>` +
          `<w:basedOn w:val="${defaultsId}"/><w:qFormat/></w:style>`
      );
    }
    // estilo de tabla por defecto del documento fuente
    let tblDefaultId = null;
    if (defaultTbl) {
      const id = defaultTbl.getAttributeNS(W, "styleId");
      if (!styleMap.has(id)) {
        const clone = defaultTbl.cloneNode(true);
        clone.setAttributeNS(W, "w:styleId", newId(id));
        clone.setAttributeNS(W, "w:customStyle", "1");
        if (clone.hasAttributeNS(W, "default")) clone.removeAttributeNS(W, "default");
        const nm = firstChild(clone, "name");
        if (nm) nm.setAttributeNS(W, "w:val", newId(id));
        for (const t of ["basedOn", "link", "next"]) removeNode(firstChild(clone, t));
        this.styles.push(normalizaFuentes(ser(clone)));
        styleMap.set(id, newId(id));
      }
      tblDefaultId = newId(id);
    }

    // ── aplicar a los párrafos y tablas del cuerpo
    for (const t of ["pStyle", "rStyle", "tblStyle"]) {
      for (const n of els(body, t)) {
        const v = wval(n);
        if (v && styleMap.has(v)) n.setAttributeNS(W, "w:val", styleMap.get(v));
        else if (v) removeNode(n);
      }
    }
    for (const p of els(body, "p")) {
      let ppr = firstChild(p, "pPr");
      if (!ppr) {
        ppr = p.ownerDocument.createElementNS(W, "w:pPr");
        p.insertBefore(ppr, p.firstChild);
      }
      if (!firstChild(ppr, "pStyle")) {
        const ps = p.ownerDocument.createElementNS(W, "w:pStyle");
        ps.setAttributeNS(W, "w:val", normalId);
        ppr.insertBefore(ps, ppr.firstChild);
      }
    }
    if (tblDefaultId) {
      for (const t of els(body, "tbl")) {
        let tpr = firstChild(t, "tblPr");
        if (!tpr) {
          tpr = t.ownerDocument.createElementNS(W, "w:tblPr");
          t.insertBefore(tpr, t.firstChild);
        }
        if (!firstChild(tpr, "tblStyle")) {
          const ts = t.ownerDocument.createElementNS(W, "w:tblStyle");
          ts.setAttributeNS(W, "w:val", tblDefaultId);
          tpr.insertBefore(ts, tpr.firstChild);
        }
      }
    }
    // numeración en el cuerpo
    for (const ni of els(body, "numId")) {
      const mapped = mapNum(wval(ni));
      if (mapped == null) removeNode(ni.parentNode);
      else ni.setAttributeNS(W, "w:val", mapped);
    }
    return styleMap;
  }

  _insertBookmark(body, bm) {
    const p = els(body, "p")[0];
    if (!p) return;
    const doc = p.ownerDocument;
    const s = doc.createElementNS(W, "w:bookmarkStart");
    s.setAttributeNS(W, "w:id", String(bm.id));
    s.setAttributeNS(W, "w:name", bm.name);
    const e = doc.createElementNS(W, "w:bookmarkEnd");
    e.setAttributeNS(W, "w:id", String(bm.id));
    // Documento de un solo párrafo (p. ej. una página con una imagen): el párrafo lleva también
    // el cambio de sección y algunos visores contarían el marcador en la página anterior;
    // se usa un párrafo de ancla propio, casi invisible.
    const bloques = [];
    for (let c = body.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.localName !== "sectPr") bloques.push(c);
    if (bloques.length === 1) {
      const a = doc.createElementNS(W, "w:p");
      const apr = doc.createElementNS(W, "w:pPr");
      const sp = doc.createElementNS(W, "w:spacing");
      sp.setAttributeNS(W, "w:before", "0");
      sp.setAttributeNS(W, "w:after", "0");
      sp.setAttributeNS(W, "w:line", "20");
      sp.setAttributeNS(W, "w:lineRule", "exact");
      apr.appendChild(sp);
      a.appendChild(apr);
      a.appendChild(s);
      a.appendChild(e);
      body.insertBefore(a, p);
      return;
    }
    const ppr = firstChild(p, "pPr");
    const ref = ppr ? ppr.nextSibling : p.firstChild;
    p.insertBefore(s, ref);
    p.insertBefore(e, ref);
  }

  // ───────────────────── Secciones y orientación ─────────────────────

  /**
   * Recorre las secciones del documento fuente: todas pasan a vertical,
   * con cabecera/pie estándar, y se adaptan sus tablas e imágenes.
   */
  _processSections(body) {
    const doc = body.ownerDocument;
    const children = [];
    for (let c = body.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) children.push(c);

    // sectPr final del documento (hijo directo de body)
    let finalSect = children.find((c) => c.localName === "sectPr" && c.namespaceURI === W) || null;
    const items = children.filter((c) => c !== finalSect);

    // Si el último elemento no es un párrafo, hace falta uno para alojar el sectPr
    let last = items[items.length - 1];
    if (!last || last.localName !== "p") {
      const p = doc.createElementNS(W, "w:p");
      body.insertBefore(p, finalSect || null);
      items.push(p);
      last = p;
    }

    // Agrupar elementos por sección
    const groups = [];
    let cur = [];
    for (const it of items) {
      cur.push(it);
      let sp = null;
      if (it.localName === "p") {
        const ppr = firstChild(it, "pPr");
        sp = ppr ? firstChild(ppr, "sectPr") : null;
      }
      if (sp) {
        groups.push({ elements: cur, sect: sp, inPara: it });
        cur = [];
      }
    }
    if (cur.length) groups.push({ elements: cur, sect: finalSect, inPara: last, final: true });

    groups.forEach((g, idx) => {
      const old = g.sect;
      const pgSz = old ? firstChild(old, "pgSz") : null;
      const pgMar = old ? firstChild(old, "pgMar") : null;
      let ow = pgSz ? parseInt(pgSz.getAttributeNS(W, "w") || "11906", 10) : 11906;
      let oh = pgSz ? parseInt(pgSz.getAttributeNS(W, "h") || "16838", 10) : 16838;
      const orient = pgSz ? pgSz.getAttributeNS(W, "orient") : "";
      const wasLandscape = orient === "landscape" || ow > oh;
      // Se respeta el tamaño, la orientación y los márgenes del documento original
      const nw = ow;
      const nh = oh;
      const num = (n, d) => {
        const v = pgMar ? parseInt(pgMar.getAttributeNS(W, n) || "", 10) : NaN;
        return Number.isFinite(v) ? v : d;
      };
      const m = {
        top: num("top", 1134),
        right: num("right", 1134),
        bottom: num("bottom", 1134),
        left: num("left", 1134),
        header: num("header", 567),
        footer: num("footer", 567),
      };
      // Solo si el margen deja una columna imposible de leer se avisa y se corrige
      if (nw - m.left - m.right < 4000) {
        this.warn("Un documento tenía unos márgenes que dejaban casi sin espacio útil; se han reducido.");
        m.left = Math.min(m.left, 1000);
        m.right = Math.min(m.right, 1000);
      }
      const textW = nw - m.left - m.right;
      const colsEl = old ? firstChild(old, "cols") : null;
      const cols = colsEl ? ser(colsEl) : "";

      // Tipo de sección: la primera sección del documento arranca en página nueva
      let type = idx === 0 ? "nextPage" : wval(old ? firstChild(old, "type") : null) || "nextPage";
      const sectXml = this._sectXml({ w: nw, h: nh, m, type, cols, landscape: wasLandscape });

      // Sustituir el sectPr
      const newSect = parseXml(
        `<root xmlns:w="${W}" xmlns:r="${R}">${sectXml}</root>`
      ).documentElement.firstChild;
      const imported = doc.importNode(newSect, true);
      if (g.final) {
        // el último grupo no tenía sectPr propio: se aloja en el último párrafo
        const ppr = this._ensurePPr(g.inPara);
        ppr.appendChild(imported);
        if (finalSect) removeNode(finalSect);
      } else {
        removeNode(old);
        const ppr = this._ensurePPr(g.inPara);
        ppr.appendChild(imported);
      }

      this._fitToWidth(g.elements, textW, null);
    });
    if (finalSect && finalSect.parentNode) removeNode(finalSect);
  }

  _ensurePPr(p) {
    let ppr = firstChild(p, "pPr");
    if (!ppr) {
      ppr = p.ownerDocument.createElementNS(W, "w:pPr");
      p.insertBefore(ppr, p.firstChild);
    }
    // el sectPr debe ir al final del pPr, pero antes de pPrChange si existiera
    return ppr;
  }

  _sectXml({ w, h, m, type, cols, landscape }) {
    return (
      `<w:sectPr>` +
      `<w:headerReference w:type="default" r:id="rIdPlHdr"/>` +
      `<w:footerReference w:type="default" r:id="rIdPlFtr"/>` +
      `<w:type w:val="${type}"/>` +
      `<w:pgSz w:w="${w}" w:h="${h}"${landscape ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="${m.header}" w:footer="${m.footer}" w:gutter="0"/>` +
      cols +
      `</w:sectPr>`
    );
  }

  /**
   * Reduce proporcionalmente las tablas e imágenes que no caben en el ancho
   * útil de la página vertical.
   * @param {Element[]} elements elementos de la sección
   * @param {number} textW ancho útil nuevo (twips)
   * @param {number|null} origTextW ancho útil original si era apaisada
   */
  _fitToWidth(elements, textW, origTextW) {
    for (const el of elements) {
      const tables = el.localName === "tbl" ? [el] : [];
      for (const t of tables) this._scaleTable(t, textW, esTablaMaterial(t));
      // imágenes incrustadas y flotantes
      for (const ext of els(el, "extent", NS.wp)) {
        const cx = parseInt(ext.getAttribute("cx") || "0", 10);
        const cy = parseInt(ext.getAttribute("cy") || "0", 10);
        const maxEmu = textW * 635;
        if (cx > maxEmu && cx > 0) {
          const f = maxEmu / cx;
          this._scaleExtent(ext, f);
          this.stats.imagesScaled++;
        }
      }
      // elementos flotantes de una página apaisada: escalar posición
      if (origTextW) {
        const f = Math.min(1, textW / origTextW);
        if (f < 0.999) {
          for (const off of els(el, "posOffset", NS.wp)) {
            const v = parseInt(off.textContent || "0", 10);
            if (Number.isFinite(v)) off.textContent = String(Math.round(v * f));
          }
          for (const anchor of els(el, "anchor", NS.wp)) {
            const ext = firstChild(anchor, "extent", NS.wp);
            if (ext) this._scaleExtent(ext, f);
          }
        }
      }
    }
  }

  _scaleExtent(ext, f) {
    const cx = parseInt(ext.getAttribute("cx") || "0", 10);
    const cy = parseInt(ext.getAttribute("cy") || "0", 10);
    ext.setAttribute("cx", String(Math.round(cx * f)));
    ext.setAttribute("cy", String(Math.round(cy * f)));
    // Contenedor <wp:inline> / <wp:anchor> → ajustar a:ext dentro de pic:spPr
    const container = ext.parentNode;
    for (const a of els(container, "ext", NS.a)) {
      const acx = parseInt(a.getAttribute("cx") || "0", 10);
      const acy = parseInt(a.getAttribute("cy") || "0", 10);
      if (acx) a.setAttribute("cx", String(Math.round(acx * f)));
      if (acy) a.setAttribute("cy", String(Math.round(acy * f)));
    }
  }

  _scaleTable(tbl, textW, ancho = false) {
    const grid = firstChild(tbl, "tblGrid");
    if (!grid) return;
    // cambios de rejilla pendientes (revisiones): se descartan, la rejilla vigente es la que cuenta
    for (const ch of childEls(grid, "tblGridChange")) grid.removeChild(ch);
    // Algunos exportadores (Google Docs) duplican la rejilla: sobran columnas que ninguna fila usa
    {
      const todas = childEls(grid, "gridCol");
      let maxCol = 0;
      let desplazada = false;
      for (const tr of childEls(tbl, "tr")) {
        let n = 0;
        if (els(tr, "gridBefore").length || els(tr, "gridAfter").length) desplazada = true;
        for (const tc of childEls(tr, "tc")) {
          const tcp = firstChild(tc, "tcPr");
          const gs = tcp ? firstChild(tcp, "gridSpan") : null;
          n += gs ? parseInt(gs.getAttributeNS(W, "val") || "1", 10) || 1 : 1;
        }
        maxCol = Math.max(maxCol, n);
      }
      if (!desplazada && maxCol > 0 && todas.length > maxCol) for (const c of todas.slice(maxCol)) grid.removeChild(c);
    }
    const cols = childEls(grid, "gridCol");
    const widths = cols.map((c) => parseInt(c.getAttributeNS(W, "w") || "0", 10));
    const total = widths.reduce((a, b) => a + b, 0);
    const tpr = firstChild(tbl, "tblPr");
    const ind = tpr ? firstChild(tpr, "tblInd") : null;
    const indW = ind ? parseInt(ind.getAttributeNS(W, "w") || "0", 10) : 0;
    if (!total) return;
    if (!ancho && total + Math.max(indW, 0) <= textW) return;
    // tablas de material: todo el ancho útil, pegadas al margen izquierdo
    const f = ancho ? textW / total : (textW - Math.max(indW, 0) * 0) / (total + Math.max(indW, 0));
    cols.forEach((c, i) => c.setAttributeNS(W, "w:w", String(Math.max(1, Math.round(widths[i] * f)))));
    for (const tc of els(tbl, "tcW")) {
      const type = tc.getAttributeNS(W, "type");
      const v = parseInt(tc.getAttributeNS(W, "w") || "0", 10);
      if ((type === "dxa" || !type) && v) tc.setAttributeNS(W, "w:w", String(Math.max(1, Math.round(v * f))));
    }
    if (tpr) {
      const tw = firstChild(tpr, "tblW");
      if (tw && (tw.getAttributeNS(W, "type") === "dxa" || !tw.getAttributeNS(W, "type"))) {
        tw.setAttributeNS(W, "w:w", String(Math.round(total * f)));
      }
      if (ind) ind.setAttributeNS(W, "w:w", ancho ? "0" : String(Math.round(indW * f)));
    }
    this.stats.tablesScaled++;
  }

  // ───────────────────────── Empaquetado ─────────────────────────

  _headerXml() {
    // Texto a izquierda y derecha como en el planning de referencia
    // (Calibri 10). Una tabla al 100 % se adapta a cualquier ancho de página.
    const left = `CSP ${this.year}`.trim();
    const right = this.tema || "";
    const cellP = (txt, align) =>
      `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="${align}"/></w:pPr>` +
      run(txt, { size: 10, font: "Calibri" }) +
      `</w:p>`;
    const tc = (txt, align) => `<w:tc><w:tcPr><w:tcW w:w="2500" w:type="pct"/></w:tcPr>${cellP(txt, align)}</w:tc>`;
    const tbl =
      `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/>` +
      `<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
      `<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr>${tc(left, "left")}${tc(right, "right")}</w:tr></w:tbl>`;
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:hdr xmlns:w="${W}" xmlns:r="${R}">${tbl}<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p></w:hdr>`
    );
  }

  _footerXml() {
    const fld = (code) =>
      `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/></w:rPr><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:ftr xmlns:w="${W}" xmlns:r="${R}">` +
      para(fld("PAGE"), { align: "right", after: 0 }) +
      `</w:ftr>`
    );
  }

  /** Genera el .docx final */
  async build() {
    const zip = new JSZip();
    const nsDecl = Object.entries(this.prefixes)
      .map(([p, u]) => `xmlns:${p}="${u}"`)
      .join(" ");
    // La última sección del planning se declara al final del cuerpo (así no queda una
    // página en blanco detrás): se toma el sectPr del último párrafo.
    const chunks = [...this.chunks];
    let finalSect = null;
    if (chunks.length) {
      const lastChunk = chunks[chunks.length - 1];
      const i = lastChunk.lastIndexOf("<w:sectPr");
      if (i >= 0) {
        const j = lastChunk.indexOf("</w:sectPr>", i) + "</w:sectPr>".length;
        const tail = lastChunk.slice(j);
        const m = /^<\/w:pPr>((?:<w:r[ >][\s\S]*?<\/w:r>|<w:bookmark[^>]*\/>)*)<\/w:p>$/.exec(tail);
        if (m) {
          finalSect = lastChunk.slice(i, j);
          chunks[chunks.length - 1] = lastChunk.slice(0, i) + tail;
        }
      }
    }
    const documentXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document ${nsDecl}><w:body>${chunks.join("")}` +
      (finalSect || this.sectPrXml({ type: null })) +
      `</w:body></w:document>`;

    const baseStyles =
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
      `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>` +
      `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/>` +
      `<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="PlTitulo"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="46"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="PlIndice"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="PlDia"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="44"/><w:szCs w:val="44"/><w:u w:val="single"/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="PlTexto"><w:name w:val="PlTexto"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>`;

    const stylesXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:eastAsia="Calibri Light" w:cs="Calibri Light"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl w:val="0"/></w:pPr></w:pPrDefault></w:docDefaults>` +
      baseStyles +
      this.styles.join("") +
      `</w:styles>`;

    const numberingXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:numbering xmlns:w="${W}">${this.abstractNums.join("")}${this.nums.join("")}</w:numbering>`;

    const settingsXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/><w:updateFields w:val="true"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

    const exts = new Set(["rels", "xml"]);
    const defaults = [
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
      `<Default Extension="xml" ContentType="application/xml"/>`,
    ];
    for (const name of this.media.keys()) {
      const ext = name.split(".").pop().toLowerCase();
      if (!exts.has(ext) && mimeFor(ext)) {
        exts.add(ext);
        defaults.push(`<Default Extension="${ext}" ContentType="${mimeFor(ext)}"/>`);
      }
    }
    const ct =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      defaults.join("") +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
      `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
      `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
      `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
      `</Types>`;

    const docRels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">` +
      `<Relationship Id="rIdStyles" Type="${REL_TYPE}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rIdNumbering" Type="${REL_TYPE}/numbering" Target="numbering.xml"/>` +
      `<Relationship Id="rIdSettings" Type="${REL_TYPE}/settings" Target="settings.xml"/>` +
      `<Relationship Id="rIdPlHdr" Type="${REL_TYPE}/header" Target="header1.xml"/>` +
      `<Relationship Id="rIdPlFtr" Type="${REL_TYPE}/footer" Target="footer1.xml"/>` +
      this.extraRels.join("") +
      `</Relationships>`;

    zip.file("[Content_Types].xml", ct, NOFOLDERS);
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      NOFOLDERS
    );
    zip.file("word/document.xml", documentXml, NOFOLDERS);
    zip.file("word/_rels/document.xml.rels", docRels, NOFOLDERS);
    zip.file("word/styles.xml", stylesXml, NOFOLDERS);
    zip.file("word/numbering.xml", numberingXml, NOFOLDERS);
    zip.file("word/settings.xml", settingsXml, NOFOLDERS);
    zip.file("word/header1.xml", this._headerXml(), NOFOLDERS);
    zip.file("word/footer1.xml", this._footerXml(), NOFOLDERS);
    for (const [name, buf] of this.media) {
      zip.file(`word/media/${name}`, buf, { createFolders: false, compression: /\.(png|jpe?g|gif)$/i.test(name) ? "STORE" : "DEFLATE" });
    }
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  }
}

module.exports = { PlanningBuilder, parseXml, els, childEls, firstChild, ser, normalizaFuentes, esTablaMaterial };
