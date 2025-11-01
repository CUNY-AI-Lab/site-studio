# Publishing Sites with Site Studio

This guide explains how to publish Site Studio projects so they're publicly accessible on the web.

## Overview

Site Studio uses Cloudflare Workers and R2 storage to serve published sites for **free** with zero egress costs. When a user publishes a project, it becomes available at a public URL that anyone can visit.

**Architecture**:
- **Files stored in R2**: Project files are already in R2 (no copying needed)
- **Cloudflare Worker**: Serves files from R2 when users visit public URLs
- **Backend API**: Tracks which projects are published
- **Frontend UI**: Publish button in project dropdown menu

## Setup (One-Time)

### 1. Deploy the Cloudflare Worker

The worker serves published sites from R2. You need to deploy it once:

```bash
cd packages/worker
npm install
npx wrangler login
npx wrangler deploy
```

After deployment, you'll see output like:
```
Published site-studio-publisher (0.42 sec)
  https://site-studio-publisher.{your-subdomain}.workers.dev
```

**Important**: Copy the worker name from the URL. In the example above, it's just `publisher` (the part between `site-studio-` and `.workers.dev`).

### 2. Configure Backend

Update `packages/backend/.env` with your worker name:

```bash
# Publishing Configuration
WORKER_NAME=publisher  # Use the name from your deployed worker
```

### 3. Restart Backend Server

The backend needs to restart to pick up the new environment variable:

```bash
cd packages/backend
npm run dev
```

## Publishing a Project

### From the UI

1. Go to the Site Studio dashboard
2. Find the project you want to publish
3. Click the three-dot menu (⋮) on the project card
4. Select **"Publish"**
5. Wait a moment for the publishing to complete
6. The project card will show a **"Published"** badge
7. Click the menu again and select **"View Published Site"** to open it

### Unpublishing

1. Click the three-dot menu (⋮) on a published project
2. Select **"Unpublish"**
3. The site becomes private again

## Public URLs

Published sites are available at:

```
https://site-studio-{worker-name}.{your-subdomain}.workers.dev/{userId}/{projectId}/
```

**Example**:
```
https://site-studio-publisher.myaccount.workers.dev/abc123/my-portfolio/
```

### URL Routing

The worker handles intelligent routing:

| Requested URL | Serves |
|---------------|--------|
| `/` | `index.html` |
| `/about/` | `about/index.html` |
| `/about` | `about.html` or `about/index.html` |
| `/styles.css` | `styles.css` |
| `/images/logo.png` | `images/logo.png` |

## How It Works

### Publishing Flow

```
User clicks "Publish"
        ↓
Backend: POST /api/projects/:id/publish
        ↓
Update metadata in R2: published=true, publishedUrl=...
        ↓
Return public URL
        ↓
Frontend: Show "Published" badge
```

### Serving Flow

```
User visits: https://site-studio-publisher.workers.dev/abc123/my-site/
        ↓
Cloudflare Worker intercepts request
        ↓
Parse URL: userId=abc123, projectId=my-site, path=index.html
        ↓
Fetch from R2: projects/abc123/my-site/index.html
        ↓
Return HTML with proper headers
```

### Caching Strategy

The worker uses smart caching to optimize performance:

- **HTML files**: 5 minutes (allows quick updates)
- **Assets** (CSS, JS, images, fonts): 24 hours (static assets rarely change)
- **Other files**: 1 hour (default)

This means:
- Users see changes within 5 minutes of republishing
- Assets load instantly from CDN cache
- Minimal R2 read operations (cost savings)

## Security & Privacy

### What's Public?

