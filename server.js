require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const ADMIN_DEFAULT_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD || ""; // only used to seed the admin account the first time the server runs
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "timeflow.db");
const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const HOURS_PER_DAY = 8;

// ---------- database ----------
require("fs").mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',      -- 'active' | 'inactive'
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entries (
    date TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    hours TEXT NOT NULL,           -- JSON array of 8 strings, one per hour slot
    updated_at TEXT NOT NULL,
    PRIMARY KEY (date, employee_id)
  );

  CREATE INDEX IF NOT EXISTS idx_entries_month ON entries (date);
`);

// ---------- password helpers ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const attempt = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(attempt, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function generateTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; // no 0/O/1/l/I
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  return out;
}
function makeId() {
  return "u" + crypto.randomBytes(6).toString("hex");
}

// ---------- seed the admin account on first run ----------
(function seedAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE is_admin = 1").get();
  if (existing) return;
  const initialPassword = ADMIN_DEFAULT_PASSWORD || generateTempPassword();
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, must_change_password, status, is_admin, created_at)
    VALUES (@id, 'System Admin', 'admin@company.com', @password_hash, 1, 'active', 1, @created_at)
  `).run({ id: makeId(), password_hash: hashPassword(initialPassword), created_at: new Date().toISOString() });
  console.log("============================================================");
  console.log(" First-time setup — sign in as admin@company.com with password:");
  console.log(" " + initialPassword);
  console.log(" You'll be asked to set your own password right away.");
  console.log("============================================================");
})();

// Recovery path if the admin forgets their password: set ADMIN_RESET_PASSWORD in the
// environment, restart the server once, log in with that value, then remove the
// variable again (otherwise it resets on every restart).
if (process.env.ADMIN_RESET_PASSWORD) {
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE is_admin = 1")
    .run(hashPassword(process.env.ADMIN_RESET_PASSWORD));
  console.log("============================================================");
  console.log(" ADMIN_RESET_PASSWORD was set — the admin password has been reset.");
  console.log(" Log in, set a new password, then remove ADMIN_RESET_PASSWORD.");
  console.log("============================================================");
}

// ---------- sessions (in-memory; everyone just logs in again after a server restart) ----------
const sessions = new Map(); // token -> { userId, isAdmin, expiresAt }
function createSession(userId, isAdmin) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { userId, isAdmin, expiresAt: Date.now() + SESSION_LIFETIME_MS });
  return token;
}
function destroySessionsForUser(userId) {
  for (const [token, s] of sessions) if (s.userId === userId) sessions.delete(token);
}
function requireAuth(req, res, next) {
  const token = req.header("x-auth-token") || "";
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: "Your session has expired — please log in again." });
  }
  req.userId = session.userId;
  req.isAdmin = session.isAdmin;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.isAdmin) return res.status(403).json({ error: "Admin access required." });
    next();
  });
}

function normalizeHours(input) {
  const arr = Array.isArray(input) ? input.slice(0, HOURS_PER_DAY) : [];
  while (arr.length < HOURS_PER_DAY) arr.push("");
  return arr.map(v => (typeof v === "string" ? v : String(v || "")));
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- auth ----------
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim().toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  if (user.status === "inactive") {
    return res.status(403).json({ error: "This account has been deactivated by the system administrator." });
  }
  const token = createSession(user.id, !!user.is_admin);
  res.json({
    token,
    userId: user.id,
    name: user.name,
    email: user.email,
    isAdmin: !!user.is_admin,
    mustChangePassword: !!user.must_change_password,
  });
});

// No "current password" required here — a valid session (from having just logged in
// with the temp/admin-reset password) is treated as sufficient proof of identity.
app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
    .run(hashPassword(newPassword), req.userId);
  res.json({ ok: true });
});

