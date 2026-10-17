/* Front de la tienda demo. Nunca ve la key del MID: sólo recibe el bloque `embedding` del backend. */
"use strict";

const $ = (id) => document.getElementById(id);
const estado = { cfg: null, carrito: new Map(), pedido: null, desmontar: null, cerrado: false };

const dinero = (minor, moneda) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: moneda || "MXN" }).format(minor / 100);

function vista(nombre) {
  for (const v of ["carrito", "pago", "resultado"]) $("vista-" + v).hidden = v !== nombre;
}

// ── Catálogo y carrito ─────────────────────────────────────────────────────────
function pintarCatalogo() {
  const { catalogo, moneda } = estado.cfg;
  $("catalogo").innerHTML = "";
  for (const p of catalogo) {
    const d = document.createElement("div");
    d.className = "prod";
    d.innerHTML = `<div class="emoji"></div><div class="nombre"></div><div class="precio"></div>`;
    d.querySelector(".emoji").textContent = p.emoji;
    d.querySelector(".nombre").textContent = p.nombre;
    d.querySelector(".precio").textContent = dinero(p.precioMinor, moneda);
    const b = document.createElement("button");
    b.className = "sec";
    b.textContent = "Agregar";
    b.onclick = () => cambiar(p.sku, +1);
    d.appendChild(b);
    $("catalogo").appendChild(d);
  }
}

function cambiar(sku, delta) {
  const n = Math.max(0, Math.min(20, (estado.carrito.get(sku) || 0) + delta));
  if (n === 0) estado.carrito.delete(sku); else estado.carrito.set(sku, n);
  pintarCarrito();
}

function pintarCarrito() {
  const { catalogo, moneda } = estado.cfg;
  const ul = $("carrito");
  ul.innerHTML = "";
  let total = 0;
  for (const [sku, cant] of estado.carrito) {
    const p = catalogo.find((x) => x.sku === sku);
    total += p.precioMinor * cant;
    const li = document.createElement("li");
    li.innerHTML = `<span class="n"></span><span class="cant"><button>−</button><b></b><button>+</button></span><span class="i"></span>`;
    li.querySelector(".n").textContent = p.nombre;
    li.querySelector("b").textContent = cant;
    li.querySelector(".i").textContent = dinero(p.precioMinor * cant, moneda);
    const [menos, mas] = li.querySelectorAll("button");
    menos.onclick = () => cambiar(sku, -1);
    mas.onclick = () => cambiar(sku, +1);
    ul.appendChild(li);
  }
  if (!estado.carrito.size) ul.innerHTML = `<li class="vacio">Agrega productos para pagar.</li>`;
  $("total").textContent = dinero(total, moneda); // informativo: el total real lo calcula el servidor
  $("pagar").disabled = !estado.carrito.size;
}

function mostrarError(msg) {
  $("error").textContent = msg;
  $("error").hidden = !msg;
}

// ── SDK de Alpha ───────────────────────────────────────────────────────────────
function cargarSdk(url) {
  if (window.AlphaCheckout) return Promise.resolve();
  return new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => (window.AlphaCheckout ? ok() : ko(new Error("El script cargó pero no expuso AlphaCheckout")));
    s.onerror = () => ko(new Error("No se pudo cargar el SDK: " + url));
    document.head.appendChild(s);
  });
}

/**
 * SDK real de Alpha (alpha-checkout.js v1):
 *   AlphaCheckout.mount({ container, session: { id, embedding, reference? }, onEvent }) → { iframe, cancel(), destroy() }
 * El SDK valida el embedding (protocol, checkoutOrigin = origen del script, parentOrigin = este origen, nonce, sessionId)
 * y filtra el postMessage (origen, sessionId, nonce). Todos los eventos llegan a `onEvent`:
 * ready · resize · processing · result · cancel · expired · error (incluye error/embed_initialization_timeout a los 16 s).
 */
function montarCheckout(contenedor, sesion, alEvento) {
  const instancia = window.AlphaCheckout.mount({
    container: contenedor,
    session: sesion, // { id, embedding, reference? } tal cual lo devolvió el backend
    onEvent: (e) => e && e.type && alEvento(e.type, e),
  });
  return () => {
    try { instancia && typeof instancia.destroy === "function" && instancia.destroy(); } catch { /* nada */ }
    contenedor.innerHTML = "";
  };
}

