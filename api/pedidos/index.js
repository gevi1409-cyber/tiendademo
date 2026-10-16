// Vercel: POST /api/pedidos — crea el pedido y la sesión de checkout en Alpha
const t = require("../../lib/tienda");
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  res.setHeader("Cache-Control", "no-store");
  const r = await t.crearPedido(t.cfg(), req.body || {}, t.origenDe(req));
  res.status(r.status).json(r.body);
};