// ---------- users / employees ----------
// Public read (needed to populate the login dropdown before anyone is authenticated).
app.get("/api/employees", (req, res) => {
  const rows = db.prepare(
    "SELECT id, name, email, status, is_admin as isAdmin, must_change_password as mustChangePassword FROM users ORDER BY is_admin DESC, name COLLATE NOCASE"
  ).all();
  rows.forEach(r => { r.isAdmin = !!r.isAdmin; r.mustChangePassword = !!r.mustChangePassword; });
  res.json(rows);
});

app.post("/api/employees", requireAdmin, (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required." });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  const cleanEmail = String(email).trim().toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(cleanEmail);
  if (existing) return res.status(409).json({ error: "That email is already registered." });

  const tempPassword = generateTempPassword();
  const row = {
    id: makeId(),
    name: String(name).trim(),
    email: cleanEmail,
    password_hash: hashPassword(tempPassword),
    created_at: new Date().toISOString(),
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, must_change_password, status, is_admin, created_at)
    VALUES (@id, @name, @email, @password_hash, 1, 'active', 0, @created_at)
  `).run(row);

  res.status(201).json({ id: row.id, name: row.name, email: row.email, status: "active", isAdmin: false, mustChangePassword: true, tempPassword });
});

app.patch("/api/employees/:id/status", requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (status !== "active" && status !== "inactive") return res.status(400).json({ error: "status must be 'active' or 'inactive'." });
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "Employee not found." });
  if (target.is_admin) return res.status(400).json({ error: "The admin account's status can't be changed." });
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, target.id);
  if (status === "inactive") destroySessionsForUser(target.id);
  res.json({ ok: true });
});

app.post("/api/employees/:id/reset-password", requireAdmin, (req, res) => {
  const target = db.prepare("SELECT id, name FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "Employee not found." });
  const tempPassword = generateTempPassword();
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?")
    .run(hashPassword(tempPassword), target.id);
  destroySessionsForUser(target.id); // force re-login with the new temp password
  res.json({ ok: true, tempPassword, name: target.name });
});

// ---------- timesheet entries ----------
// GET /api/entries?date=YYYY-MM-DD  -> every employee's row for that date (read-only, visible to any logged-in-or-not viewer per the app's "reference only" design)
app.get("/api/entries", (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date=YYYY-MM-DD is required." });
  const rows = db.prepare("SELECT date, employee_id as employeeId, employee_name as employeeName, hours FROM entries WHERE date = ?").all(date);
  rows.forEach(r => (r.hours = JSON.parse(r.hours)));
  res.json(rows);
});

// POST /api/entries { date, hours: [8 strings] } — always writes to the logged-in user's own row
app.post("/api/entries", requireAuth, (req, res) => {
  const { date, hours } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD." });
  const user = db.prepare("SELECT id, name FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "Account not found." });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO entries (date, employee_id, employee_name, hours, updated_at)
    VALUES (@date, @employeeId, @employeeName, @hours, @updated_at)
    ON CONFLICT(date, employee_id) DO UPDATE SET
      employee_name = excluded.employee_name,
      hours = excluded.hours,
      updated_at = excluded.updated_at
  `).run({ date, employeeId: user.id, employeeName: user.name, hours: JSON.stringify(normalizeHours(hours)), updated_at: now });
  res.json({ ok: true });
});

// GET /api/entries/month/:ym  (ym = YYYY-MM)  optional ?employeeId=...
app.get("/api/entries/month/:ym", (req, res) => {
  const { ym } = req.params;
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: "ym must be YYYY-MM." });
  const { employeeId } = req.query;
  let rows;
  if (employeeId) {
    rows = db.prepare("SELECT date, employee_id as employeeId, employee_name as employeeName, hours FROM entries WHERE date LIKE ? AND employee_id = ?").all(ym + "%", employeeId);
  } else {
    rows = db.prepare("SELECT date, employee_id as employeeId, employee_name as employeeName, hours FROM entries WHERE date LIKE ?").all(ym + "%");
  }
  rows.forEach(r => (r.hours = JSON.parse(r.hours)));
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`TimeFlow running at http://localhost:${PORT}`);
});