// ── Flujo de pago ──────────────────────────────────────────────────────────────
//
// Reglas (spec Alpha): el evento del iframe NUNCA es comprobante. `result`, `cancel`, `expired` y `error` sólo
// disparan la consulta al backend de la tienda, que pregunta a Alpha (GET de la sesión con la key del MID). Lo que
// se le dice al comprador sale de esa respuesta:
//   pagado     → pantalla de éxito (folio, monto, tarjeta, autorización) y se vacía el carrito.
//   rechazado  → aviso en el mismo formulario: puede reintentar con otra tarjeta mientras la sesión siga abierta.
//   sin_pago   → pantalla de fallo con «Reintentar» (nueva sesión, mismo carrito) o volver al carrito.
//   pendiente  → «Estamos confirmando tu pago» con «Revisar de nuevo»; el carrito NO se vacía.
// Desde `processing` el pedido se guarda en sessionStorage: si el comprador recarga a media confirmación, se retoma.

const CLAVE_EN_CURSO = "tienda.pedidoEnCurso";
const guardar = (p) => { try { p ? sessionStorage.setItem(CLAVE_EN_CURSO, JSON.stringify(p)) : sessionStorage.removeItem(CLAVE_EN_CURSO); } catch { /* sin storage */ } };
const leerGuardado = () => { try { return JSON.parse(sessionStorage.getItem(CLAVE_EN_CURSO) || "null"); } catch { return null; } };

