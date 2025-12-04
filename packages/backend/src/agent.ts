import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createFileTools } from './tools/file-tools.js';
import { createTemplateTools } from './tools/template-tools.js';
import type { SandboxSession } from './sandbox/manager.js';
import { SITE_BUILDER_PROMPT } from './prompts/site-builder.js';
import { getLogger } from './config/logger.js';
import fs from 'fs/promises';

const log = getLogger('agent');

/**
 * Pending tool approval request
 */
export interface ToolApprovalRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (approved: boolean) => void;
}

/**
 * Callback for handling tool approval requests
 * Called when the agent wants to execute a write/edit tool in plan mode
 */
export type ToolApprovalCallback = (request: ToolApprovalRequest) => void;

/**
 * Create and run a site building session with sandbox support
 * @param prompt - User's message
 * @param projectPath - Path to the project directory
 * @param sessionId - Optional session ID to resume
 * @param mode - 'plan' shows proposed actions for approval, 'execute' runs without asking
 * @param sandboxSession - Optional sandbox session context for isolation
 * @param userId - User ID (for storage abstraction)
 * @param projectId - Project ID (for storage abstraction)
 * @param toolApprovalCallback - Callback for tool approval in plan mode
 */
export async function runSiteAgent(
  prompt: string,
  projectPath: string,
  sessionId?: string,
  mode: 'plan' | 'execute' = 'plan',
  sandboxSession?: SandboxSession,
  userId?: string,
  projectId?: string,
  toolApprovalCallback?: ToolApprovalCallback
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
    // Use 'default' permissionMode to allow canUseTool callback to be invoked
    // The canUseTool callback handles approval logic for plan mode
    // For execute mode, we allow all tools without approval
    permissionMode: mode === 'plan' ? 'default' : 'bypassPermissions',
    systemPrompt: SITE_BUILDER_PROMPT,
    // Set higher maxThinkingTokens to give agent more thinking capacity
    maxThinkingTokens: 8192,
    // Enable streaming for real-time text display
    includePartialMessages: true,
    mcpServers: {
      'site-studio': server,
    },
    // Capture CLI stderr for debugging
    stderr: (data: string) => {
      log.debug({ stderr: data.substring(0, 500) }, 'SDK CLI stderr');
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
      'AskUserQuestion',     // Agent should build sites, not ask meta-questions
    ],
    // NOTE: TodoWrite is ALLOWED - it helps users see what the agent is planning to do

  };

  // Add canUseTool callback for plan mode approval
  // This intercepts tool calls and allows the frontend to approve/deny them
  if (mode === 'plan' && toolApprovalCallback) {
    // Tools that require approval before execution
    const toolsRequiringApproval = [
      'mcp__site-studio__write_file',
      'mcp__site-studio__edit_file',
      'mcp__site-studio__delete_file',
      'mcp__site-studio__scaffold_template',
    ];

    queryOptions.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
      // Log ALL tool calls to debug tool name format
      log.info({
        userId,
        projectId,
        toolName,
        requiresApproval: toolsRequiringApproval.includes(toolName),
      }, 'canUseTool called');

      // Only require approval for write/edit operations
      if (!toolsRequiringApproval.includes(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }

      log.info({
        userId,
        projectId,
        toolName,
        inputKeys: Object.keys(input),
      }, 'Tool requires approval');

      // Create approval request and wait for response
      return new Promise((resolve) => {
        const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const request: ToolApprovalRequest = {
          id: requestId,
          toolName,
          input,
          resolve: (approved: boolean) => {
            log.info({
              userId,
              projectId,
              requestId,
              toolName,
              approved,
            }, 'Tool approval resolved');

            if (approved) {
              resolve({ behavior: 'allow', updatedInput: input });
            } else {
              resolve({ behavior: 'deny', message: 'User declined the operation', interrupt: false });
            }
          },
        };

        // Notify the caller about the pending approval
        toolApprovalCallback(request);
      });
    };

    log.info({
      userId,
      projectId,
      mode,
    }, 'Plan mode enabled with canUseTool callback');
  }

  log.info({
    userId,
    projectId,
    sessionId,
    disallowedToolCount: queryOptions.disallowedTools.length,
    includePartialMessages: queryOptions.includePartialMessages,
    hasStderrCallback: !!queryOptions.stderr,
    hasCanUseTool: !!queryOptions.canUseTool,
  }, 'Agent query options configured');

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
