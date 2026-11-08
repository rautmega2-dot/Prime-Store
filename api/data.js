const L = require("./_lib");
const CANCELLED = ["canceled", "cancelled", "refunded", "fail", "failed", "rejected"];
const smmNote = (st) => {
  const low = String(st || "").toLowerCase();
  if (low === "" || low === "pending") return "The order is queued and has not started yet.";
  if (low === "in progress" || low === "processing") return "The provider is delivering this order.";
  if (low === "completed") return "The provider marked this order complete. The quantity should now be delivered.";
  if (low === "partial") return "Only part of the quantity was delivered. The rest was refunded to your wallet.";
  if (CANCELLED.includes(low)) return "This order was cancelled and the money was refunded.";
  if (low === "checking") return "We are confirming this order with the provider. You'll get a message soon.";
  return "Status: " + st;
};
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
    // the API key of this user: /api/data?api=1  (only accounts connected to Telegram have one; it is the same key as in the bot)
    if (req.query && req.query.api) {
      if (L.isWeb(u.id)) return res.json({ tg: false, bot });
      const k = await db.collection("api_keys").findOne({ _id: u.id });
      return res.json({
        tg: true, bot, id: u.id, key: (k && k.key) || "",
        ips: String((k && k.ips) || "").split(",").map((x) => x.trim()).filter(Boolean),
        base: process.env.API_BASE_URL || "",
      });
    }
    // the services of one platform (loaded when the user opens it): /api/data?plat=instagram
    const pk = req.query && req.query.plat;
    if (pk) {
      const d = await db.collection("web_smm").findOne({ _id: String(pk) });
      return res.json({ services: (d && d.services) || [] });
    }
    // the Binance Pay QR image (the bot saves it for the site)
    if (req.query && req.query.bqr) {
      const q = await db.collection("web_cfg").findOne({ _id: "bpay_qr" });
      return res.json({ img: (q && q.img) || "" });
    }
    // a crypto invoice of this user: /api/data?inv=TRACK_ID
    const iv = req.query && req.query.inv;
    if (iv) {
      const r = await db.collection("crypto_invoices").findOne({ _id: String(iv), user_id: u.id });
      if (!r) return res.status(404).json({ error: "Invoice not found" });
      return res.json({ status: r.status, usd: r.usd, inr: r.inr, expires: r.expires });
    }
    // full details of one order (like the status page in the bot): /api/data?order=smm:123  (smm | num | wa)
    const od = req.query && req.query.order;
    if (od) {
      const [k, i] = String(od).split(":");
      const col = { smm: "smm_orders", num: "number_orders", wa: "wa_orders" }[k];
      const id = Number(i);
      if (!col || !Number.isInteger(id)) return res.status(400).json({ error: "Bad request" });
      const r = await db.collection(col).findOne({ _id: id, user_id: u.id });
      if (!r) return res.status(404).json({ error: "Order not found" });
      const base = { k, rid: r._id, oid: r.oid || "", name: r.name || "", status: r.status || "", cost: (r.cost || 0) / 100, refunded: (r.refunded || 0) / 100, created: ts(r.created) };
      if (k === "smm") {
        const st = r.status || "Pending", low = st.toLowerCase();
        const [sv, pl] = await Promise.all([
          db.collection("smm_services").findOne({ _id: r.service_id }),
          db.collection("web_smm").findOne({ "services.id": r.service_id }, { projection: { label: 1 } }),
        ]);
        return res.json({
          ...base, status: st, plat: (pl && pl.label) || "", qty: r.qty || 0, link: r.link || "", start: r.start_count || "",
          remains: r.remains != null ? r.remains : low === "completed" ? 0 : r.qty || 0,
          note: smmNote(st), canRefill: !!(sv && sv.refill) && ["completed", "partial"].includes(low),
          canRefresh: !r.final && !!r.provider_order,
        });
      }
      const low = String(r.status || "").toLowerCase();
      return res.json({
        ...base, number: r.number || "", op: r.op && r.op !== "auto" ? r.op : "", code: r.code_text || "", pass: r.pass_text || "",
        canCode: (k === "num" || k === "wa") && low === "bought", canCancel: k === "wa" && low === "bought",
        note: low === "bought" ? (k === "num" ? "Log in to Telegram with this number, then tap Get code." : "Open WhatsApp, enter this number and ask for the SMS code, then tap Get code. No code? Tap Cancel & refund to get your money back.") : low === "checking" ? "This order is being checked. You'll get a message soon." : "",
      });
    }
    const mine = { user_id: u.id };
    const [w, tg, wa, smm, num, wao, tops, plats, cfg, flg, ur, wu] = await Promise.all([
      db.collection("wallet").findOne({ _id: u.id }),
      db.collection("lion_countries").find({ enabled: 1, my_price: { $ne: null } }).sort({ my_price: 1 }).toArray(),
      db.collection("wa_countries").find({ enabled: 1, my_price: { $ne: null } }).sort({ my_price: 1 }).toArray(),
      db.collection("smm_orders").find(mine).sort({ _id: -1 }).limit(30).toArray(),
      db.collection("number_orders").find(mine).sort({ _id: -1 }).limit(30).toArray(),
      db.collection("wa_orders").find(mine).sort({ _id: -1 }).limit(30).toArray(),
      db.collection("topups").find(mine).sort({ _id: -1 }).limit(30).toArray(),
      db.collection("web_smm").find({}, { projection: { services: 0 } }).sort({ o: 1 }).toArray(),
      db.collection("web_cfg").findOne({ _id: "cfg" }),
      db.collection("web_cfg").findOne({ _id: "flags" }),
      db.collection("users").findOne({ _id: u.id }),
      db.collection("web_users").findOne({ _id: u.id }, { projection: { email: 1, phone: 1 } }),
    ]);
    const c = (kind) => (x) => [x.name, x.code, x.num || "", x.my_price, x.qty || 0, ((flg && flg[kind]) || {})[x.code] || ""];
    const o = (r, id, fl, n, k) => ({ id, n, fl, k, i: r._id, p: (r.cost || 0) / 100, s: r.status || "", t: ts(r.created) });
    const orders = [
      ...smm.map((r) => o(r, r.oid || "#S" + r._id, "🚀", r.name || "SMM order", "smm")),
      ...num.map((r) => o(r, r.oid || "#T" + r._id, "✈️", (r.country || r.name || "Telegram") + " Telegram", "num")),
      ...wao.map((r) => o(r, r.oid || "#W" + r._id, "💬", (r.country || r.name || "WhatsApp") + " WhatsApp", "wa")),
    ].sort((a, b) => b.t - a.t).slice(0, 40);
    res.json({
      bot,
      user: { id: u.id, name: L.esc(u.name), cur: (ur && ur.cur) || "", tos: !!(ur && ur.tos), tg: !L.isWeb(u.id), email: (wu && wu.email) || "", phone: (wu && wu.phone) || "" },
      balance: ((w && w.balance) || 0) / 100,
      tg: tg.map(c("tg")),
      wa: wa.map(c("wa")),
      orders,
      plats: plats.map((p) => [p._id, p.label, p.n]),
      cfg: cfg || {},
      topups: tops.map((t) => {
        const ref = String(t.ref || "");
        const how = ref.startsWith("BPAY:") ? "Binance Pay" : ref.startsWith("OXA:") ? "Crypto" : "UPI";
        return { a: t.amount || 0, s: "Credited", how, id: String(t.utr || ref.split(":").pop() || ""), t: ts(t.created) };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: "Database error" });
  }
};