async function pagar() {
  mostrarError("");
  $("pagar").disabled = true;
  $("pagar").textContent = "Creando pago…";
  try {
    const items = [...estado.carrito].map(([sku, cantidad]) => ({ sku, cantidad }));
    const r = await fetch("/api/pedidos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    const j = await r.json();
    if (!r.ok) {
      const a = j.alpha ? `\nAlpha: HTTP ${j.alpha.http} · ${j.alpha.code}${j.alpha.mensaje ? " · " + j.alpha.mensaje : ""}` : "";
      throw new Error((j.error || "No se pudo crear el pago") + a);
    }
    estado.pedido = j.pedido;
    estado.cerrado = false;
    await cargarSdk(estado.cfg.sdkUrl);
    $("folio").textContent = `Pedido ${j.pedido.folio} · ${dinero(j.pedido.totalMinor, j.pedido.moneda)}`;
    aviso("");
    vista("pago");
    estado.desmontar = montarCheckout($("checkout"), j.sesion, alEvento);
  } catch (e) {
    mostrarError(e.message);
  } finally {
    $("pagar").textContent = "Pagar";
    $("pagar").disabled = !estado.carrito.size;
  }
}

/** Banda de estado sobre el formulario: tipo = info | mal. */
function aviso(texto, tipo = "info") {
  const el = $("aviso");
  el.textContent = texto || "";
  el.className = "aviso " + tipo;
  el.hidden = !texto;
}

async function alEvento(tipo, datos) {
  console.log("[checkout]", tipo, datos);
  if (estado.cerrado) return;
  const mock = estado.cfg.modo === "mock" ? (datos && datos.mockEstado) || "" : "";
  // Desde que el comprador envía la tarjeta, el pedido queda «en curso»: si recarga, se retoma la confirmación.
  if (tipo === "processing" || tipo === "result") {
    const p = estado.pedido;
    guardar({ token: p.token, folio: p.folio, totalMinor: p.totalMinor, moneda: p.moneda });
  }
  if (tipo === "processing") return aviso("Procesando tu pago… no cierres esta ventana.");
  if (tipo === "result") return confirmar({ mock, origen: "result" });
  if (tipo === "cancel" || tipo === "expired" || tipo === "error") {
    // Antes de decir «falló» se verifica: un cancel/error tardío no debe ocultar un cobro que sí ocurrió.
    return confirmar({ mock, origen: tipo, intentos: 2, codigo: datos && datos.code });
  }
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Consulta el pedido en el backend hasta tener un estado final. `origen` = evento que la disparó.
 * Reintenta ~30 s con espera creciente (Alpha puede tardar en reflejar el cobro tras 3DS).
 */
async function confirmar({ mock = "", origen = "result", intentos = 10, codigo = "" } = {}) {
  if (!estado.pedido) return;
  estado.cerrado = true;
  aviso("Confirmando tu pago con el banco…");
  const url = "/api/pedidos/" + encodeURIComponent(estado.pedido.token) + (mock ? "?mock=" + mock : "");
  let ultimo = null;
  for (let i = 0; i < intentos; i++) {
    const r = await fetch(url).then((x) => x.json()).catch(() => null);
    const p = r && r.pedido;
    if (p) ultimo = p;
    if (p && p.estado === "pagado") return exito(p);
    if (p && p.estado === "rechazado") return rechazo(p);
    if (p && p.estado === "sin_pago") return fallo(p, origen, codigo);
    await esperar(Math.min(1500 + i * 500, 4000));
  }
  // Sin estado final: si el evento fue cancel/expired/error, el comprador no pagó (o no terminó) → fallo.
  if (origen !== "result") return fallo(ultimo, origen, codigo);
  return pendiente(ultimo);
}

function detalleTarjeta(p) {
  const g = (p && p.pago) || {};
  const partes = [];
  if (g.marca || g.ultimos4) partes.push(`${g.marca || "Tarjeta"}${g.ultimos4 ? " •••• " + g.ultimos4 : ""}`);
  if (g.autorizacion) partes.push(`Autorización ${g.autorizacion}`);
  return partes.join(" · ");
}

function exito(p) {
  guardar(null);
  cerrarCheckout();
  estado.carrito.clear();
  pintarCarrito();
  resultado("ok", "¡Pago aprobado!", `Gracias por tu compra. Tu pedido ${p.folio} por ${dinero(p.totalMinor, p.moneda)} quedó pagado.`,
    detalleTarjeta(p), { otra: "Seguir comprando" });
}

function rechazo(p) {
  // La sesión puede seguir abierta: el comprador reintenta en el mismo formulario.
  estado.cerrado = false;
  const motivo = p.pago && p.pago.motivo ? ` (${p.pago.motivo})` : "";
  aviso(`Tu pago fue rechazado${motivo}. Puedes intentar con otra tarjeta.`, "mal");
}

function fallo(p, origen, codigo) {
  guardar(null);
  cerrarCheckout();
  const textos = {
    cancel: "Cancelaste el pago. No se hizo ningún cargo.",
    expired: "El tiempo para pagar se agotó. No se hizo ningún cargo.",
    error: "Hubo un problema con el formulario de pago" + (codigo ? ` (${codigo})` : "") + ". No se hizo ningún cargo.",
    result: "El pago no se completó" + (p && p.pago && p.pago.motivo ? `: ${p.pago.motivo}` : "") + ". No se hizo ningún cargo.",
  };
  resultado("mal", "Pago no completado", textos[origen] || textos.result, "", { reintentar: true, otra: "Volver al carrito" });
}

function pendiente(p) {
  cerrarCheckout();
  resultado("info", "Estamos confirmando tu pago",
    `Aún no recibimos la confirmación del banco para el pedido ${p ? p.folio : estado.pedido.folio}. No vuelvas a pagar: revisa en unos momentos.`,
    "", { revisar: true, otra: "Volver al carrito" });
}

function cerrarCheckout() {
  if (estado.desmontar) { estado.desmontar(); estado.desmontar = null; }
}

function resultado(tono, titulo, texto, detalle, botones) {
  $("res-titulo").textContent = titulo;
  $("res-titulo").className = tono;
  $("res-texto").textContent = texto;
  $("res-detalle").textContent = detalle || "";
  $("res-detalle").hidden = !detalle;
  $("reintentar").hidden = !botones.reintentar;
  $("revisar").hidden = !botones.revisar;
  $("otra").textContent = botones.otra || "Volver al carrito";
  vista("resultado");
}

function volver() {
  // Salir a media compra: el pedido abandonado se olvida (la sesión de Alpha vence sola).
  cerrarCheckout();
  estado.cerrado = true;
  guardar(null);
  vista("carrito");
}

// ── Arranque ───────────────────────────────────────────────────────────────────
(async function () {
  estado.cfg = await fetch("/api/config").then((r) => r.json());
  const chip = $("modo");
  const prod = estado.cfg.modo !== "mock" && estado.cfg.ambiente === "production";
  chip.textContent = estado.cfg.modo === "mock" ? "Simulado (sin Alpha)" : prod ? "Alpha PRODUCCIÓN · cobros reales" : "Alpha sandbox";
  chip.className = "chip " + estado.cfg.modo + (prod ? " prod" : "");
  pintarCatalogo();
  pintarCarrito();
  $("pagar").onclick = pagar;
  $("volver").onclick = volver;
  $("otra").onclick = () => vista("carrito");
  $("reintentar").onclick = () => { vista("carrito"); pagar(); };
  $("revisar").onclick = () => confirmar({ origen: "result", intentos: 3 });

  // ¿Quedó un pago a medio confirmar (recarga, pestaña cerrada tras 3DS…)? Se retoma.
  const previo = leerGuardado();
  if (previo && previo.token) {
    estado.pedido = previo;
    vista("resultado");
    resultado("info", "Revisando tu pago anterior…", `Pedido ${previo.folio}`, "", {});
    await confirmar({ origen: "result", intentos: 3 });
  }
})();