- Only files in published projects are accessible
- Unpublished projects remain completely private
- No directory listing (users can't browse files)

### User Isolation

- Each user's files are in separate R2 paths: `projects/{userId}/`
- One user cannot access another user's projects
- Worker validates paths to prevent directory traversal

### Access Control

Currently, published sites are **publicly accessible** to anyone with the URL. Future enhancements may include:
- Password protection for individual sites
- Access logs and analytics
- Expiring publish links
- Custom domain mapping with SSL

## Costs

### Cloudflare Workers
- **Free tier**: 100,000 requests/day
- **Paid**: $5/month for 10 million requests

### Cloudflare R2
- **Storage**: $0.015 per GB/month
- **Read operations**: $0.36 per million requests
- **Egress**: **$0** (zero!)

### Example Costs

**Scenario**: 100 published sites, 10,000 views/day

- Storage (100 sites × 50MB): $0.08/month
- R2 reads (10k × 30 days): $0.11/month
- Workers (free tier): $0/month
- Egress: $0/month
- **Total: ~$0.20/month**

Compare to AWS S3 with same traffic: **~$50/month** (mostly egress fees!)

## Troubleshooting

### "Worker not deployed" Error

**Problem**: Publishing returns an error about worker not being deployed

**Solution**:
1. Deploy the worker: `cd packages/worker && npx wrangler deploy`
2. Update `WORKER_NAME` in backend `.env`
3. Restart backend server

### Published Site Shows 404

**Problem**: Visiting the public URL shows "Project not found"

**Possible causes**:
1. Project isn't actually published (check for "Published" badge)
2. Worker can't access R2 bucket (check bucket name in wrangler.toml)
3. Files don't exist in R2 (check R2 dashboard)

**Solution**:
```bash
# Verify R2 bucket binding
cd packages/worker
npx wrangler r2 bucket list

# Check if bucket exists
# If not, create it:
npx wrangler r2 bucket create site-studio
```

### Wrong URL Format

**Problem**: Backend generates wrong worker URL

**Solution**: Check `WORKER_NAME` in `.env` matches your actual worker name:

```bash
# Get your worker URL
cd packages/worker
npx wrangler deployments list

# Update .env with the correct name
WORKER_NAME=publisher  # or whatever your actual worker is named
```

### Styles/Images Not Loading

**Problem**: HTML loads but CSS/JS/images show 404

**Possible causes**:
1. Incorrect file paths in HTML (e.g., `/styles.css` vs `styles.css`)
2. Files not uploaded to R2
3. Content-Type header incorrect

**Solution**:
- Use relative paths in HTML: `<link href="styles.css">` (not `/styles.css`)
- Check files exist in R2 dashboard under `projects/{userId}/{projectId}/`
- Worker automatically detects content types based on file extension

### Slow Loading After Publishing

**Problem**: Site is slow to load after publishing

**This is normal!** The first load:
1. Fetches files from R2 (~200-500ms)
2. Establishes CDN cache
3. Returns content to user

Subsequent loads are much faster:
- Cached at Cloudflare edge (< 50ms globally)
- No R2 fetches needed

If it's persistently slow, check:
- R2 bucket region (should be "auto" for global distribution)
- Image optimization (large images should be compressed)
- Bundle size (minimize CSS/JS files)

## Advanced Features

### Custom Domains

To use your own domain instead of workers.dev:

1. Add your domain to Cloudflare
2. Update `packages/worker/wrangler.toml`:
   ```toml
   routes = [
     { pattern = "*.yoursite.com/*", zone_name = "yoursite.com" }
   ]
   ```
3. Redeploy: `npx wrangler deploy`
4. Update backend to generate custom URLs

### Analytics

View worker analytics in Cloudflare Dashboard:
- Requests per day
- Error rates
- Cache hit ratios
- Geographic distribution

### Preview Before Publishing

Currently not implemented. Future enhancement:
- Staging URL for testing before publishing
- Compare published vs current version
- Rollback to previous version

## API Reference

### Publish Project

```http
POST /api/projects/:id/publish
```

**Response**:
```json
{
  "success": true,
  "message": "Project published successfully",
  "url": "https://site-studio-publisher.workers.dev/abc123/my-site/"
}
```

### Unpublish Project

```http
POST /api/projects/:id/unpublish
```

**Response**:
```json
{
  "success": true,
  "message": "Project unpublished successfully"
}
```

### Get Project Status

```http
GET /api/projects
```

**Response**:
```json
{
  "projects": [
    {
      "id": "my-site",
      "name": "My Portfolio",
      "published": true,
      "publishedUrl": "https://site-studio-publisher.workers.dev/abc123/my-site/"
    }
  ]
}
```

## Worker Configuration

The worker is configured in `packages/worker/wrangler.toml`:

```toml
name = "site-studio-publisher"
main = "index.ts"
compatibility_date = "2024-01-01"
workers_dev = true

[[r2_buckets]]
binding = "SITE_STUDIO_BUCKET"
bucket_name = "site-studio"
```

**Important settings**:
- `name`: Worker name (appears in URL)
- `workers_dev`: Enables free workers.dev subdomain
- `r2_buckets`: Binds R2 bucket to worker

## Next Steps

Once publishing is working:

1. **Add User Authentication** (planned)
   - Proper accounts instead of cookie-based sessions
   - Users can access projects from any device
   - Required for cross-device publishing

2. **Analytics Dashboard** (planned)
   - Page views per published site
   - Popular pages
   - Visitor geography

3. **Custom Domains** (planned)
   - Use your own domain: `mysite.com`
   - Automatic SSL certificates
   - DNS management UI

4. **Version Control** (planned)
   - Snapshot versions on publish
   - Rollback to previous versions
   - Compare changes between versions

5. **Collaboration** (planned)
   - Share edit access with other users
   - Comments and feedback
   - Activity history

## Support

For issues:
- Check the [GitHub Issues](https://github.com/your-repo/issues)
- Review worker logs: `cd packages/worker && npx wrangler tail`
- Check R2 storage: Cloudflare Dashboard > R2
- Verify backend logs for publish/unpublish errors

## Summary

Publishing in Site Studio is designed to be:
- **Simple**: One click to publish, one click to unpublish
- **Fast**: Global CDN with edge caching
- **Cheap**: ~$0-2/month for most use cases
- **Secure**: User isolation, no directory listing
- **Reliable**: Cloudflare's infrastructure (99.99% uptime)

The combination of R2 storage + Workers means zero egress fees and lightning-fast delivery worldwide!
