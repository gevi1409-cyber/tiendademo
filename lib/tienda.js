/*
 * Lógica de la tienda demo, SIN estado en memoria: corre igual en local (server.js) y en Vercel (api/*).
 *
 * Es lo que haría el BACKEND de un comercio:
 *   1. Arma el pedido con precios del catálogo del servidor (nunca los que manda el navegador).
 *   2. Pide la sesión a Alpha con la key checkout del MID (X-Api-Key) — la key NUNCA sale de aquí.
 *   3. Devuelve al navegador sólo el bloque `embedding` + un token FIRMADO del pedido.
 *   4. Confirma el pago consultando la sesión en Alpha; el `result` del iframe es sólo un aviso.
 *
 * Como en Vercel cada petición puede caer en una instancia distinta, el pedido viaja en un token HMAC
 * (folio, total, sesión) en lugar de guardarse en memoria. Un comercio real lo tendría en su base.
 */
"use strict";

const crypto = require("node:crypto");

function cfg() {
  const env = process.env;
  const c = {
    modo: (env.MODO || "mock").trim().toLowerCase(), // mock | alpha
    // Origen EXACTO con el que el navegador abre la tienda = `parentOrigin` de la sesión. Registrado en la CA.
    origen: (env.TIENDA_ORIGEN || "").trim().replace(/\/+$/, ""),
    alphaApi: (env.ALPHA_API_URL || "").trim().replace(/\/+$/, ""),
    alphaKey: (env.ALPHA_CHECKOUT_KEY || "").trim(),
    sdkUrl: (env.ALPHA_CHECKOUT_JS || "").trim(),
    moneda: (env.MONEDA || "MXN").trim().toUpperCase(),
    vigenciaMin: Math.min(Math.max(Number(env.VIGENCIA_MIN || 30), 5), 1440),
    secreto: (env.TIENDA_SECRETO || "").trim(),
  };
  if (!c.sdkUrl && c.alphaApi) c.sdkUrl = c.alphaApi + "/alpha-checkout.js";
  return c;
}

/** Faltantes de configuración para MODO=alpha (vacío = ok). */
function faltantes(c, origenPeticion) {
  if (c.modo !== "alpha") return [];
  const f = [];
  if (!c.alphaApi) f.push("ALPHA_API_URL");
  if (!c.alphaKey) f.push("ALPHA_CHECKOUT_KEY");
  if (!c.secreto) f.push("TIENDA_SECRETO");
  const o = c.origen || origenPeticion || "";
  if (!o.startsWith("https://")) f.push("TIENDA_ORIGEN https://");
  return f;
}

// ── Catálogo (la fuente de verdad del precio es el servidor) ─────────────────────
const CATALOGO = [
  { sku: "CAFE-250", nombre: "Café de Chiapas 250 g", precioMinor: 18900, emoji: "☕" },
  { sku: "TAZA-01", nombre: "Taza de cerámica", precioMinor: 14500, emoji: "🍵" },
  { sku: "PREN-FR", nombre: "Prensa francesa 600 ml", precioMinor: 42000, emoji: "🫖" },
  { sku: "PRUEBA-1", nombre: "Artículo de prueba $1.00", precioMinor: 100, emoji: "🧪" },
];
const PORSKU = new Map(CATALOGO.map((p) => [p.sku, p]));

// Estados de sesión de Alpha. Ajustar con la guía del MID si el catálogo difiere.
const PAGADO = new Set(["paid", "completed", "succeeded", "approved", "captured"]);
const CERRADO = new Set(["expired", "canceled", "cancelled", "failed", "declined"]);

// ── Token firmado del pedido ───────────────────────────────────────────────────
function llave(c) {
  // En mock sin secreto se usa una llave fija: el mock no cobra nada.
  return crypto.createHash("sha256").update("tienda-demo|" + (c.secreto || "mock-sin-secreto")).digest();
}
function firmar(c, datos) {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString("base64url");
  const mac = crypto.createHmac("sha256", llave(c)).update(cuerpo).digest("base64url");
  return cuerpo + "." + mac;
}
function abrir(c, token) {
  const [cuerpo, mac] = String(token || "").split(".");
  if (!cuerpo || !mac) return null;
  const esperado = crypto.createHmac("sha256", llave(c)).update(cuerpo).digest();
  const dado = Buffer.from(mac, "base64url");
  if (dado.length !== esperado.length || !crypto.timingSafeEqual(dado, esperado)) return null;
  try { return JSON.parse(Buffer.from(cuerpo, "base64url").toString()); } catch { return null; }
}

