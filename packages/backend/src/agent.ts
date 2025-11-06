import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createFileTools } from './tools/file-tools.js';
import { createTemplateTools } from './tools/template-tools.js';
import type { SandboxSession } from './sandbox/manager.js';
import { SITE_BUILDER_PROMPT } from './prompts/site-builder.js';
import { getLogger } from './config/logger.js';
import fs from 'fs/promises';

const log = getLogger('agent');

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
  log.info({
    userId,
    projectId,
    sessionId: sessionId || 'NEW',
    mode,
    projectPath,
    promptLength: prompt.length,
    hasSession: !!sessionId,
  }, 'Initializing agent');

  // Clean up downloaded binaries from previous sessions (only for new sessions)
  if (!sessionId) {
    try {
      await fs.rm(projectPath, { recursive: true, force: true });
      await fs.mkdir(projectPath, { recursive: true });
      log.debug({
        userId,
        projectId,
        projectPath,
      }, 'Cleaned up project directory for new session');
    } catch (error) {
      // Ignore cleanup errors - directory might not exist yet
      log.debug({
        userId,
        projectId,
        projectPath,
        error,
      }, 'Project directory cleanup skipped (may not exist)');
    }
  }

  // Create tools with projectPath and optional sandbox context
  const fileTools = createFileTools(projectPath, sandboxSession, userId, projectId);
  const templateTools = createTemplateTools(projectPath);
  const allTools = [...fileTools, ...templateTools];

  log.debug({
    userId,
    projectId,
    toolCount: allTools.length,
    fileToolCount: fileTools.length,
    templateToolCount: templateTools.length,
  }, 'Tools created for agent');

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
    // SECURITY: Restrict agent to only site-building tools
    //
    // ALLOWED TOOLS:
    // - MCP tools (mcp__site-studio__*) - our custom file/template operations
    // - Read tool - for viewing uploaded PDFs/images
    //
    // ALL OTHER TOOLS ARE DISALLOWED to prevent:
    // - Exposing system architecture to users (Bash, system commands)
    // - Inappropriate web access (WebSearch, WebFetch)
    // - Spawning uncontrolled agents (Task, Agent)
    // - Accessing local filesystem directly (Glob, Grep, Edit, Write)
    // - Revealing app internals (TodoWrite shows our task structure)
    disallowedTools: [
      // File system tools (incompatible with R2 storage, work on local filesystem)
      'Edit',                // Use mcp__site-studio__edit_file instead
      'Write',               // Use mcp__site-studio__write_file instead
      'Glob',                // Searches local filesystem, not R2
      'Grep',                // Searches local files, not R2

      // System execution tools (SECURITY RISK - exposes system architecture to users)
      'Bash',                // Can run arbitrary system commands, exposes OS details
      'BashOutput',          // Related to Bash execution
      'KillShell',           // Related to Bash process management

      // Web access tools (inappropriate for site building, potential data leakage)
      'WebSearch',           // Agent should not search the web
      'WebFetch',            // Agent should not fetch external URLs

      // Agent spawning tools (prevents uncontrolled agent recursion)
      'Task',                // Can spawn other agents with different permissions
      'SlashCommand',        // Can execute arbitrary slash commands
      'Skill',               // Can execute arbitrary skills

      // Other tools not needed for site building
      'NotebookEdit',        // Jupyter notebooks not relevant to static sites

      // App internals (would reveal our architecture to users)
      'TodoWrite',           // Shows our internal task tracking structure
      'AskUserQuestion',     // Agent should build sites, not ask meta-questions
    ],
  };

  log.info({
    userId,
    projectId,
    sessionId,
    disallowedToolCount: queryOptions.disallowedTools.length,
  }, 'Agent security restrictions applied');

  // Resume conversation if session ID provided
  if (sessionId) {
    queryOptions.resume = sessionId;
    log.info({
      userId,
      projectId,
      sessionId,
      mode,
    }, 'Resuming agent conversation with SDK');
  } else {
    log.info({
      userId,
      projectId,
      mode,
    }, 'Starting new agent conversation with SDK');
  }

  try {
    const stream = query({
      prompt,
      options: queryOptions,
    });

    log.info({
      userId,
      projectId,
      sessionId,
      mode,
    }, 'Agent SDK query stream created');

    return stream;
  } catch (error) {
    log.error({
      error,
      userId,
      projectId,
      sessionId,
      mode,
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Failed to create agent SDK query stream');
    throw error;
  }
}
