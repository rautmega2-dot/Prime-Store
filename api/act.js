const crypto = require("crypto");
const L = require("./_lib");

const now = () => Date.now() / 1000;
const int = (v, min = 1, max = 1e9) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const str = (v, re, max = 80) => { v = typeof v === "string" ? v.trim() : ""; return v && v.length <= max && re.test(v) ? v : null; };
const rid = (b) => { const r = int(b.rid); return r ? { rid: r } : null; };

// Things a logged-in user does on the site. The site never touches money itself: it leaves a request ("job") in MongoDB,
// the bot runs it with its own code (same wallet, same checks, same refunds) and writes the result back.
//
// POST {action: <name>, ...}  -> {id}                       (see JOBS below)
// POST {action: "job", id}    -> {status, error, note, out}  status: new | working | done | error | checking | expired
// Background helpers: they never move money, so they neither wait for nor block the one-request-at-a-time rule.
const LIGHT = ["set_cur", "tos_ok", "join_check", "crypto_check", "smm_refresh"];

const JOBS = {
  smm: ["smm", (b) => { const sid = int(b.service_id), qty = int(b.qty), cost = int(b.cost), link = str(b.link, /\S/, 400); return sid && qty && cost && link ? { sid, link, qty, cost } : null; }],
  refresh: ["smm_refresh", rid],
  refill: ["smm_refill", rid],
  tg_buy: ["tg_buy", (b) => { const code = str(b.code, /^[A-Za-z0-9]{1,8}$/, 8), cost = int(b.cost); return code && cost ? { code, cost } : null; }],
  tg_code: ["tg_code", rid],
  upi_verify: ["upi_verify", (b) => { const amount = int(b.amount, 1, 100000), ref = str(b.ref, /^[A-Za-z0-9]{6,40}$/, 40); return amount && ref ? { amount, ref } : null; }],
  bpay_verify: ["bpay_verify", (b) => { const ref = str(b.ref, /^(?:M_P_)?\d{15,24}$/i, 40); return ref ? { ref } : null; }],
  crypto_invoice: ["crypto_invoice", (b) => {
    if (b.usd !== undefined) { const usd = Math.round(Number(b.usd) * 100) / 100; return usd > 0 && usd <= 100000 ? { usd } : null; }
    const inr = int(b.inr, 1, 100000); return inr ? { inr } : null;
  }],
  wa_buy: ["wa_buy", (b) => { const code = str(b.code, /^[A-Za-z0-9]{1,8}$/, 8), cost = int(b.cost); return code && cost ? { code, cost } : null; }],
  wa_code: ["wa_code", rid],
  wa_cancel: ["wa_cancel", rid],
  set_cur: ["set_cur", (b) => { const cur = str(b.cur, /^(INR|USDT)$/, 4); return cur ? { cur } : null; }],
  tos_ok: ["tos_ok", () => ({})],
  join_check: ["join_check", () => ({})],
  crypto_check: ["crypto_check", (b) => { const track = str(b.track, /^[A-Za-z0-9_-]{4,64}$/, 64); return track ? { track } : null; }],
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const u = L.readSession(req);
  if (!u) return res.status(401).json({ error: "Please log in again." });
  const b = req.body || {};
  try {
    const db = await L.db();
    const jobs = db.collection("web_jobs");

    if (b.action === "job") {
      const j = await jobs.findOne({ _id: String(b.id), uid: u.id });
      if (!j) return res.status(404).json({ error: "Request not found." });
      return res.json({
        status: j.status, error: j.error || "", note: j.note || "", rid: j.rid || 0, oid: j.oid || "",
        name: j.name || "", qty: j.qty || 0, cost: (j.cost || 0) / 100, out: j.out || {},
      });
    }

    const def = JOBS[b.action];
    if (!def) return res.status(400).json({ error: "Bad request" });
    const fields = def[1](b);
    if (!fields) return res.status(400).json({ error: "Please check what you entered." });
    // one request at a time per user, so a double tap can never run twice
    const busy = !LIGHT.includes(def[0]) && await jobs.findOne({ uid: u.id, type: { $nin: LIGHT }, status: { $in: ["new", "working"] }, exp: { $gt: now() } });
    if (busy) return res.status(429).json({ error: "Your previous request is still running. Please wait a few seconds." });
    const id = crypto.randomBytes(12).toString("hex");
    await jobs.insertOne({ _id: id, type: def[0], uid: u.id, ...fields, status: "new", created: now(), exp: now() + 90 });
    return res.json({ id });
  } catch (e) {
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
