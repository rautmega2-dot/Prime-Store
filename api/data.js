const L = require("./_lib");
const ts = (v) => { v = Number(v) || 0; return v > 1e12 ? v : v * 1000; };

// Read-only: everything the site shows, straight from the bot's MongoDB mirror.
// Money in the bot is stored in paise, so it is divided by 100 here.
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const bot = process.env.BOT_USERNAME || "";
  const u = L.readSession(req);
  if (!u) return res.status(401).json({ bot });
  try {
    const db = await L.db();
    // the services of one platform (loaded when the user opens it): /api/data?plat=instagram
    const pk = req.query && req.query.plat;
    if (pk) {
      const d = await db.collection("web_smm").findOne({ _id: String(pk) });
      return res.json({ services: (d && d.services) || [] });
    }
    const mine = { user_id: u.id };
    const [w, tg, wa, smm, num, wao, tops, plats] = await Promise.all([
      db.collection("wallet").findOne({ _id: u.id }),
      db.collection("lion_countries").find({ enabled: 1, my_price: { $ne: null } }).sort({ my_price: 1 }).toArray(),
      db.collection("wa_countries").find({ enabled: 1, my_price: { $ne: null } }).sort({ my_price: 1 }).toArray(),
      db.collection("smm_orders").find(mine).sort({ _id: -1 }).limit(30).toArray(),
      db.collection("number_orders").find(mine).sort({ _id: -1 }).limit(30).toArray(),
      db.collection("wa_orders").find(mine).sort({ _id: -1 }).limit(30).toArray(),
      db.collection("topups").find(mine).sort({ _id: -1 }).limit(30).toArray(),
      db.collection("web_smm").find({}, { projection: { services: 0 } }).sort({ o: 1 }).toArray(),
    ]);
    const c = (x) => [x.name, x.code, x.num || "", x.my_price, x.qty || 0];
    const o = (r, id, fl, n) => ({ id, n, fl, p: (r.cost || 0) / 100, s: r.status || "", t: ts(r.created) });
    const orders = [
      ...smm.map((r) => o(r, r.oid || "#S" + r._id, "🚀", r.name || "SMM order")),
      ...num.map((r) => o(r, "#T" + r._id, "✈️", (r.country || r.name || "Telegram") + " Telegram")),
      ...wao.map((r) => o(r, "#W" + r._id, "💬", (r.country || r.name || "WhatsApp") + " WhatsApp")),
    ].sort((a, b) => b.t - a.t).slice(0, 40);
    res.json({
      bot,
      user: { id: u.id, name: L.esc(u.name) },
      balance: ((w && w.balance) || 0) / 100,
      tg: tg.map(c),
      wa: wa.map(c),
      orders,
      plats: plats.map((p) => [p._id, p.label, p.n]),
      topups: tops.map((t) => ({ a: (t.amount || 0) / 100, s: "Added", t: ts(t.created) })),
    });
  } catch (e) {
    res.status(500).json({ error: "Database error" });
  }
};
