// services/plannings/pdfclient.js
//
// Convierte PDF → contenido editable en un proceso hijo con memoria limitada
// (pdfworker.js). Un PDF cada vez; si el proceso se cae o tarda demasiado se
// devuelve un error para ese documento y se arranca otro.

const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { convertPdf } = require("./pdflayout");

const TIMEOUT_MS = 180000;
let child = null;
let ready = null;
let seq = 0;
let chain = Promise.resolve();

function spawn() {
  const c = fork(path.join(__dirname, "pdfworker.js"), [], {
    execArgv: ["--max-old-space-size=170"],
    env: { ...process.env, MALLOC_ARENA_MAX: "2" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const pending = new Map();
  c.pending = pending;
  c.on("message", (m) => {
    if (m && m.ready) return c.emit("ready-msg");
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p.resolve(m); }
  });
  const die = (why) => {
    if (child === c) { child = null; ready = null; }
    for (const p of pending.values()) p.resolve({ ok: false, error: why });
    pending.clear();
  };
  c.on("exit", (code, sig) => die(code === 0 ? "reiniciado" : `el conversor de PDF se cerró (${sig || code}); probablemente por falta de memoria`));
  c.on("error", (e) => die(/EPIPE|ERR_IPC_CHANNEL_CLOSED|channel closed/i.test(String(e && (e.code || e.message))) ? "reiniciado" : `no se pudo arrancar el conversor de PDF: ${e.message}`));
  return c;
}

function get() {
  if (!child) {
    child = spawn();
    ready = new Promise((r) => child.once("ready-msg", r));
  }
  return { c: child, ready };
}

function rehydrate(model, dir, base) {
  const encs = new Map();
  const walk = (o) => {
    if (!o || typeof o !== "object") return o;
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) o[i] = walk(o[i]); return o; }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (k === "enc" && v && typeof v.eid === "number") {
        if (!encs.has(v.eid)) encs.set(v.eid, { buf: fs.readFileSync(`${base}.img${v.eid}`), ext: v.ext, w: v.w, h: v.h });
        o[k] = encs.get(v.eid);
      } else o[k] = walk(v);
    }
    return o;
  };
  return walk(model);
}

async function viaChild(buffer, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(6).toString("hex");
  const input = path.join(tmpDir, `in-${key}.pdf`);
  const outFile = path.join(tmpDir, `out-${key}.json`);
  fs.writeFileSync(input, buffer, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { c, ready: rd } = get();
      await rd;
      const id = ++seq;
      const res = await new Promise((resolve) => {
        const t = setTimeout(() => { c.pending.delete(id); try { c.kill("SIGKILL"); } catch (_) {} resolve({ ok: false, error: "la conversión del PDF ha tardado demasiado" }); }, TIMEOUT_MS);
        c.pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
        try { c.send({ id, input, outFile }); } catch (e) { clearTimeout(t); c.pending.delete(id); resolve({ ok: false, error: "reiniciado" }); }
      });
      if (!res.ok && (res.error === "reiniciado" || /^no se pudo arrancar/.test(res.error)) && attempt === 0) continue; // el proceso se había reciclado justo antes
      if (!res.ok) throw new Error(res.error);
      return rehydrate(JSON.parse(fs.readFileSync(outFile, "utf8")), tmpDir, outFile);
    }
    throw new Error("no se pudo convertir el PDF");
  } finally {
    for (const f of fs.readdirSync(tmpDir)) if (f.includes(key)) fs.rmSync(path.join(tmpDir, f), { force: true });
  }
}

/** PDF (Buffer) → modelo editable. Un solo PDF a la vez, en un proceso aparte con memoria limitada */
function convertPdfIsolated(buffer, tmpDir) {
  if (process.env.PLANNINGS_PDF_INPROCESS === "1") return convertPdf(buffer);
  const run = chain.then(() => viaChild(buffer, tmpDir));
  chain = run.catch(() => {});
  return run;
}

/** Cierra el proceso hijo (al terminar una generación) para devolver su memoria */
function stopConverter() {
  if (child) { try { child.kill(); } catch (_) {} child = null; ready = null; }
}

module.exports = { convertPdfIsolated, stopConverter };
