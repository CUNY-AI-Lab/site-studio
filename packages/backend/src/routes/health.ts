import { Request, Response } from 'express';
import { getStorage } from '../storage/index.js';
import { getSessionStoreInstance } from '../middleware/auth.js';

/**
 * GET /health
 * Basic liveness check - returns 200 if the server is running
 * Used by load balancers and monitoring systems
 */
export async function healthCheck(req: Request, res: Response) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}

/**
 * GET /health/ready
 * Readiness check - verifies that dependencies are available
 * Returns 503 if any critical dependency is unavailable
 */
export async function readinessCheck(req: Request, res: Response) {
  const checks = {
    storage: false,
    sessions: false,
    ai: false,
  };

  const errors: string[] = [];

  // Check storage
  try {
    const storage = getStorage();
    // Try a simple operation to verify storage is accessible
    await storage.projectExists('health-check', 'test');
    checks.storage = true;
  } catch (error) {
    errors.push(`Storage check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Check session store
  try {
    const sessionStore = getSessionStoreInstance();
    // Try to get a non-existent session to verify store is accessible
    await sessionStore.get('health-check');
    checks.sessions = true;
  } catch (error) {
    errors.push(`Session store check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Check AI provider configuration
  const usesBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === '1';
  const usesVertex = process.env.CLAUDE_CODE_USE_VERTEX === '1';

  if (usesBedrock) {
    checks.ai = !!(
      process.env.AWS_REGION &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY
    );
    if (!checks.ai) {
      errors.push('AWS Bedrock credentials not configured');
    }
  } else if (usesVertex) {
    // Vertex uses application default credentials
    checks.ai = true; // Assume configured if selected
  } else {
    checks.ai = !!process.env.ANTHROPIC_API_KEY;
    if (!checks.ai) {
      errors.push('Anthropic API key not configured');
    }
  }

  const isHealthy = checks.storage && checks.sessions && checks.ai;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ready' : 'not ready',
    checks,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString(),
  });
}
