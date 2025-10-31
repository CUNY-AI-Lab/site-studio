# Cloudflare R2 Storage Setup Guide

Site Studio supports two storage modes:
- **Filesystem** (default): Stores projects on the server's local filesystem
- **Cloudflare R2**: Stores projects in Cloudflare R2 object storage for scalability and persistence

## Why Use R2?

### Benefits
- ✅ **Cost-effective**: ~$1-2/month for most use cases vs $47+/month on AWS S3
- ✅ **Zero egress fees**: No bandwidth charges when serving sites to users
- ✅ **Persistent storage**: Projects survive server reboots and restarts
- ✅ **Scalable**: Handles thousands of projects without server storage limits
- ✅ **Global CDN**: Fast delivery worldwide through Cloudflare's network

### Use Cases
- Production deployments
- Multi-server setups (shared storage)
- Long-term project persistence
- High-traffic sites with many users

## Setup Instructions

### Step 1: Create Cloudflare Account

1. Go to [Cloudflare](https://dash.cloudflare.com)
2. Sign up for a free account or log in
3. Navigate to the R2 section in the dashboard

### Step 2: Create R2 Bucket

1. Click **R2** in the left sidebar
2. Click **Create bucket**
3. Enter bucket name: `site-studio` (or your preferred name)
4. Choose location: **Automatic** (recommended for global distribution)
5. Click **Create bucket**

### Step 3: Generate API Tokens

1. In the R2 section, click **Manage R2 API Tokens**
2. Click **Create API Token**
3. Configure the token:
   - **Token name**: `Site Studio Backend`
   - **Permissions**: Select **Object Read & Write**
   - **Specific buckets** (optional): Choose `site-studio` for added security
   - **TTL** (optional): Leave blank for no expiration
4. Click **Create API Token**
5. **IMPORTANT**: Copy the credentials immediately:
   - **Access Key ID**: Starts with a letter, ~32 characters
   - **Secret Access Key**: Long string, ~64 characters
   - **These will NOT be shown again!**

### Step 4: Get Account ID

Your Account ID is needed to construct the R2 endpoint URL.

**Option A: From URL**
- Look at your browser URL while in R2 dashboard
- Format: `https://dash.cloudflare.com/{ACCOUNT_ID}/r2/overview`
- The Account ID is the string between the domain and `/r2/`

**Option B: From Dashboard**
- In R2 Overview page, your Account ID is displayed
- Usually in the format: `1234567890abcdef1234567890abcdef`

### Step 5: Configure Environment Variables

Edit your `.env` file in `packages/backend/`:

```bash
# Storage Configuration
STORAGE_TYPE=r2

# Cloudflare R2 Configuration
R2_ACCOUNT_ID=your-account-id-here
R2_ACCESS_KEY_ID=your-access-key-id-here
R2_SECRET_ACCESS_KEY=your-secret-access-key-here
R2_BUCKET_NAME=site-studio
```

**Example:**
```bash
STORAGE_TYPE=r2
R2_ACCOUNT_ID=1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p
R2_ACCESS_KEY_ID=abc123def456ghi789
R2_SECRET_ACCESS_KEY=xyz789uvw456rst123opq...
R2_BUCKET_NAME=site-studio
```

### Step 6: Test the Setup

1. Start the backend server:
   ```bash
   cd packages/backend
   npm run dev
   ```

2. Look for the startup message:
   ```
   Using R2 storage with bucket: site-studio
   Storage initialized successfully
   ```

3. Create a test project in the UI
4. Verify in Cloudflare R2 dashboard:
   - Go to your bucket
   - You should see files under `projects/{userId}/{projectId}/`

## Switching Between Storage Modes

### To Use Filesystem Storage (Default)
```bash
# In packages/backend/.env
STORAGE_TYPE=filesystem
# or comment out/remove STORAGE_TYPE
```

### To Use R2 Storage
```bash
# In packages/backend/.env
STORAGE_TYPE=r2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=site-studio
```

## Data Migration

### From Filesystem to R2

Currently, migration requires manual upload of existing projects:

1. Locate your existing projects: `packages/backend/sandboxes/`
2. For each user/project directory:
   - Upload files to R2 with key prefix: `projects/{userId}/{projectId}/`

**Automated migration script (coming soon)**

### From R2 to Filesystem

1. Download all files from your R2 bucket
2. Organize into: `packages/backend/sandboxes/{userId}/{projectId}/`
3. Switch `STORAGE_TYPE` back to `filesystem`

## Troubleshooting

### Error: "R2 storage requires R2_ACCOUNT_ID..."

**Cause**: Missing environment variables

**Solution**:
1. Verify all R2 variables are set in `.env`
2. Restart the backend server
3. Check for typos in variable names

### Error: "NoSuchBucket" or "AccessDenied"

**Cause**: Incorrect credentials or bucket doesn't exist

**Solution**:
1. Verify bucket name matches exactly (case-sensitive)
2. Confirm API token has **Object Read & Write** permissions
3. Check Account ID is correct
4. Regenerate API token if needed

### Error: "File not found" after server restart

**Cause**: Mismatch between old filesystem paths and new R2 paths

**Solution**:
1. Projects created in filesystem mode are not automatically migrated
2. Either manually migrate or recreate projects
3. Use consistent `STORAGE_TYPE` for all sessions

### Slow Performance

**Cause**: R2 operations have network latency (~100-300ms vs <1ms for filesystem)

**Expected behavior**: This is normal for cloud storage
- File reads/writes: 100-300ms
- Preview loading: 500ms-2s (first load), faster with CDN caching
- Still acceptable for interactive editing

**Optimization**: Worker caching (see publishing section)

## Cost Estimates

Based on Cloudflare R2 pricing (as of 2025):

### Storage Costs
- **$0.015 per GB/month**
- 100 projects @ 50MB each = 5GB = **$0.08/month**
- 1,000 projects @ 50MB each = 50GB = **$0.75/month**

### Operation Costs
- **Class A** (writes): $4.50 per million operations
- **Class B** (reads): $0.36 per million operations
- Typical usage (100 active users/month):
  - ~100,000 writes = **$0.45**
  - ~500,000 reads = **$0.18**

### Bandwidth
- **$0** - Zero egress fees!
- Unlimited bandwidth to users at no cost

### Total Example Cost
**100 users, 1,000 projects, moderate activity:**
- Storage: $0.75
- Operations: $0.63
- Bandwidth: $0
- **Total: ~$1.40/month**

Compare to AWS S3: ~$47/month for same usage (mostly bandwidth costs!)

## Security Considerations

### API Token Security
- ✅ Never commit `.env` to version control
- ✅ Use separate tokens for development and production
- ✅ Rotate tokens periodically (every 90 days recommended)
- ✅ Scope tokens to specific buckets when possible

### Access Control
- Projects are isolated by user ID
- Path validation prevents directory traversal
- Each user can only access their own projects
- R2 bucket is private by default (not publicly accessible)

### Public Site Serving
For publishing sites publicly, use Cloudflare Workers (see `PUBLISHING.md`)

## Next Steps

Once R2 storage is configured:

1. ✅ Projects persist across server restarts
2. ✅ Scale to thousands of users without storage concerns
3. → Set up Cloudflare Workers for public site hosting (see `PUBLISHING.md`)
4. → Configure custom domains for published sites
5. → Implement backup and versioning strategies

## Support

For issues or questions:
- Check the [GitHub Issues](https://github.com/your-repo/issues)
- Review Cloudflare R2 documentation: https://developers.cloudflare.com/r2/
- Verify environment variables are correctly set
