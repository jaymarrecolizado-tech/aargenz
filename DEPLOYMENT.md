# Deploying the AAR Generator to a Hostinger KVM 2 VPS

Target: Ubuntu 22.04/24.04 VPS · Node serves the built app **and** the API,
MySQL stores users/sessions/reports, nginx terminates HTTPS in front.

```
browser ──HTTPS──> nginx (:80/:443) ──proxy──> node server.js (:3000) ──> MySQL (:3306, local)
                                                 └─ dist/ static files
                                                 └─ templates/<id>/ (configs + uploaded logos)
```

## 1. Provision the server

```bash
sudo apt update && sudo apt upgrade -y
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx mysql-server git certbot python3-certbot-nginx
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

## 2. Create the database and user

```bash
sudo mysql
```
```sql
CREATE DATABASE aar_generator CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'aar'@'localhost' IDENTIFIED BY 'STRONG-PASSWORD-HERE';
GRANT ALL PRIVILEGES ON aar_generator.* TO 'aar'@'localhost';
FLUSH PRIVILEGES;
```

## 3. Get the app onto the server

```bash
sudo mkdir -p /opt/aar && sudo chown $USER /opt/aar
git clone <your-repo-url> /opt/aar        # or upload the folder via SFTP
cd /opt/aar
npm ci                                     # installs exact dependency versions
npm run build                              # vite build -> dist/
```

## 4. Configure environment

The app reads everything from environment variables (never commit secrets).
Create `/etc/aar.env` (root-owned, mode 600):

```ini
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=aar
DB_PASS=STRONG-PASSWORD-HERE
DB_NAME=aar_generator
GROQ_API_KEYS=key1,key2,key3
XAI_API_KEY=optional-fallback-key
AI_PROVIDER=groq
```

| Variable | Purpose |
|---|---|
| `DB_*` | MySQL connection (`db.js`) |
| `GROQ_API_KEYS` | Groq key pool, auto-rotates on 429/401/403 |
| `XAI_API_KEYS` / `XAI_API_KEY` | xAI (Grok) fallback when every Groq key is exhausted |
| `XAI_MODEL` | optional, defaults to `grok-4.6` |
| `CHAT_RATE_MAX` / `CHAT_RATE_REFILL_MS` | per-user rate limiting on `/api/chat` |

> Local dev alternative: `config.js` (gitignored) supplies the same keys when
> env vars are absent. On the VPS prefer the env file above.

## 5. Apply database migrations

```bash
cd /opt/aar && set -a && source /etc/aar.env && set +a
npm run migrate          # creates tables; safe to re-run after pulling updates
```

## 6. Run it as a service (systemd)

`/etc/systemd/system/aar.service`:

```ini
[Unit]
Description=AAR Generator
After=network.target mysql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/aar
EnvironmentFile=/etc/aar.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data:www-data /opt/aar     # app writes templates/<id>/ uploads here
sudo systemctl daemon-reload
sudo systemctl enable --now aar
curl http://127.0.0.1:3000/api/templates     # should return JSON
```

## 7. nginx reverse proxy + HTTPS

`/etc/nginx/sites-available/aar` (replace `aar.yourdomain.gov.ph`):

```nginx
server {
    listen 80;
    server_name aar.yourdomain.gov.ph;

    # Report drafts carry embedded photos as data URLs — allow big JSON bodies.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;          # required for SSE chat streaming
        proxy_read_timeout 300s;      # long AI responses
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/aar /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d aar.yourdomain.gov.ph    # HTTPS + auto-renewal
```

`proxy_buffering off` matters: chat streaming uses Server-Sent Events, which
nginx otherwise buffers into delayed chunks.

## 8. First run

Open `https://aar.yourdomain.gov.ph`, register the **first account** — it
automatically becomes the `admin`. Everyone registering after is an `encoder`.
Admins manage personnel lists, templates, and header/footer logos from the
⚙️ Admin tab; no redeploy needed for those changes.

## 9. Updating

```bash
cd /opt/aar
sudo -u www-data git pull
sudo -u www-data npm ci
sudo -u www-data npm run build
set -a && source /etc/aar.env && set +a && npm run migrate   # if migrations changed
sudo systemctl restart aar
```

## 10. Backups

Two things hold state: the database and the `templates/` directory (template
JSONs + uploaded logos live on disk, not in git once edited through the app).

```bash
# /etc/cron.daily/aar-backup
#!/bin/sh
TS=$(date +%F)
mysqldump -u aar -p'STRONG-PASSWORD-HERE' aar_generator | gzip > /var/backups/aar/db-$TS.sql.gz
tar czf /var/backups/aar/templates-$TS.tar.gz -C /opt/aar templates
find /var/backups/aar -mtime +30 -delete
```

## Notes

- The Node app listens on port 3000 on all interfaces; ufw keeps it private —
  only nginx's 80/443 are exposed.
- Sessions are DB-backed (7-day cookies), so restarts don't log anyone out.
- The rate limiter bucket is in-memory and resets on service restart (harmless).
- `api/chat.cjs` is the legacy serverless variant kept only for optional Vercel
  deploys — the VPS path ignores it.
