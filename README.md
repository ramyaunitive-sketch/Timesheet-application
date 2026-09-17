# TimeFlow Timesheets (self-hosted)

Your TimeFlow design, now backed by a real server: an actual database, real password checks, and
hashed passwords — instead of an in-memory JavaScript array that reset every time the page refreshed.

## What changed from your original file

Your original HTML was a great mockup of the *flow*, but it was 100% client-side:

- Nothing was saved anywhere — refresh the page and all employees and timesheet entries vanished.
- The login screen didn't actually check the password at all (typing anything, or nothing, still
  logged you in) — a real security hole.
- Passwords were stored in plain text in a JavaScript variable, visible to anyone with the browser's
  dev tools open.

This version keeps your exact design, layout, and flow (the lime theme, the 8-hour grid, the
dashboard, monthly report, employee management) and fixes all three: a SQLite database on the
server, real password verification, and salted/hashed passwords that are never stored or sent in
plain text after the first temporary one.

## What's in here

```
server.js           Express API + serves the frontend
public/index.html   The whole UI (your original design, rewired to call the API)
data/                SQLite database file lives here at runtime (created automatically)
Dockerfile           For container-based deployment
.env.example         Copy to .env and fill in
```

## Run it locally

Requires Node.js 18 or later.

```bash
npm install
cp .env.example .env
npm start
```

The first time it starts, it prints something like:

```
First-time setup — sign in as admin@company.com with password:
4CTBCafH3H
```

Open **http://localhost:3000**, pick "System Admin (Admin)" from the dropdown, and log in with that
password. You'll be asked to set your own password immediately — no separate "current password"
step needed, since logging in with the temp password already proved it's you.

## How login and passwords work

- **The admin account** is `admin@company.com`, seeded automatically on first run with either a
  random password (printed to the console) or whatever you set as `ADMIN_DEFAULT_PASSWORD` in
  `.env`. Either way, it's forced to change on first login.
- **Adding an employee** (Employee Management → + Add New Employee) generates a random temporary
  password, shown once in a copy-able banner right in the page — share it with that person
  directly. They log in with it and are immediately asked to set their own.
- **Forgot password**: admin opens Employee Management, picks the person from "User Password
  Control", clicks **Reset Password** — a new temporary password is generated and shown the same
  way, and the old one stops working immediately.
- **Forgot the admin password specifically**: there's no self-serve reset for a single admin
  account. Instead: set `ADMIN_RESET_PASSWORD=something` in `.env` (or as an environment variable
  on your host), restart the server once, log in with that value, set a new password, then remove
  `ADMIN_RESET_PASSWORD` again (otherwise it keeps resetting on every restart).
- Passwords are hashed with salted scrypt before they touch the database — never stored or logged
  in plain text after that first temporary value.
- Sessions are kept in memory and last 30 days, but are also saved to the browser's local storage
  so a page refresh doesn't log you out. Restarting the server does log everyone out (they just log
  back in).

## Deactivating vs. removing employees

This design uses **status** (active/inactive) rather than deleting people outright, so history is
never lost. Employee Management → click the status badge next to someone's name to toggle it.
Deactivated employees can't log in and disappear from the timesheet grid, but their past entries
stay in the reports.

## Deployment options

### Option A — A simple VPS (DigitalOcean, Linode, EC2, etc.)

```bash
# on the server
git clone <your-repo-url> timeflow-app
cd timeflow-app
npm install --omit=dev
cp .env.example .env
npm install -g pm2
pm2 start server.js --name timeflow
pm2 save
pm2 startup            # follow the printed instructions so it restarts on reboot
```

Put Nginx in front of it for your own domain and HTTPS:

```nginx
server {
    listen 80;
    server_name timesheets.yourcompany.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then `certbot --nginx -d timesheets.yourcompany.com` for a free TLS certificate.

### Option B — Docker (any host that runs containers)

```bash
docker build -t timeflow-app .
docker run -d \
  --name timeflow-app \
  -p 3000:3000 \
  -e ADMIN_DEFAULT_PASSWORD=your-chosen-first-password \
  -v timeflow-data:/app/data \
  timeflow-app
```

The named volume (`timeflow-data`) keeps your database across container restarts/upgrades.

### Option C — Platform-as-a-service (Render, Railway, Fly.io)

1. Push this folder to a GitHub repo.
2. Create a new "Web Service" from that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Optionally set `ADMIN_DEFAULT_PASSWORD` as an environment variable (otherwise a random one is
   generated and shown in the service's logs on first boot — check there for it).
5. Attach a persistent disk/volume mounted at `/app/data` (matching `DB_PATH`) so the database
   survives redeploys — without this, some platforms wipe the filesystem on every deploy and you'd
   lose all your data.

## Updating the app later

The frontend is one file (`public/index.html`) and the API is one file (`server.js`) — both are
plain enough to hand-edit directly. If you change the database schema, add a migration step in
`server.js`'s startup `db.exec(...)` block using `CREATE TABLE IF NOT EXISTS` so existing data
isn't lost on restart.
