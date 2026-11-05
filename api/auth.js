const crypto = require("crypto");
const L = require("./_lib");

const now = () => Date.now() / 1000;
const rnd = (n) => crypto.randomBytes(n).toString("hex");
const hash = (pw, salt) => crypto.pbkdf2Sync(pw, Buffer.from(salt, "hex"), 120000, 32, "sha256").toString("hex"); // same as web_login.py
const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
// While ALLOWED_IDS is set, only those Telegram IDs can log in. Leave it empty to open the site to everyone.
const allowedList = () => (process.env.ALLOWED_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
const allowed = (id) => { const a = allowedList(); return !a.length || a.includes(String(id)); };
// the driver returns the document itself (v6) or {value} (older): accept both
const doc = (r) => (r && r.value !== undefined ? r.value : r);

const normEmail = (v) => { v = String(v || "").trim().toLowerCase(); return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : null; };
const normPhone = (v) => {
  let d = String(v || "").replace(/[\s\-()+]/g, "");
  if (!/^\d{8,15}$/.test(d)) return null;
  if (d.length === 10) d = "91" + d; // a plain 10-digit number is treated as an Indian number
  return d;
};
const goodPw = (pw) => typeof pw === "string" && pw.length >= 6 && pw.length <= 100;

let idxDone = false;
async function ensureIdx(db) {
  if (idxDone) return;
  try {
    const u = db.collection("web_users");
    await u.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
    await u.createIndex({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: "string" } } });
    idxDone = true;
  } catch (e) { /* retried on the next request */ }
}

async function finish(res, db, id) {
  if (!allowed(id)) return res.status(403).json({ error: "This site is not open yet" });
  const [u, w] = await Promise.all([db.collection("users").findOne({ _id: id }), db.collection("web_users").findOne({ _id: id }, { projection: { name: 1 } })]);
  const name = String((u && u.name) || (w && w.name) || "User").slice(0, 40);
  res.setHeader("Set-Cookie", L.cookie(L.makeSession({ id, name }), 7 * 86400));
  res.json({ ok: true });
}

// Checks a password with the same lock-out rules for every login type. Returns true if it already answered (= failed).
async function rejectPw(res, users, w, pw, badMsg) {
  const bad = () => { res.status(401).json({ error: badMsg }); return true; };
  if (!w) { hash(pw, "00".repeat(16)); return bad(); } // same work for unknown users
  if (w.lock && w.lock > now()) { res.status(429).json({ error: "Too many tries. Please try again in a few minutes." }); return true; }
  if (!w.hash || !same(hash(pw, w.salt), w.hash)) {
    const f = (w.fails || 0) + 1;
    await users.updateOne({ _id: w._id }, { $set: { fails: f >= 5 ? 0 : f, lock: f >= 5 ? now() + 600 : 0 } });
    return bad();
  }
  await users.updateOne({ _id: w._id }, { $set: { fails: 0, lock: 0 } });
  return false;
}

async function newCode(db, extra) {
  const tok = rnd(16), sec = rnd(16);
  const codes = db.collection("web_login");
  await codes.deleteMany({ exp: { $lt: now() } });
  await codes.insertOne({ _id: tok, sec, status: "pending", exp: now() + 300, ...extra });
  return { tok, sec, link: `https://t.me/${process.env.BOT_USERNAME}?start=web_${tok}` };
}

// POST {action:"start"}                          -> new login code + link to the bot
// POST {action:"poll", tok, sec}                 -> waits until the bot has confirmed that code, then logs in
// POST {action:"password", id, password}         -> login with the Telegram ID and password the bot gave
// POST {action:"register", kind, ident, password}-> new account with email or phone (kind: "email" | "phone")
// POST {action:"login", ident, password}         -> login with email or phone + password
// POST {action:"link_start"}                     -> (logged in, no Telegram yet) code + bot link to connect Telegram and merge
// DELETE                                         -> logout
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
    await ensureIdx(db);
    const codes = db.collection("web_login"), users = db.collection("web_users");

    if (b.action === "start") {
      if (!process.env.BOT_USERNAME) return res.status(500).json({ error: "BOT_USERNAME is not set" });
      return res.json(await newCode(db, {}));
    }

    if (b.action === "link_start") {
      const u = L.readSession(req);
      if (!u) return res.status(401).json({ error: "Please log in again." });
      if (!L.isWeb(u.id)) return res.status(400).json({ error: "Telegram is already connected." });
      if (!process.env.BOT_USERNAME) return res.status(500).json({ error: "BOT_USERNAME is not set" });
      return res.json(await newCode(db, { link: u.id }));
    }

    if (b.action === "poll") {
      const t = await codes.findOne({ _id: String(b.tok) });
      if (!t || !same(t.sec, b.sec) || t.exp < now()) return res.status(404).json({ error: "Link expired. Please try again." });
      if (t.status === "failed") { await codes.deleteOne({ _id: t._id }); return res.status(409).json({ error: t.error || "Could not connect Telegram." }); }
      if (t.status !== "ok") return res.json({ ok: false });
      const got = doc(await codes.findOneAndDelete({ _id: t._id, status: "ok" }));
      if (!got) return res.json({ ok: false });
      return finish(res, db, t.uid);
    }

    if (b.action === "register") {
      if (allowedList().length) return res.status(403).json({ error: "This site is not open yet" });
      const kind = b.kind === "phone" ? "phone" : "email";
      const val = kind === "email" ? normEmail(b.ident) : normPhone(b.ident);
      if (!val) return res.status(400).json({ error: kind === "email" ? "Enter a valid email" : "Enter a valid phone number" });
      if (!goodPw(b.password)) return res.status(400).json({ error: "Password must be 6 to 100 characters" });
      if (await users.findOne({ [kind]: val }, { projection: { _id: 1 } })) return res.status(409).json({ error: `This ${kind === "email" ? "email" : "number"} is already registered. Please log in.` });
      const c = doc(await db.collection("web_cfg").findOneAndUpdate({ _id: "webuid" }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after" }));
      const id = L.WEB_BASE + c.n;
      const salt = rnd(16);
      try {
        await users.insertOne({ _id: id, [kind]: val, name: kind === "email" ? val.split("@")[0].slice(0, 40) : "User", salt, hash: hash(b.password, salt), created: Math.floor(now()), fails: 0, lock: 0 });
      } catch (e) {
        if (e && e.code === 11000) return res.status(409).json({ error: "This " + (kind === "email" ? "email" : "number") + " is already registered. Please log in." });
        throw e;
      }
      return finish(res, db, id);
    }

    if (b.action === "login") {
      const raw = String(b.ident || "").trim(), pw = b.password;
      const kind = raw.includes("@") ? "email" : "phone";
      const val = kind === "email" ? normEmail(raw) : normPhone(raw);
      if (!val || typeof pw !== "string" || !pw || pw.length > 100) return res.status(400).json({ error: "Enter your email or number and password" });
      const w = await users.findOne({ [kind]: val });
      if (await rejectPw(res, users, w, pw, "Wrong email, number or password")) return;
      return finish(res, db, w._id);
    }

    if (b.action === "password") {
      const id = Number(b.id), pw = b.password;
      if (!Number.isInteger(id) || typeof pw !== "string" || !pw || pw.length > 100) return res.status(400).json({ error: "Enter your ID and password" });
      const w = await users.findOne({ _id: id });
      if (await rejectPw(res, users, w, pw, "Wrong ID or password")) return;
      return finish(res, db, id);
    }

    res.status(400).json({ error: "Bad request" });
  } catch (e) {
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
