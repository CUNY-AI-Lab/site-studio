#!/usr/bin/env npx tsx
/**
 * Ad-hoc script to find orphaned projects in R2 storage
 *
 * An orphaned project is one where the owner user ID has no active session.
 * This can happen when:
 * - Sessions expire (30 day TTL)
 * - Projects were created in old system/regime before proper session management
 * - User deleted their cookies/session
 *
 * Usage:
 *   cd packages/backend
 *   npx tsx scripts/find-orphans.ts
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env from backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

interface StoredSession {
  user: {
    id: string;
    createdAt: string;
  };
  expiresAt: string;
}

async function main() {
  // Validate environment
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || 'site-studio';

  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.error('❌ Missing R2 credentials in .env file');
    process.exit(1);
  }

  console.log('🔍 Finding orphaned projects in R2...\n');
  console.log(`Bucket: ${bucketName}`);
  console.log(`Account: ${accountId}\n`);

  // Initialize R2 client
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  // Step 1: Get all user IDs with active sessions
  console.log('📋 Step 1: Listing active sessions...');
  const sessionsResponse = await client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: 'sessions/',
    })
  );

  const activeUserIds = new Set<string>();
  const sessions = sessionsResponse.Contents || [];

  for (const session of sessions) {
    if (!session.Key) continue;

    try {
      // Read session to get user ID
      const getResponse = await client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: session.Key,
        })
      );

      const body = await getResponse.Body?.transformToString();
      if (!body) continue;

      const stored: StoredSession = JSON.parse(body);

      // Check if session is still valid
      const expiresAt = new Date(stored.expiresAt);
      if (expiresAt > new Date()) {
        activeUserIds.add(stored.user.id);
      }
    } catch (error) {
      // Skip invalid sessions
      continue;
    }
  }

  console.log(`✓ Found ${activeUserIds.size} active sessions`);
  console.log(`  User IDs: ${Array.from(activeUserIds).join(', ')}\n`);

  // Step 2: Get all user IDs that own projects
  console.log('📋 Step 2: Listing all project owners...');
  const projectsResponse = await client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: 'projects/',
      Delimiter: '/',
    })
  );

  const projectOwnerIds = new Set<string>();
  const prefixes = projectsResponse.CommonPrefixes || [];

  for (const prefix of prefixes) {
    if (!prefix.Prefix) continue;
    // Extract userId from: projects/user_xxx/
    const userId = prefix.Prefix.split('/')[1];
    projectOwnerIds.add(userId);
  }

  console.log(`✓ Found ${projectOwnerIds.size} users with projects\n`);

  // Step 3: Find orphaned users (have projects but no active session)
  console.log('🔍 Step 3: Identifying orphaned users...\n');

  const orphanedUserIds = Array.from(projectOwnerIds).filter(
    userId => !activeUserIds.has(userId)
  );

  if (orphanedUserIds.length === 0) {
    console.log('✅ No orphaned projects found! All projects have active sessions.\n');
    return;
  }

  console.log(`⚠️  Found ${orphanedUserIds.length} orphaned users:\n`);

  // Step 4: List projects for each orphaned user
  let totalOrphanedProjects = 0;

  for (const userId of orphanedUserIds) {
    console.log(`👤 ${userId}`);

    // List this user's projects
    const userProjectsResponse = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `projects/${userId}/`,
        Delimiter: '/',
      })
    );

    const userProjectPrefixes = userProjectsResponse.CommonPrefixes || [];
    const projectNames: string[] = [];

    for (const prefix of userProjectPrefixes) {
      if (!prefix.Prefix) continue;
      // Extract project name from: projects/user_xxx/project-name/
      const parts = prefix.Prefix.split('/');
      const projectName = parts[2];
      if (projectName) {
        projectNames.push(projectName);
      }
    }

    totalOrphanedProjects += projectNames.length;
    console.log(`   Projects (${projectNames.length}): ${projectNames.join(', ')}`);
    console.log('');
  }

  // Summary
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Summary:');
  console.log(`   Active users: ${activeUserIds.size}`);
  console.log(`   Total users with projects: ${projectOwnerIds.size}`);
  console.log(`   Orphaned users: ${orphanedUserIds.length}`);
  console.log(`   Total orphaned projects: ${totalOrphanedProjects}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
