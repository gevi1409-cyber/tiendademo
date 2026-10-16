/* SIMULADOR del SDK de Alpha (sólo MODO=mock). Misma forma que el alpha-checkout.js real:
   AlphaCheckout.mount({ container, session: { id, embedding }, onEvent }) → { iframe, cancel(), destroy() }.
   NO es el SDK real: en MODO=alpha se carga el alpha-checkout.js publicado por Alpha. */
(function () {
  window.AlphaCheckout = {
    mount({ container, session, onEvent = function () {} }) {
      const el = typeof container === "string" ? document.querySelector(container) : container;
      const e = session.embedding;
      const f = document.createElement("iframe");
      f.src = e.iframeUrl;
      f.title = "Checkout (simulado)";
      el.innerHTML = "";
      el.appendChild(f);
      const escucha = (ev) => {
        const d = ev.data || {};
        if (ev.source !== f.contentWindow || ev.origin !== e.checkoutOrigin) return;
        if (d.protocol !== "alpha.checkout.v1" || d.sessionId !== session.id) return;
        onEvent(d);
      };
      window.addEventListener("message", escucha);
      return {
        iframe: f,
        cancel() { onEvent({ type: "cancel", sessionId: session.id }); },
        destroy() { window.removeEventListener("message", escucha); f.remove(); },
      };
    },
  };
})();
