# Deploying OpenMail

This runs OpenMail behind Caddy with Docker Compose on one Linux server. Caddy
gets a Let's Encrypt certificate automatically and proxies HTTPS to the
OpenMail container, which has no published ports.

## What you need

- A Linux server (tested on Ubuntu 24.04) with ports 80 and 443 open to the internet.
- A DNS A record for your hostname (for example `mcp.openmail.tools`) pointing
  at the server. If you use Cloudflare, set it to **DNS only** (grey cloud) so
  Caddy can complete the ACME challenge and SSE streams are not buffered.
- Outbound access from the server to your mail providers (IMAP 993, SMTP 465/587).

## 1. Install Docker Engine and the Compose plugin

Use Docker's official apt repository (https://docs.docker.com/engine/install/ubuntu/):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

## 2. Put the code on the server

Any clean copy of the repository works. From a machine that has the repo:

```bash
git archive --format=tar HEAD | ssh your-server 'mkdir -p /opt/openmail && tar -x -C /opt/openmail'
```

This avoids putting Git credentials on the server.

## 3. Create the secrets file

On the server, in `/opt/openmail`:

```bash
cd /opt/openmail
umask 077
cp .env.example .env
# Fill in real values without printing them:
sed -i "s|^OPENMAIL_MASTER_KEY=.*|OPENMAIL_MASTER_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^OPENMAIL_DEMO_PASSWORD=.*|OPENMAIL_DEMO_PASSWORD=$(openssl rand -hex 24)|" .env
chmod 600 .env
```

Edit `OPENMAIL_DOMAIN`, `OPENMAIL_ROOT_DOMAIN` and `OPENMAIL_PUBLIC_URL` if you use a different hostname.
`.env` is gitignored. Never commit it and never paste it into chat or tickets.
Back up `.env` together with the `openmail-data` volume: without the master key
the stored mailbox passwords cannot be decrypted.

`deploy/openmail.toml` runs multi-user mode: people sign up at `/`, add their
own mailboxes and create API keys. The `demo-mail` service is an optional
GreenMail server on an internal-only network for marketplace reviewers; remove
it and the `OPENMAIL_DEMO_*` / `OPENMAIL_INSECURE_IMAP_HOSTS` lines if you do
not need it.

## 4. Start it

```bash
docker compose up -d --build
docker compose ps          # openmail should be "healthy"
docker compose logs caddy  # look for "certificate obtained successfully"
```

Both services use `restart: unless-stopped`, so they come back after a reboot
(Docker itself is enabled at boot by `systemctl enable docker`).

## 5. Check it

```bash
curl -s https://mcp.openmail.tools/healthz          # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.openmail.tools/mcp   # 401
```

Open `https://mcp.openmail.tools/`, sign up, add a mailbox, create an API key,
then add it to your MCP client as a streamable HTTP server:

- URL: `https://mcp.openmail.tools/mcp`
- Header: `Authorization: Bearer <your key>`

## Operator tasks (admin CLI)

Run inside the container. Secrets go in on stdin, never as arguments:

```bash
cd /opt/openmail
docker compose exec -T openmail node dist/cli/admin.js list-users
openssl rand -base64 24 | tee /root/new-user-login | \
  docker compose exec -T openmail node dist/cli/admin.js create-user --email someone@example.com
chmod 600 /root/new-user-login
```

### Reviewer demo mailbox

Create the reviewer user as above, then attach the demo mailbox (the password
is read from the container's own environment):

```bash
docker compose exec -T openmail node dist/cli/admin.js add-account \
  --user reviewer@example.com --name "Demo mailbox" --email demo@demo.openmail.tools \
  --preset custom --imap-host demo-mail --imap-port 3143 --plain --username demo \
  --password-env OPENMAIL_DEMO_PASSWORD
```

OpenMail seeds the demo mailbox with fictional messages on start and re-checks
every 2 minutes (`OPENMAIL_DEMO_RESEED_SECONDS`), so it refills itself after GreenMail restarts.

### Moving from single-user mode

1. Back up: `cp .env /root/env.bak; cp deploy/openmail.toml /root/openmail.toml.bak`.
2. Switch `deploy/openmail.toml` to `mode = "multi"` and set `OPENMAIL_MODE=multi` in `.env`.
3. `docker compose up -d --build`, then create a user with `create-user`.
4. Re-add each mailbox with `add-account ... --password-env <the old password_env name>`.
5. Keep existing bearer keys working: pipe each one into `import-key --user <email> --name <label>`.
6. Remove the old `OPENMAIL_API_KEYS` and mailbox password lines from `.env` and recreate the container.

## Updating

```bash
git archive --format=tar HEAD | ssh your-server 'tar -x -C /opt/openmail'
ssh your-server 'cd /opt/openmail && docker compose up -d --build'
```

`.env` and the Docker volumes (`openmail-data`, `caddy-data`) are kept.

## Notes

- Docker publishes 80/443 directly; host firewall rules for other ports still apply.
- Caddy also serves `openmail.tools` and `www.openmail.tools` as redirects. Each name gets its own certificate, so if their DNS is not pointed at the server yet, only those two fail (Caddy retries with backoff) and the main site keeps working.
- Caddy redacts `Authorization` headers in its logs by default. OpenMail never logs keys, passwords or message bodies.
- Back up the `openmail-data` volume and `.env` together. Without the master key the encrypted credential store cannot be read.
