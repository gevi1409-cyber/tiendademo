/* SIMULADOR del SDK de Alpha (sólo MODO=mock). Imita la forma de AlphaCheckout.mount para trabajar la tienda sin
   credenciales. NO es el SDK real: en MODO=alpha se carga el alpha-checkout.js publicado por Alpha. */
(function () {
  window.AlphaCheckout = {
    mount(contenedor, opciones) {
      const f = document.createElement("iframe");
      f.src = opciones.iframeUrl + "&nonce=" + encodeURIComponent(opciones.nonce || "");
      f.title = "Checkout (simulado)";
      contenedor.innerHTML = "";
      contenedor.appendChild(f);
      return { unmount() { f.remove(); } };
    },
  };
})();
