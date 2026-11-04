const crypto = require("crypto");
const L = require("./_lib");

const now = () => Date.now() / 1000;
const rnd = (n) => crypto.randomBytes(n).toString("hex");
const hash = (pw, salt) => crypto.pbkdf2Sync(pw, Buffer.from(salt, "hex"), 120000, 32, "sha256").toString("hex"); // same as web_login.py
const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
// While ALLOWED_IDS is set, only those Telegram IDs can log in. Leave it empty to open the site to everyone.
const allowed = (id) => { const a = (process.env.ALLOWED_IDS || "").split(",").map((x) => x.trim()).filter(Boolean); return !a.length || a.includes(String(id)); };

async function finish(res, db, id) {
  if (!allowed(id)) return res.status(403).json({ error: "This site is not open yet" });
  const u = await db.collection("users").findOne({ _id: id });
  const name = String((u && u.name) || "User").slice(0, 40);
  res.setHeader("Set-Cookie", L.cookie(L.makeSession({ id, name }), 7 * 86400));
  res.json({ ok: true });
}

// POST {action:"start"}            -> new login code + link to the bot
// POST {action:"poll", tok, sec}   -> waits until the bot has confirmed that code, then logs in
// POST {action:"password", id, password} -> login with the ID and password the bot gave
// DELETE                           -> logout
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", L.cookie("", 0));
    return res.json({ ok: true });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = req.body || {};
  try {
    const db = await L.db();
    const codes = db.collection("web_login"), users = db.collection("web_users");

    if (b.action === "start") {
      if (!process.env.BOT_USERNAME) return res.status(500).json({ error: "BOT_USERNAME is not set" });
      const tok = rnd(16), sec = rnd(16);
      await codes.deleteMany({ exp: { $lt: now() } });
      await codes.insertOne({ _id: tok, sec, status: "pending", exp: now() + 300 });
      return res.json({ tok, sec, link: `https://t.me/${process.env.BOT_USERNAME}?start=web_${tok}` });
    }

    if (b.action === "poll") {
      const t = await codes.findOne({ _id: String(b.tok) });
      if (!t || !same(t.sec, b.sec) || t.exp < now()) return res.status(404).json({ error: "Link expired. Please try again." });
      if (t.status !== "ok") return res.json({ ok: false });
      const got = await codes.findOneAndDelete({ _id: t._id, status: "ok" });
      if (!got) return res.json({ ok: false });
      return finish(res, db, t.uid);
    }

    if (b.action === "password") {
      const id = Number(b.id), pw = b.password;
      if (!Number.isInteger(id) || typeof pw !== "string" || !pw || pw.length > 100) return res.status(400).json({ error: "Enter your ID and password" });
      const w = await users.findOne({ _id: id });
      const bad = () => res.status(401).json({ error: "Wrong ID or password" });
      if (!w) return bad();
      if (w.lock && w.lock > now()) return res.status(429).json({ error: "Too many tries. Please try again in a few minutes." });
      if (!same(hash(pw, w.salt), w.hash)) {
        const f = (w.fails || 0) + 1;
        await users.updateOne({ _id: id }, { $set: { fails: f >= 5 ? 0 : f, lock: f >= 5 ? now() + 600 : 0 } });
        return bad();
      }
      await users.updateOne({ _id: id }, { $set: { fails: 0, lock: 0 } });
      return finish(res, db, id);
    }

    res.status(400).json({ error: "Bad request" });
  } catch (e) {
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
