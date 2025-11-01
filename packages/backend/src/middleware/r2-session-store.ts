/**
 * R2-based session storage for Site Studio
 * Stores sessions in Cloudflare R2 for persistence across server restarts
 */

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { ISessionStore, User, StoredSession } from './session-store.js';

export class R2SessionStore implements ISessionStore {
  private client: S3Client;
  private bucketName: string;

  constructor(accountId: string, accessKeyId: string, secretAccessKey: string, bucketName: string) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    this.bucketName = bucketName;
  }

  /**
   * Get session key in R2
   */
  private getKey(sessionId: string): string {
    return `sessions/${sessionId}.json`;
  }

  /**
   * Get a session by ID
   */
  async get(sessionId: string): Promise<User | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: this.getKey(sessionId),
      });

      const response = await this.client.send(command);
      const body = await response.Body?.transformToString();

      if (!body) {
        return null;
      }

      const stored: StoredSession = JSON.parse(body);

      // Check if session has expired
      const expiresAt = new Date(stored.expiresAt);
      if (expiresAt < new Date()) {
        // Session expired, delete it
        await this.delete(sessionId);
        return null;
      }

      // Deserialize dates
      stored.user.createdAt = new Date(stored.user.createdAt);

      return stored.user;
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Set/update a session
   */
  async set(sessionId: string, user: User, ttlDays: number = 30): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + ttlDays);

    const stored: StoredSession = {
      user,
      expiresAt,
    };

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: this.getKey(sessionId),
      Body: JSON.stringify(stored),
      ContentType: 'application/json',
    });

    await this.client.send(command);
  }

  /**
   * Delete a session
   */
  async delete(sessionId: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: this.getKey(sessionId),
    });

    await this.client.send(command);
  }

  /**
   * Get count of active sessions
   */
  async count(): Promise<number> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: 'sessions/',
    });

    const response = await this.client.send(command);
    return response.KeyCount || 0;
  }

  /**
   * Clean up expired sessions
   */
  async cleanup(): Promise<number> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: 'sessions/',
    });

    const response = await this.client.send(command);
    const objects = response.Contents || [];

    let cleanedCount = 0;
    const now = new Date();

    for (const obj of objects) {
      if (!obj.Key) continue;

      const sessionId = obj.Key.replace('sessions/', '').replace('.json', '');

      try {
        const user = await this.get(sessionId);
        if (!user) {
          // Session was expired and already deleted by get()
          cleanedCount++;
        }
      } catch (error) {
        console.error(`Error cleaning up session ${sessionId}:`, error);
      }
    }

    return cleanedCount;
  }
}
