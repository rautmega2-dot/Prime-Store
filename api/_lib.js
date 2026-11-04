const crypto = require("crypto");
const { MongoClient } = require("mongodb");

let client;
exports.db = async () => {
  if (!client) {
    client = new MongoClient(process.env.MONGO_URI, { maxPoolSize: 3, serverSelectionTimeoutMS: 8000 });
    await client.connect();
  }
  return client.db(process.env.MONGO_DB || "primebot");
};

const sign = (p) => crypto.createHmac("sha256", process.env.SESSION_SECRET).update(p).digest("base64url");

exports.makeSession = (u) => {
  const p = Buffer.from(JSON.stringify({ ...u, exp: Date.now() + 7 * 864e5 })).toString("base64url");
  return p + "." + sign(p);
};

exports.readSession = (req) => {
  const m = /(?:^|; )ps=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const [p, s] = m[1].split(".");
  if (!p || !s) return null;
  const a = Buffer.from(sign(p)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const u = JSON.parse(Buffer.from(p, "base64url").toString());
    return u.exp > Date.now() ? u : null;
  } catch (e) { return null; }
};

exports.cookie = (v, max) => `ps=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${max}`;

exports.esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
