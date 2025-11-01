# Deploying Site Studio on Fly.io

This guide deploys the builder (frontend + API) as a single container on Fly.io. Published sites are still served via Cloudflare R2 + Worker (see `PUBLISHING.md`).

## Prerequisites
- Fly CLI installed: https://fly.io/docs/hands-on/install-flyctl/
- Fly account and org
- Cloudflare R2 bucket + API keys (see `R2_SETUP.md`)

## One‑time setup

```
# Authenticate
fly auth login

# Create app (choose a unique name), no deploy yet
fly launch --no-deploy --copy-config
# If prompted for a builder, choose Dockerfile
```

The repo includes:
- `Dockerfile` (multi‑stage build: builds frontend + backend)
- `fly.toml` (service on port 3001)

## Configure secrets

Set production env vars and secrets. Replace values accordingly.

```
# Core
fly secrets set \
  NODE_ENV=production \
  PORT=3001 \
  FRONTEND_URL=https://<your-app>.fly.dev

# Storage (R2)
fly secrets set \
  STORAGE_TYPE=r2 \
  R2_ACCOUNT_ID=<cf-account-id> \
  R2_ACCESS_KEY_ID=<cf-access-key> \
  R2_SECRET_ACCESS_KEY=<cf-secret-key> \
  R2_BUCKET_NAME=site-studio

# Internal token used for server-to-server calls (safe random)
fly secrets set INTERNAL_AUTH_TOKEN=$(openssl rand -hex 16)
```

Optional:
- `WORKER_SUBDOMAIN=<your-workers-subdomain>` to customize publish URLs

## Deploy

```
fly deploy
```

Verify deployment:
- App URL: `https://<your-app>.fly.dev` (frontend)
- API is served at `/api` on the same domain

## Notes
- Cookies: same‑origin requests keep auth simple (`SameSite=Lax`).
- Storage: production should use `STORAGE_TYPE=r2`. If you must use local FS (not recommended), add a volume mount in `fly.toml` and mount to your desired data dir; update `SANDBOXES_DIR` env.
- Scale: by default, Machines scale to 0 when idle. To keep a machine warm, set `min_machines_running = 1` under `[http_service]` in `fly.toml`.
- Logs: `fly logs`

## Publishing sites
- Deploy the Cloudflare Worker in `packages/worker` (see `PUBLISHING.md`).
- Use the Site Studio UI to publish/unpublish. Public sites are served from the Worker via R2.

---

If you want custom domains, map them to the Fly app and update `FRONTEND_URL` to the new domain.

