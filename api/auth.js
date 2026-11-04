const crypto = require("crypto");
const L = require("./_lib");

// POST = Telegram login, DELETE = logout
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", L.cookie("", 0));
    return res.json({ ok: true });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { hash, ...rest } = req.body || {};
  const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
  const key = crypto.createHash("sha256").update(process.env.BOT_TOKEN || "").digest();
  const h = crypto.createHmac("sha256", key).update(check).digest("hex");
  if (!hash || String(hash).length !== h.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(String(hash)))) {
    return res.status(401).json({ error: "Telegram check failed" });
  }
  if (Date.now() / 1000 - Number(rest.auth_date) > 86400) {
    return res.status(401).json({ error: "Login expired, please try again" });
  }
  const id = Number(rest.id);
  // While ALLOWED_IDS is set, only these Telegram IDs can log in (keeps real users out until launch).
  const allow = (process.env.ALLOWED_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (allow.length && !allow.includes(String(id))) {
    return res.status(403).json({ error: "This site is not open yet" });
  }
  const name = String(rest.first_name || rest.username || "User").slice(0, 40);
  res.setHeader("Set-Cookie", L.cookie(L.makeSession({ id, name }), 7 * 86400));
  res.json({ ok: true });
};
