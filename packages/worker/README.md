# Site Studio Publisher Worker

Cloudflare Worker that serves published Site Studio projects from R2 storage.

## Overview

This worker enables public access to published Site Studio projects. When a user publishes their project, it becomes accessible via a workers.dev URL.

**URL Format**: `https://site-studio-publisher.{subdomain}.workers.dev/{userId}/{projectId}/`

## Features

- Serves static sites from Cloudflare R2
- Automatic `index.html` routing (e.g., `/about/` → `/about/index.html`)
- Proper Content-Type headers for all file types
- Custom 404 error pages (if provided)
- Cache optimization (different cache times for HTML vs assets)
- Zero egress costs (Cloudflare R2 + Workers)

## Prerequisites

1. Cloudflare account (free tier works)
2. R2 bucket created: `site-studio`
3. Wrangler CLI installed: `npm install -g wrangler`

## Setup

### 1. Install Dependencies

```bash
cd packages/worker
npm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

This opens a browser to authenticate.

### 3. Configure R2 Bucket Binding

The `wrangler.toml` already references the `site-studio` bucket. Make sure this bucket exists in your Cloudflare account:

```bash
# Check if bucket exists
wrangler r2 bucket list

# Create if needed
wrangler r2 bucket create site-studio
```

### 4. Deploy the Worker

```bash
# Deploy to production
npm run deploy

# Or deploy to development environment
wrangler deploy --env development
```

### 5. Get Your Worker URL

After deployment, Wrangler will output your worker URL:

```
Published site-studio-publisher
  https://site-studio-publisher.{your-subdomain}.workers.dev
```

### 6. Update Backend Configuration

Add the worker name to your backend `.env` file:

```bash
# In packages/backend/.env
WORKER_NAME=publisher  # or whatever you named your worker
```

This ensures the backend generates correct public URLs when users publish projects.

## Development

### Run Locally

```bash
npm run dev
```

This starts a local dev server at `http://localhost:8787`

You can test locally by visiting:
- `http://localhost:8787/{userId}/{projectId}/`

### View Logs

```bash
npm run tail
```

Shows real-time logs from your deployed worker.

## How It Works

1. **User publishes project**: Backend API updates project metadata with `published: true`
2. **Files already in R2**: Project files are already stored at `projects/{userId}/{projectId}/`
3. **Worker serves files**: Requests to worker URL fetch files from R2 and return them
4. **Caching**: Assets cached for 24h, HTML for 5 minutes

### Request Flow

```
User visits: https://site-studio-publisher.workers.dev/abc123/my-site/
                                    ↓
Worker receives request, parses URL: userId=abc123, projectId=my-site
                                    ↓
Worker fetches from R2: projects/abc123/my-site/index.html
                                    ↓
Returns HTML with proper headers and caching
```

## File Routing

The worker handles several routing scenarios:

1. **Direct file**: `/styles.css` → `projects/{userId}/{projectId}/styles.css`
2. **Index routing**: `/` → `projects/{userId}/{projectId}/index.html`
3. **Directory index**: `/about/` → `projects/{userId}/{projectId}/about/index.html`
4. **Clean URLs**: `/about` → tries `about.html`, then `about/index.html`

## 404 Handling

If a file isn't found:
1. Checks if custom `404.html` exists in the project
2. Serves custom 404 if available
3. Otherwise, serves default 404 page

## Cache Strategy

- **HTML files**: 5 minutes (allows quick updates)
- **Assets** (CSS, JS, images, fonts): 24 hours (static assets)
- **Other files**: 1 hour (default)

## Security

- Worker only serves files from published projects
- User isolation maintained (files stored under `projects/{userId}/`)
- No write access (read-only from R2)
- No directory listing (only explicit file requests)

## Custom Domains (Optional)

To use a custom domain instead of workers.dev:

1. Add your domain to Cloudflare
2. Update `wrangler.toml`:

```toml
routes = [
  { pattern = "*.yoursite.com/*", zone_name = "yoursite.com" }
]
```

3. Redeploy: `npm run deploy`

Now sites will be available at: `{projectId}.{userId}.yoursite.com`

## Cost

- **Worker**: Free tier includes 100,000 requests/day
- **R2 reads**: $0.36 per million requests
- **R2 egress**: $0 (zero!)

Expected cost: **$0-2/month** for most use cases.

## Troubleshooting

### Worker returns "Project not found"

- Check that project is actually published (metadata `published: true`)
- Verify files exist in R2 at `projects/{userId}/{projectId}/`
- Check R2 bucket name matches in `wrangler.toml`

### Wrong MIME types

- Worker has built-in MIME type detection
- If missing, add to `getContentType()` function in `index.ts`

### Deploy fails

```bash
# Ensure you're logged in
wrangler login

# Check your account
wrangler whoami

# Verify bucket exists
wrangler r2 bucket list
```

## Architecture

```
┌─────────────────┐
│   Site Studio   │
│   (Backend)     │
│                 │
│  User clicks    │
│  "Publish"      │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│   Update R2     │
│   Metadata:     │
│  published=true │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ User visits URL │
│  via Worker     │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Worker fetches  │
│  from R2 and    │
│  serves file    │
└─────────────────┘
```

## Next Steps

- Add custom domain support
- Implement analytics (Cloudflare Analytics)
- Add password protection for private sites
- Implement automatic SSL for custom domains
- Add CDN cache purging on republish