// ── Alpha ──────────────────────────────────────────────────────────────────────
async function alpha(c, metodo, ruta, cuerpo, idempotencia) {
  const headers = { "X-Api-Key": c.alphaKey, Accept: "application/json", "X-Correlation-Id": crypto.randomUUID() };
  if (cuerpo) headers["Content-Type"] = "application/json";
  if (idempotencia) headers["Idempotency-Key"] = idempotencia;
  const r = await fetch(c.alphaApi + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const texto = await r.text();
  let j = null;
  try { j = texto ? JSON.parse(texto) : {}; } catch { /* no JSON */ }
  return { http: r.status, j };
}

/** Busca (en profundidad ≤ 4) el primer objeto que parezca el bloque embedding: trae iframeUrl y nonce. */
function buscarEmbedding(o, prof = 0) {
  if (!o || typeof o !== "object" || prof > 4) return null;
  if (typeof o.iframeUrl === "string" && typeof o.nonce === "string") return o;
  for (const v of Object.values(o)) {
    const r = buscarEmbedding(v, prof + 1);
    if (r) return r;
  }
  return null;
}

/** Saca embedding/id/estado de la respuesta, venga plana, en `session`, en `data` o en `checkoutSession`. */
function leerSesion(j) {
  const raiz = j || {};
  const s = raiz.session || raiz.checkoutSession || raiz.data || raiz;
  const embedding = s.embedding || raiz.embedding || buscarEmbedding(raiz);
  return {
    id: s.id || s.sessionId || s.checkoutSessionId || raiz.sessionId || raiz.id || (embedding && embedding.sessionId) || "",
    reference: s.reference || s.alphaReference || raiz.reference || raiz.alphaReference || "",
    estado: String(s.status || s.paymentStatus || raiz.status || "").toLowerCase(),
    embedding: embedding || null,
  };
}

/** Estructura de una respuesta SIN valores (sólo nombres de campos y tipos), para diagnosticar sin filtrar datos. */
function forma(o, prof = 0) {
  if (o === null) return "null";
  if (Array.isArray(o)) return prof > 3 ? "[…]" : "[" + (o.length ? forma(o[0], prof + 1) : "") + "]";
  if (typeof o !== "object") return typeof o;
  if (prof > 3) return "{…}";
  return "{" + Object.keys(o).map((k) => k + ":" + forma(o[k], prof + 1)).join(", ") + "}";
}

/** Código de error de Alpha sin filtrar nada sensible. */
function errorAlpha(r) {
  const j = r.j || {};
  return { http: r.http, code: j.code || j.error || "sin_codigo", mensaje: j.message || j.detail || j.title || "" };
}

// ── Casos de uso (los llaman server.js y api/*) ──────────────────────────────────
function configPublica(c) {
  return { modo: c.modo, moneda: c.moneda, sdkUrl: c.modo === "mock" ? "/mock-alpha-checkout.js" : c.sdkUrl, catalogo: CATALOGO };
}

/** POST /api/pedidos → { status, body } */
async function crearPedido(c, body, origenPeticion) {
  const falta = faltantes(c, origenPeticion);
  if (falta.length) return { status: 500, body: { error: "Configuración incompleta: " + falta.join(", ") } };
  const origen = c.origen || origenPeticion;

  const lineas = [];
  for (const it of Array.isArray(body && body.items) ? body.items : []) {
    const prod = PORSKU.get(String(it.sku || ""));
    const cant = Math.trunc(Number(it.cantidad));
    if (!prod || !(cant >= 1 && cant <= 20)) continue;
    lineas.push({ sku: prod.sku, nombre: prod.nombre, cantidad: cant, precioMinor: prod.precioMinor, importeMinor: prod.precioMinor * cant });
  }
  if (!lineas.length) return { status: 422, body: { error: "El carrito está vacío" } };
  const totalMinor = lineas.reduce((s, l) => s + l.importeMinor, 0);
  const pedidoId = crypto.randomUUID();
  const folio = "TD-" + Date.now().toString(36).toUpperCase();

  let sesionId, embedding, referencia = "";
  if (c.modo === "mock") {
    sesionId = "mock_" + crypto.randomBytes(6).toString("hex");
    embedding = {
      sessionId: sesionId,
      nonce: crypto.randomBytes(16).toString("base64url"),
      iframeUrl: `${origen}/mock-checkout.html?session=${sesionId}&monto=${totalMinor}&moneda=${c.moneda}`,
      checkoutOrigin: origen,
      parentOrigin: origen,
      protocol: "alpha.checkout.v1",
    };
  } else {
    const sesion = {
      amountMinor: totalMinor,
      currency: c.moneda,
      description: `Pedido ${folio}`,
      externalReference: folio,
      expiresAt: new Date(Date.now() + c.vigenciaMin * 60_000).toISOString(), // siempre
      uiMode: "embedded",
      parentOrigin: origen,
      successUrl: `${origen}/`,
      cancelUrl: `${origen}/`,
      // Sin terminalId / mcc / routes: Alpha administra la terminal virtual del MID y enruta por BIN.
    };
    let r;
    try { r = await alpha(c, "POST", "/api/v1/checkout-sessions", sesion, `tienda-${pedidoId}`); } catch (e) {
      return { status: 502, body: { error: "No se pudo contactar a Alpha", detalle: e.message } };
    }
    if (r.http === 202) return { status: 502, body: { error: "Alpha respondió 202 (pendiente); reintenta", alpha: { http: 202, code: "pending" } } };
    if (r.http < 200 || r.http >= 300) {
      console.warn("[tienda] Alpha rechazó la sesión:", JSON.stringify(errorAlpha(r)));
      return { status: 502, body: { error: "Alpha no creó la sesión", alpha: errorAlpha(r) } };
    }
    const s = leerSesion(r.j);
    sesionId = s.id;
    referencia = s.reference;
    embedding = s.embedding;
    if (!embedding && sesionId) {
      // Si la creación no trae embedding, se recupera con GET (lo devuelve con la key del MID).
      const g = await alpha(c, "GET", "/api/v1/checkout-sessions/" + encodeURIComponent(sesionId));
      const gs = leerSesion(g.j);
      embedding = gs.embedding;
      referencia = referencia || gs.reference;
    }
    if (!sesionId || !embedding) {
      const f = forma(r.j);
      console.warn("[tienda] respuesta de Alpha sin id/embedding reconocible. Forma:", f);
      return { status: 502, body: { error: "Alpha no devolvió el bloque embedding", alpha: { http: r.http, code: "sin_embedding", mensaje: "forma: " + f } } };
    }
  }

  const token = firmar(c, { s: sesionId, f: folio, t: totalMinor });
  console.log(`[tienda] pedido ${folio} ${totalMinor} ${c.moneda} → sesión ${sesionId}`);
  return {
    status: 201,
    // `sesion` va TAL CUAL a AlphaCheckout.mount({ session }): el SDK valida id === embedding.sessionId y, con
    // reference, que iframeUrl sea /checkout/embedded/{reference}.
    body: {
      pedido: { token, folio, totalMinor, moneda: c.moneda, lineas, estado: "pendiente" },
      sesion: referencia ? { id: sesionId, reference: referencia, embedding } : { id: sesionId, embedding },
    },
  };
}

/** GET /api/pedidos/{token} → { status, body }. En mock, `estadoMock` lo manda el simulador. */
async function confirmarPedido(c, token, estadoMock) {
  const p = abrir(c, token);
  if (!p) return { status: 404, body: { error: "Pedido no encontrado" } };
  const base = { token, folio: p.f, totalMinor: p.t, moneda: c.moneda };

  let estadoAlpha;
  if (c.modo === "mock") {
    estadoAlpha = estadoMock === "paid" ? "paid" : estadoMock === "canceled" ? "canceled" : "open";
  } else {
    let r;
    try { r = await alpha(c, "GET", "/api/v1/checkout-sessions/" + encodeURIComponent(p.s)); } catch (e) {
      return { status: 502, body: { error: "No se pudo contactar a Alpha", pedido: { ...base, estado: "pendiente" } } };
    }
    if (r.http < 200 || r.http >= 300) return { status: 502, body: { error: "No se pudo confirmar con Alpha", alpha: errorAlpha(r), pedido: { ...base, estado: "pendiente" } } };
    estadoAlpha = leerSesion(r.j).estado || "desconocido";
  }
  const estado = PAGADO.has(estadoAlpha) ? "pagado" : CERRADO.has(estadoAlpha) ? "sin_pago" : "pendiente";
  return { status: 200, body: { pedido: { ...base, estado, estadoAlpha } } };
}

/** Origen visto por el servidor (respaldo si no hay TIENDA_ORIGEN). */
function origenDe(req) {
  const proto = String(req.headers["x-forwarded-proto"] || (req.socket && req.socket.encrypted ? "https" : "http")).split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

module.exports = { cfg, configPublica, crearPedido, confirmarPedido, origenDe };
