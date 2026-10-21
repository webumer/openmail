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
KEY=$(openssl rand -hex 32)
sed -i "s|^OPENMAIL_API_KEYS=.*|OPENMAIL_API_KEYS=$KEY|" .env
printf '%s\n' "$KEY" > /root/openmail-api-key && chmod 600 /root/openmail-api-key
unset KEY
chmod 600 .env
```

Edit `OPENMAIL_DOMAIN` and `OPENMAIL_PUBLIC_URL` if you use a different hostname.
`.env` is gitignored. Never commit it and never paste it into chat or tickets.

`deploy/openmail.toml` runs single-user mode with no mailbox accounts. To add a
mailbox, append an `[[accounts]]` block (see `config.example.toml`) and put the
password in `.env` under the variable named by `password_env`.

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

Then add it to your MCP client as a streamable HTTP server:

- URL: `https://mcp.openmail.tools/mcp`
- Header: `Authorization: Bearer <the key in /root/openmail-api-key>`

## Updating

```bash
git archive --format=tar HEAD | ssh your-server 'tar -x -C /opt/openmail'
ssh your-server 'cd /opt/openmail && docker compose up -d --build'
```

`.env` and the Docker volumes (`openmail-data`, `caddy-data`) are kept.

## Notes

- Docker publishes 80/443 directly; host firewall rules for other ports still apply.
- Caddy redacts `Authorization` headers in its logs by default. OpenMail never logs keys, passwords or message bodies.
- Back up the `openmail-data` volume and `.env` together. Without the master key the encrypted credential store cannot be read.
