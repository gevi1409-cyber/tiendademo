// Vercel: GET /api/pedidos/{token} — confirma el pedido contra Alpha
const t = require("../../lib/tienda");
module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Método no permitido" });
  res.setHeader("Cache-Control", "no-store");
  const r = await t.confirmarPedido(t.cfg(), req.query.token, req.query.mock);
  res.status(r.status).json(r.body);
};
