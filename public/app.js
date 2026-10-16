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
    vista("pago");
    estado.desmontar = montarCheckout($("checkout"), j.sesion, alEvento);
  } catch (e) {
    mostrarError(e.message);
  } finally {
    $("pagar").textContent = "Pagar";
    $("pagar").disabled = !estado.carrito.size;
  }
}

/** El evento del iframe NO es comprobante: sólo dispara la confirmación en el backend. */
async function alEvento(tipo, datos) {
  console.log("[checkout]", tipo, datos);
  if (estado.cerrado) return;
  if (tipo === "processing") return mostrarAviso("Procesando el pago…");
  if (tipo === "result") return confirmar(estado.cfg.modo === "mock" ? "paid" : "");
  if (tipo === "cancel" || tipo === "expired" || tipo === "error") {
    estado.cerrado = true;
    const textos = { cancel: "Cancelaste el pago.", expired: "La sesión de pago venció.", error: "El checkout reportó un error" + (datos && datos.code ? ` (${datos.code})` : "") + "." };
    return terminar(false, "Pago no completado", textos[tipo] + " Puedes intentarlo de nuevo.");
  }
}

function mostrarAviso(texto) {
  $("folio").textContent = (estado.pedido ? `Pedido ${estado.pedido.folio} · ${dinero(estado.pedido.totalMinor, estado.pedido.moneda)}` : "") + (texto ? " — " + texto : "");
}

/**
 * Confirma contra el backend (que pregunta a Alpha). Si Alpha aún no da un estado final (p. ej. un intento rechazado
 * con la sesión todavía abierta), el formulario sigue montado para reintentar. `mock` sólo lo usa el simulador.
 */
async function confirmar(mock) {
  estado.cerrado = true;
  mostrarAviso("Confirmando con Alpha…");
  const url = "/api/pedidos/" + encodeURIComponent(estado.pedido.token) + (mock ? "?mock=" + mock : "");
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url).then((x) => x.json()).catch(() => null);
    const p = r && r.pedido;
    if (p && p.estado === "pagado") return terminar(true, "¡Pago confirmado!", `Pedido ${p.folio} pagado (${dinero(p.totalMinor, p.moneda)}).`);
    if (p && p.estado === "sin_pago") return terminar(false, "Pago no completado", `Alpha reporta: ${p.estadoAlpha}.`);
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  estado.cerrado = false;
  mostrarAviso("Alpha aún no confirma el pago; si fue rechazado, puedes reintentar en el formulario.");
}

function terminar(ok, titulo, texto) {
  if (estado.desmontar) { estado.desmontar(); estado.desmontar = null; }
  $("res-titulo").textContent = titulo;
  $("res-titulo").className = ok ? "ok" : "mal";
  $("res-texto").textContent = texto;
  if (ok) { estado.carrito.clear(); pintarCarrito(); }
  vista("resultado");
}

function volver() {
  if (estado.desmontar) { estado.desmontar(); estado.desmontar = null; }
  estado.cerrado = true;
  vista("carrito");
}

// ── Arranque ───────────────────────────────────────────────────────────────────
(async function () {
  estado.cfg = await fetch("/api/config").then((r) => r.json());
  const chip = $("modo");
  chip.textContent = estado.cfg.modo === "mock" ? "Simulado (sin Alpha)" : "Alpha sandbox";
  chip.className = "chip " + estado.cfg.modo;
  pintarCatalogo();
  pintarCarrito();
  $("pagar").onclick = pagar;
  $("volver").onclick = volver;
  $("otra").onclick = () => vista("carrito");
})();
