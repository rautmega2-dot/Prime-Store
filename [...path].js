// Without BOT_API_URL the site runs in DEMO mode (sample data, no bot needed).
// With BOT_API_URL set, /api/* is forwarded to the bot's API.
const SVC = [
  { key: "instagram", label: "📸 Instagram", items: [
    { id: 1, name: "Instagram Followers", rate: 120, min: 100, max: 10000 },
    { id: 2, name: "Instagram Likes", rate: 40, min: 50, max: 5000 },
    { id: 3, name: "Instagram Reel Views", rate: 15, min: 100, max: 100000 } ] },
  { key: "telegram", label: "✈️ Telegram", items: [
    { id: 4, name: "Telegram Channel Members", rate: 90, min: 100, max: 20000 },
    { id: 5, name: "Telegram Post Views", rate: 10, min: 100, max: 50000 } ] },
  { key: "youtube", label: "▶️ YouTube", items: [
    { id: 6, name: "YouTube Views", rate: 150, min: 500, max: 50000 },
    { id: 7, name: "YouTube Subscribers", rate: 800, min: 50, max: 5000 } ] },
];

function demo(req, res, path) {
  const on = (req.headers.cookie || "").includes("demo=1");
  if (path === "login") { res.setHeader("Set-Cookie", "demo=1; Path=/; Max-Age=86400; SameSite=Lax"); return res.json({ ok: true }); }
  if (path === "logout") { res.setHeader("Set-Cookie", "demo=; Path=/; Max-Age=0"); return res.json({ ok: true }); }
  if (!on) return res.status(401).json({ detail: "Please log in" });
  if (path === "me") return res.json({ id: 123456789, name: "Demo User", balance: 250, recharges: 2, orders: 1, upi: true, bpay: true, bpay_id: "123456789", crypto: true, fx: 90, crypto_min: 10 });
  if (path === "services") return res.json(SVC);
  if (path === "orders") return res.json([{ oid: "demo0001", name: "Instagram Followers", link: "https://instagram.com/demo", qty: 500, cost: 60, status: "Completed", when: "01 Nov 2026, 10:00 AM" }]);
  return res.json({ ok: true, note: "Demo mode: nothing was really placed.", oid: "demo", balance: 250, upi: "demo@upi", amount: 100, link: "#", url: "#", track: "demo", usd: 1.12, inr: 100, status: "pending", added: 0 });
}

module.exports = async (req, res) => {
  const path = [].concat(req.query.path || []).join("/");
  const base = (process.env.BOT_API_URL || "").replace(/\/+$/, "");
  if (path === "config") return res.status(200).json({ bot: process.env.BOT_USERNAME || "", store: process.env.STORE_NAME || "Store", support: process.env.SUPPORT_USERNAME || "", channel: process.env.CHANNEL_LINK || "", logo: process.env.LOGO_URL || "", demo: !base });
  if (!base) return demo(req, res, path);
  try {
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const r = await fetch(`${base}/api/${path}`, {
      method: req.method,
      headers: { "content-type": "application/json", cookie: req.headers.cookie || "", "x-proxy-key": process.env.PROXY_KEY || "" },
      body: hasBody ? JSON.stringify(req.body || {}) : undefined,
    });
    const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    res.status(r.status).setHeader("content-type", "application/json").send(await r.text());
  } catch (e) {
    res.status(502).json({ detail: "Store server is not reachable right now." });
  }
};
