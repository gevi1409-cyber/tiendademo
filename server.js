/*
 * Servidor LOCAL de la tienda demo (en Vercel no se usa: allá corren las funciones de api/ y los estáticos de public/).
 * Misma lógica que en Vercel (lib/tienda.js). Sin dependencias: Node 20+.
 *   npm run mock   → simulado, http://localhost:5443
 *   npm start      → lee .env (MODO=alpha necesita https: HTTPS_CERT/HTTPS_KEY o un túnel)
 */
"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const t = require("./lib/tienda");

const PUERTO = Number(process.env.PUERTO || 5443);
const CERT = (process.env.HTTPS_CERT || "").trim();
const KEY = (process.env.HTTPS_KEY || "").trim();
const usaHttps = !!(CERT && KEY);
if (!process.env.TIENDA_ORIGEN) process.env.TIENDA_ORIGEN = `${usaHttps ? "https" : "http"}://localhost:${PUERTO}`;

const c = t.cfg();
if (c.modo === "alpha" && !c.secreto) {
  // En local basta un secreto aleatorio por arranque (los pedidos viejos dejan de abrir al reiniciar).
  process.env.TIENDA_SECRETO = require("node:crypto").randomBytes(32).toString("hex");
}

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const PUBLICO = path.join(__dirname, "public");

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function leerJson(req, max = 64 * 1024) {
  return new Promise((ok, ko) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > max) { ko(new Error("cuerpo muy grande")); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ko(new Error("JSON inválido")); } });
    req.on("error", ko);
  });
}

function estatico(res, ruta) {
  const rel = ruta === "/" ? "/index.html" : ruta;
  const f = path.normalize(path.join(PUBLICO, rel));
  if (!f.startsWith(PUBLICO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": TIPOS[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(f).pipe(res);
  return true;
}

async function rutas(req, res) {
  const cfg = t.cfg();
  const url = new URL(req.url, "http://local");
  const ruta = url.pathname;

  if (req.method === "GET" && ruta === "/api/config") return json(res, 200, t.configPublica(cfg));

  if (req.method === "POST" && ruta === "/api/pedidos") {
    let b;
    try { b = await leerJson(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const r = await t.crearPedido(cfg, b, t.origenDe(req));
    return json(res, r.status, r.body);
  }

  const m = ruta.match(/^\/api\/pedidos\/([A-Za-z0-9_.-]+)$/);
  if (req.method === "GET" && m) {
    const r = await t.confirmarPedido(cfg, m[1], url.searchParams.get("mock"));
    return json(res, r.status, r.body);
  }

  if (req.method === "GET" && estatico(res, ruta)) return;
  json(res, 404, { error: "No encontrado" });
}

const manejador = (req, res) => rutas(req, res).catch((e) => {
  console.error("[tienda] error:", e);
  if (!res.headersSent) json(res, 500, { error: "Error interno" });
});

const server = usaHttps
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, manejador)
  : http.createServer(manejador);

server.listen(PUERTO, () => {
  const cf = t.cfg();
  console.log(`[tienda] ${cf.modo.toUpperCase()} · ${cf.origen}`);
  if (cf.modo === "alpha") console.log(`[tienda] Alpha: ${cf.alphaApi} · SDK: ${cf.sdkUrl} · parentOrigin: ${cf.origen}`);
});
