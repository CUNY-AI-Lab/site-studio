import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createFileTools } from './tools/file-tools.js';
import { createTemplateTools } from './tools/template-tools.js';
import type { SandboxSession } from './sandbox/manager.js';
import { SITE_BUILDER_PROMPT } from './prompts/site-builder.js';
import fs from 'fs/promises';

/**
 * Create and run a site building session with sandbox support
 * @param prompt - User's message
 * @param projectPath - Path to the project directory
 * @param sessionId - Optional session ID to resume
 * @param mode - 'plan' shows proposed actions for approval, 'execute' runs without asking
 * @param sandboxSession - Optional sandbox session context for isolation
 * @param userId - User ID (for storage abstraction)
 * @param projectId - Project ID (for storage abstraction)
 */
export async function runSiteAgent(
  prompt: string,
  projectPath: string,
  sessionId?: string,
  mode: 'plan' | 'execute' = 'plan',
  sandboxSession?: SandboxSession,
  userId?: string,
  projectId?: string
): Promise<AsyncIterable<any>> {
  // Clean up downloaded binaries from previous sessions (only for new sessions)
  if (!sessionId) {
    try {
      await fs.rm(projectPath, { recursive: true, force: true });
      await fs.mkdir(projectPath, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors - directory might not exist yet
    }
  }

  // Create tools with projectPath and optional sandbox context
  const fileTools = createFileTools(projectPath, sandboxSession, userId, projectId);
  const templateTools = createTemplateTools(projectPath);
  const allTools = [...fileTools, ...templateTools];

  // Create MCP server with all tools
  const server = createSdkMcpServer({
    name: 'site-studio',
    version: '1.0.0',
    tools: allTools,
  });

  // Query options for standalone server with direct API calls
  const queryOptions: any = {
    // Use bypassPermissions for standalone Express server (no interactive prompts)
    permissionMode: 'bypassPermissions',
    systemPrompt: SITE_BUILDER_PROMPT,
    // Set higher maxThinkingTokens to give agent more thinking capacity
    maxThinkingTokens: 8192,
    mcpServers: {
      'site-studio': server,
    },
    // Disable Claude Code's file-writing tools that don't work with R2 storage
    // Keep Read tool - it provides PDF extraction when using Direct Anthropic API (not AWS Bedrock)
    // Keep other useful tools like TodoWrite, AskUserQuestion, etc.
    disallowedTools: [
      'Edit',    // Use mcp__site-studio__edit_file instead
      'Write',   // Use mcp__site-studio__write_file instead
      'Glob',    // Searches local filesystem (incompatible with R2)
      'Grep',    // Searches local files (incompatible with R2)
    ],
  };

  // Resume conversation if session ID provided
  if (sessionId) {
    queryOptions.resume = sessionId;
  }

  return query({
    prompt,
    options: queryOptions,
  });
}
