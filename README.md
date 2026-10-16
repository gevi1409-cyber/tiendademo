# Tienda demo · checkout embebido de Alpha

Integración de referencia de un **comercio** con el checkout embebido de Alpha (`alpha.checkout.v1`).
Sirve para probar la cadena completa que la Central Admin habilita por MID y como ejemplo para entregar a los comercios. Esa cadena incluye la key checkout (CA-02), la guía (CA-03), los orígenes (CA-04) y, más adelante, el webhook (CA-05).

Sin dependencias: sólo Node 20.12+.

## Cómo funciona

```
Navegador (tienda)            Backend tienda (server.js)              Alpha
──────────────────            ──────────────────────────              ─────
carrito → POST /api/pedidos → arma el pedido con precios del servidor
                              POST /api/v1/checkout-sessions ───────► crea la sesión
                                X-Api-Key: key del MID (nunca sale)    (uiMode embedded,
                                Idempotency-Key: tienda-{pedido}        parentOrigin)
          ◄─ { embedding } ─── devuelve sólo el embedding ◄─────────── embedding
carga alpha-checkout.js
AlphaCheckout.mount(...)  ───────── iframe de Alpha (tarjeta + 3DS) ──►
postMessage result ─────► GET /api/pedidos/{id}
                              GET /api/v1/checkout-sessions/{id} ───► estado real
          ◄─ pagado / no ───── confirma (el postMessage NO es comprobante)
```

Reglas que respeta, tal como las pide la spec de Alpha:

- La key del MID sólo vive en el backend (`.env`). El navegador recibe nada más `sessionId`, `nonce`, `iframeUrl` y `checkoutOrigin`.
- Siempre manda `expiresAt`. No manda `terminalId`, `mcc` ni `routes`, porque Alpha enruta por BIN.
- El total lo calcula el servidor con su catálogo y no con lo que mande el navegador.
- El `result` del iframe sólo dispara la consulta; el pedido se marca pagado cuando Alpha lo confirma.
- Sólo acepta `postMessage` del `checkoutOrigin` de la sesión.

La firma de `AlphaCheckout.mount` está aislada en `montarCheckout()` (`public/app.js`). Si la guía del MID trae otros nombres, se ajusta ahí. Lo mismo aplica para los estados de sesión, definidos en `PAGADO` y `CERRADO` de `server.js`.

## Correr en local

### 1. Modo simulado (sin Alpha)

```powershell
cd alpha-connect-tienda-demo
npm run mock
```

Abre http://localhost:5443. El checkout es un iframe falso (`mock-checkout.html`) que imita el protocolo; sirve para trabajar la UI.

### 2. Modo Alpha (sandbox real)

**a) Certificado https local.** Alpha sólo acepta orígenes `https`. Con el openssl que trae Git for Windows:

```powershell
mkdir certs
& "C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -newkey rsa:2048 -nodes -days 365 `
  -keyout certs\localhost-key.pem -out certs\localhost.pem -subj "/CN=localhost" `
  -addext "subjectAltName=DNS:localhost"
```

El navegador va a advertir que el certificado no es de confianza: entra una vez a https://localhost:5443 y acéptalo.
Otra opción es usar `mkcert localhost` (sin advertencia) o un túnel (`cloudflared tunnel --url http://localhost:5443`). Con el túnel, `TIENDA_ORIGEN` es la URL `https://…trycloudflare.com` que te dé.

**b) En la Central Admin (dev), para el MID de prueba:**

1. Aplicar los paquetes `ops/sql/2026-10-15_checkout_integracion_mid` y `2026-10-15_checkout_origenes_mid`.
2. Emitir la key checkout del MID (CA-02) y copiarla.
3. Registrar el origen `https://localhost:5443` (o el del túnel) en los orígenes del MID (CA-04).
4. Usar un MID con el padrón completo: interfaz, cabecera, subafiliación, MCC y domicilio.
5. El MID **no** debe tener la política de creación `central_admin`. Si la tiene, Alpha manda la creación al coordinador de la CA, que todavía no existe (Fase B).

**c) `.env`:**

```powershell
copy .env.example .env
# editar: MODO=alpha, ALPHA_API_URL, ALPHA_CHECKOUT_KEY, ALPHA_CHECKOUT_JS (si difiere)
npm run dev
```

Al arrancar imprime la URL de Alpha, del SDK y el `parentOrigin` que va a mandar. Si Alpha rechaza la sesión, la pantalla muestra el HTTP y el `code` de Alpha (por ejemplo `origin_not_allowed`), sin datos sensibles.

## Pendiente de confirmar con gateway

- URL publicada de `alpha-checkout.js` en dev y que `Checkout:Embedded:Enabled` esté encendido.
- Firma exacta de `AlphaCheckout.mount` y nombres de eventos (viene en la guía del MID).
- Catálogo de `status` de la sesión, para saber cuál es «pagado».
- Si en sandbox aceptan `https://localhost:5443` como origen.

## Publicar en Vercel

La lógica está en `lib/tienda.js` y no guarda nada en memoria. El pedido viaja en un token HMAC firmado con `TIENDA_SECRETO`, así que corre igual en local y en las funciones de Vercel:

- `public/` → estáticos (`outputDirectory` en `vercel.json`).
- `api/config.js`, `api/pedidos/index.js`, `api/pedidos/[token].js` → funciones Node.
- `server.js` es sólo para local; Vercel lo ignora (`.vercelignore`).

1. Importar el repo en Vercel con Framework Preset **Other**, sin build command.
2. Configurar las variables de entorno del proyecto:
   - `MODO`: `mock` para la primera prueba, luego `alpha`.
   - `TIENDA_ORIGEN`: `https://<proyecto>.vercel.app`, o el dominio propio si se configura.
   - `TIENDA_SECRETO`, `ALPHA_API_URL`, `ALPHA_CHECKOUT_KEY` y `ALPHA_CHECKOUT_JS` (este último sólo si difiere).
3. Registrar `TIENDA_ORIGEN` como origen del MID en la CA. Con Vercel ya es https, así que no hace falta certificado.

Ojo: cada deploy de preview tiene otra URL. El origen registrado en la CA y `TIENDA_ORIGEN` deben ser el dominio de **producción** del proyecto.
