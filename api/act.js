const crypto = require("crypto");
const L = require("./_lib");

const now = () => Date.now() / 1000;

// Things a logged-in user does on the site. The site never touches money itself: it leaves a request ("job") in MongoDB,
// the bot runs it with its own code (same wallet, same checks, same refunds) and writes the result back.
//
// POST {action:"smm", service_id, link, qty, cost}  -> {id}      cost = total in paise that the user saw
// POST {action:"job", id}                           -> {status, ...}   new | working | done | error | checking | expired
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const u = L.readSession(req);
  if (!u) return res.status(401).json({ error: "Please log in again." });
  const b = req.body || {};
  try {
    const db = await L.db();
    const jobs = db.collection("web_jobs");

    if (b.action === "smm") {
      const sid = Number(b.service_id), qty = Number(b.qty), cost = Number(b.cost);
      const link = typeof b.link === "string" ? b.link.trim() : "";
      if (!Number.isInteger(sid) || !Number.isInteger(qty) || qty < 1 || !Number.isInteger(cost) || cost < 1 || !link || link.length > 400)
        return res.status(400).json({ error: "Please check the link and quantity." });
      // one order at a time per user, so a double tap can never place two orders
      const busy = await jobs.findOne({ uid: u.id, status: { $in: ["new", "working"] }, exp: { $gt: now() } });
      if (busy) return res.status(429).json({ error: "Your previous order is still being placed. Please wait a few seconds." });
      const id = crypto.randomBytes(12).toString("hex");
      await jobs.insertOne({ _id: id, type: "smm", uid: u.id, sid, link, qty, cost, status: "new", created: now(), exp: now() + 90 });
      return res.json({ id });
    }

    if (b.action === "job") {
      const j = await jobs.findOne({ _id: String(b.id), uid: u.id });
      if (!j) return res.status(404).json({ error: "Request not found." });
      return res.json({ status: j.status, error: j.error || "", oid: j.oid || "", name: j.name || "", qty: j.qty || 0, cost: (j.cost || 0) / 100 });
    }

    res.status(400).json({ error: "Bad request" });
  } catch (e) {
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
