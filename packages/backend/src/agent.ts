import {
  query,
  createSdkMcpServer,
  type HookJSONOutput,
  type Options,
  type PostToolUseHookInput,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';
import { createFileTools } from './tools/file-tools.js';
import { createTemplateTools } from './tools/template-tools.js';
import type { SandboxSession } from './sandbox/manager.js';
import { SITE_BUILDER_PROMPT } from './prompts/site-builder.js';
import { getLogger } from './config/logger.js';
import { getSandboxConfig, buildSandboxSettings } from './config/sandbox-config.js';
import { getSyncService } from './services/project-sync.js';

const log = getLogger('agent');

/**
 * Pending tool interaction request surfaced to the frontend.
 */
export type ToolInteractionKind = 'approval' | 'question';

export type ToolInteractionResolution = {
  approved: true;
  updatedInput?: Record<string, unknown>;
} | {
  approved: false;
  message?: string;
  interrupt?: boolean;
};

export interface ToolInteractionRequest {
  id: string;
  kind: ToolInteractionKind;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (resolution: ToolInteractionResolution) => void;
}

/**
 * Callback for handling tool interaction requests.
 * Used for write approvals in plan mode and AskUserQuestion in all modes.
 */
export type ToolInteractionCallback = (request: ToolInteractionRequest) => void;

function summarizeSyncErrors(errors: string[]): string {
  const preview = errors.slice(0, 3).join('; ');
  return errors.length > 3 ? `${preview}; and ${errors.length - 3} more` : preview;
}

function buildSyncFailureOutput(message: string): HookJSONOutput {
  return {
    continue: false,
    stopReason: 'Project sync failed',
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  };
}

/**
 * Create and run a site building session with sandbox support
 * @param prompt - User's message
 * @param projectPath - Path to the project directory
 * @param sessionId - Optional session ID to resume
 * @param mode - 'plan' shows proposed actions for approval, 'execute' runs without asking
 * @param sandboxSession - Optional sandbox session context for isolation
 * @param userId - User ID (for storage abstraction)
 * @param projectId - Project ID (for storage abstraction)
 * @param toolInteractionCallback - Callback for tool approvals and AskUserQuestion prompts
 */
export async function runSiteAgent(
  prompt: string,
  projectPath: string,
  sessionId?: string,
  mode: 'plan' | 'execute' = 'plan',
  sandboxSession?: SandboxSession,
  userId?: string,
  projectId?: string,
  toolInteractionCallback?: ToolInteractionCallback
): Promise<Query> {
  log.info({
    userId,
    projectId,
    sessionId: sessionId || 'NEW',
    mode,
    projectPath,
    promptLength: prompt.length,
    hasSession: !!sessionId,
  }, 'Initializing agent');

  // NOTE: Do NOT clean up projectPath here!
  // The projectPath has already been hydrated from R2 storage by index.ts before calling runSiteAgent.
  // Cleaning up here would wipe the downloaded files.
  // If cleanup is needed between sessions, it should happen in index.ts BEFORE hydration.

  // Check if sandbox will be enabled (determines which tools to register)
  const sandboxConfig = getSandboxConfig();
  const sandboxEnabled = sandboxConfig.enabled;

  // Create tools with projectPath and optional sandbox context
  // When sandbox is enabled, skip MCP file tools (use standard tools + sync instead)
  const fileTools = sandboxEnabled ? [] : createFileTools(projectPath, sandboxSession, userId, projectId);
  const templateTools = createTemplateTools(projectPath, userId, projectId);
  const allTools = [...fileTools, ...templateTools];

  log.debug({
    userId,
    projectId,
    toolCount: allTools.length,
    fileToolCount: fileTools.length,
    templateToolCount: templateTools.length,
    sandboxEnabled,
  }, 'Tools created for agent');

  // Create MCP server with all tools
  const server = createSdkMcpServer({
    name: 'site-studio',
    version: '1.0.0',
    tools: allTools,
  });

  // Query options for standalone server with direct API calls
  const queryOptions: Options = {
    cwd: projectPath,
    // Keep permission callbacks active in both modes so AskUserQuestion can round-trip through the UI.
    permissionMode: 'default',
    systemPrompt: SITE_BUILDER_PROMPT,
    thinking: {
      type: 'enabled',
      budgetTokens: 32000,
    },
    // Enable streaming for real-time text display
    includePartialMessages: true,
    toolConfig: {
      askUserQuestion: {
        previewFormat: 'html',
      },
    },
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

    ],
    // NOTE: TodoWrite is ALLOWED - it helps users see what the agent is planning to do

  };

  // SDK Sandbox configuration (OS-level isolation via bubblewrap)
  // Note: sandboxConfig already retrieved above for tool selection
  const sandboxSettings = buildSandboxSettings(sandboxConfig);

  if (sandboxSettings) {
    queryOptions.sandbox = sandboxSettings;

    log.info({
      userId,
      projectId,
      sandboxEnabled: true,
      autoAllowBash: sandboxConfig.autoAllowBash,
      allowLocalBinding: sandboxConfig.network.allowLocalBinding,
    }, 'SDK sandbox enabled');

    // Remove standard file tools from disallowed list when sandbox is enabled
    // These tools will write to local filesystem, then sync to R2 via PostToolUse hooks
    const sandboxEnabledTools = ['Edit', 'Write', 'Glob', 'Grep'];
    queryOptions.disallowedTools = (queryOptions.disallowedTools ?? []).filter(
      (tool: string) => !sandboxEnabledTools.includes(tool)
    );

    log.info({
      userId,
      projectId,
      enabledTools: sandboxEnabledTools,
    }, 'Standard file tools enabled (sandboxed, synced to R2)');

    // Add file tools instructions to system prompt with projectPath
    const fileToolsInstructions = `

# STANDARD FILE TOOLS (SANDBOX MODE)

**Project Directory:** \`${projectPath}\`

You have access to standard file tools that operate on the project directory above.
All paths must be absolute paths within this directory.

**Available Tools:**
- \`Edit\` - Make precise edits to existing files using search/replace
- \`Write\` - Create new files or overwrite existing ones
- \`Glob\` - Find files by pattern
- \`Grep\` - Search file contents with regex

**Important:**
- All file paths must be absolute (e.g., \`${projectPath}/index.html\`)
- Writing to a nested path creates parent directories automatically
- Changes are automatically synced to cloud storage
- Use these tools instead of MCP file tools
- For narrow requests, prefer the smallest possible edit and avoid rewriting whole files unless necessary
- Prefer \`Edit\` over \`Write\` when changing existing content

**Examples:**
- Edit: \`file_path="${projectPath}/index.html"\`, old_string="...", new_string="..."
- Write: \`file_path="${projectPath}/styles/main.css"\`, content="..."
- Glob: \`pattern="**/*.html"\`, path="${projectPath}"
- Grep: \`pattern="title:"\`, path="${projectPath}"
`;

    queryOptions.systemPrompt = SITE_BUILDER_PROMPT + fileToolsInstructions;

    // Remove Bash tools from disallowed list if sandbox is enabled with autoAllowBash
    if (sandboxConfig.autoAllowBash) {
      const bashTools = ['Bash', 'BashOutput', 'KillShell'];
      queryOptions.disallowedTools = (queryOptions.disallowedTools ?? []).filter(
        (tool: string) => !bashTools.includes(tool)
      );

      // Append instructions to system prompt enabling Bash usage
      const bashInstructions = `

# BASH COMMANDS (SANDBOX MODE)

You have access to the Bash tool for running shell commands in a secure sandboxed environment.

**Working Directory:** \`${projectPath}\`

Always run commands from this directory. Use \`cd ${projectPath} &&\` prefix if needed.

**Available Commands:**
- Build tools: \`hugo\`, \`npm\`, \`node\`, etc. (if installed on server)
- File operations: \`ls\`, \`cat\`, \`grep\`, \`find\`, etc.
- Project builds: \`hugo --minify\`, \`npm run build\`, etc.

**Use Bash for:**
- Running static site generators (Hugo, Jekyll)
- Building projects with npm scripts
- File inspection and diagnostics

**Security Notes:**
- Commands run in an OS-level sandbox (bubblewrap)
- Filesystem access is restricted to the project directory
- Network access may be limited

**Example:**
User: "Build my Hugo site"
You: \`cd ${projectPath} && hugo --minify\`
`;

      queryOptions.systemPrompt += bashInstructions;

      log.info({
        userId,
        projectId,
        enabledTools: bashTools,
      }, 'Bash tools enabled (sandboxed)');
    }
  }

  // Add canUseTool callback for runtime approvals and AskUserQuestion handling.
  if (toolInteractionCallback) {
    const askUserQuestionTool = 'AskUserQuestion';

    // Tools that require approval before execution in plan mode.
    const toolsRequiringApproval = [
      // MCP tools (custom file operations)
      'mcp__site-studio__write_file',
      'mcp__site-studio__edit_file',
      'mcp__site-studio__delete_file',
      'mcp__site-studio__rename_file',
      'mcp__site-studio__create_directory',
      'mcp__site-studio__scaffold_template',
      'mcp__site-studio__add_page',
      // Standard Claude Code tools (when sandbox enabled)
      'Edit',
      'Write',
      'Bash',
    ];

    queryOptions.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
      const requiresApproval = mode === 'plan' && toolsRequiringApproval.includes(toolName);
      const isUserQuestion = toolName === askUserQuestionTool;

      // Log ALL tool calls to debug tool name format
      log.info({
        userId,
        projectId,
        toolName,
        requiresApproval,
        isUserQuestion,
        mode,
      }, 'canUseTool called');

      if (!requiresApproval && !isUserQuestion) {
        return { behavior: 'allow', updatedInput: input };
      }

      log.info({
        userId,
        projectId,
        toolName,
        interactionKind: isUserQuestion ? 'question' : 'approval',
        inputKeys: Object.keys(input),
      }, 'Tool requires user interaction');

      // Create interaction request and wait for frontend response
      return new Promise((resolve) => {
        const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const request: ToolInteractionRequest = {
          id: requestId,
          kind: isUserQuestion ? 'question' : 'approval',
          toolName,
          input,
          resolve: (resolution: ToolInteractionResolution) => {
            log.info({
              userId,
              projectId,
              requestId,
              toolName,
              approved: resolution.approved,
              hasUpdatedInput: resolution.approved && !!resolution.updatedInput,
            }, 'Tool interaction resolved');

            if (resolution.approved) {
              resolve({
                behavior: 'allow',
                updatedInput: resolution.updatedInput ?? input,
              });
            } else {
              resolve({
                behavior: 'deny',
                message: resolution.message || 'User declined the operation',
                interrupt: resolution.interrupt ?? false,
              });
            }
          },
        };

        toolInteractionCallback(request);
      });
    };

    log.info({
      userId,
      projectId,
      mode,
    }, 'canUseTool callback enabled');
  }

  // Add PostToolUse hooks for syncing local changes to R2
  // This ensures files written by standard tools (Edit, Write, Bash) are synced
  if (process.env.STORAGE_TYPE === 'r2' && sandboxEnabled && userId && projectId) {
    const fileModifyingTools = ['Edit', 'Write', 'Bash'];

    queryOptions.hooks = {
      PostToolUse: [{
        matcher: fileModifyingTools.join('|'),
        hooks: [async (hookInput, toolUseId): Promise<HookJSONOutput> => {
          const input = hookInput as PostToolUseHookInput;

          try {
            const syncService = getSyncService();
            log.info({
              userId,
              projectId,
              toolName: input.tool_name,
              toolUseId,
            }, 'Syncing local changes to R2 after tool use');

            const result = await syncService.sync(userId, projectId, projectPath);

            if (result.errors.length > 0) {
              return buildSyncFailureOutput(
                `Project changes could not be synced back to storage: ${summarizeSyncErrors(result.errors)}`
              );
            }

            log.info({
              userId,
              projectId,
              filesUploaded: result.filesUploaded,
              filesDeleted: result.filesDeleted,
              errors: result.errors.length,
            }, 'R2 sync complete');
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : 'Project changes could not be synced back to storage.';

            log.error({
              userId,
              projectId,
              error,
            }, 'R2 sync failed after tool use');

            return buildSyncFailureOutput(message);
          }

          return {};
        }],
      }],
    };

    log.info({
      userId,
      projectId,
      fileModifyingTools,
    }, 'PostToolUse sync hooks enabled');
  }

  log.info({
    userId,
    projectId,
    sessionId,
    disallowedToolCount: queryOptions.disallowedTools?.length ?? 0,
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
