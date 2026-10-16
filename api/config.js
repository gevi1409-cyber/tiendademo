// Vercel: GET /api/config
const t = require("../lib/tienda");
module.exports = (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Método no permitido" });
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(t.configPublica(t.cfg()));
};
