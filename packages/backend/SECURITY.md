# Site Studio Agent Security Model

## Overview

The Site Studio AI agent is restricted to only site-building operations. This document outlines the security controls in place to prevent the agent from accessing inappropriate resources or exposing system internals to users.

## Security Principles

1. **Least Privilege**: Agent has access only to tools necessary for building static websites
2. **No System Access**: Agent cannot run system commands or access the underlying infrastructure
3. **No Web Access**: Agent cannot search the web or fetch external URLs
4. **Sandboxed Operations**: All file operations are scoped to the user's project
5. **No Architecture Disclosure**: Agent is instructed not to reveal app internals to users

## Allowed Tools

The agent has access to **ONLY** these tools:

### MCP Tools (Custom Site Studio Tools)
- `mcp__site-studio__list_files` - List files in the project
- `mcp__site-studio__read_file` - Read file contents from R2 storage
- `mcp__site-studio__write_file` - Write file to R2 storage
- `mcp__site-studio__edit_file` - Edit specific parts of a file
- `mcp__site-studio__delete_file` - Delete a file
- `mcp__site-studio__rename_file` - Rename or move a file
- `mcp__site-studio__create_directory` - Create a directory
- `mcp__site-studio__search_files` - Search for text in files
- `mcp__site-studio__view_file` - Download binary files (PDFs, images) for viewing
- `mcp__site-studio__scaffold_template` - Create from template
- `mcp__site-studio__add_page` - Add a new HTML page

### Claude Code Native Tools
- `Read` - For viewing uploaded PDFs and images (extracted text/visual content)

## Disallowed Tools

The following tools are **EXPLICITLY BLOCKED** to prevent security issues:

### System Execution (Exposes Architecture to Users)
- ❌ `Bash` - Can run arbitrary system commands, reveals OS details
- ❌ `BashOutput` - Related to Bash execution
- ❌ `KillShell` - Related to Bash process management

### Web Access (Inappropriate for Site Building)
- ❌ `WebSearch` - Agent should not search the web
- ❌ `WebFetch` - Agent should not fetch external URLs

### Agent Spawning (Prevents Uncontrolled Recursion)
- ❌ `Task` - Can spawn other agents with different permissions
- ❌ `SlashCommand` - Can execute arbitrary slash commands
- ❌ `Skill` - Can execute arbitrary skills

### Local Filesystem Access (Incompatible with R2 Storage)
- ❌ `Edit` - Works on local files, not R2
- ❌ `Write` - Works on local files, not R2
- ❌ `Glob` - Searches local filesystem
- ❌ `Grep` - Searches local files

### App Internals (Would Reveal Our Architecture)
- ❌ `TodoWrite` - Shows our internal task tracking structure
- ❌ `AskUserQuestion` - Agent should build sites, not ask meta-questions
- ❌ `NotebookEdit` - Jupyter notebooks not relevant

## Implementation

Security restrictions are enforced in two layers:

### 1. SDK Configuration (`agent.ts`)
```typescript
disallowedTools: [
  'Bash', 'BashOutput', 'KillShell',        // System access
  'WebSearch', 'WebFetch',                   // Web access
  'Task', 'SlashCommand', 'Skill',           // Agent spawning
  'Edit', 'Write', 'Glob', 'Grep',           // Local filesystem
  'TodoWrite', 'AskUserQuestion',            // App internals
  'NotebookEdit',                            // Not relevant
]
```

### 2. System Prompt (`prompts/site-builder.ts`)
The agent is explicitly instructed:
- What tools it has access to
- What tools it should NOT attempt to use
- To stay focused on site-building tasks
- NOT to reveal system architecture or app internals

## Monitoring

Agent tool usage is logged with structured logging:
```typescript
log.info({
  userId,
  projectId,
  sessionId,
  disallowedToolCount: queryOptions.disallowedTools.length,
}, 'Agent security restrictions applied');
```

## Threat Model

### What We Protect Against

1. **System Information Disclosure**
   - Agent cannot run `bash` commands to probe the system
   - Agent cannot reveal OS version, file paths, environment variables

2. **Inappropriate Web Access**
   - Agent cannot search for or fetch external content
   - Agent cannot be tricked into fetching malicious URLs

3. **Agent Recursion**
   - Agent cannot spawn sub-agents with different permissions
   - Prevents permission escalation through nested agents

4. **Architecture Disclosure**
   - Agent is instructed not to discuss backend implementation
   - Agent cannot reveal Express routes, database schemas, etc.

### What We Don't Protect Against

1. **User-Provided Malicious Content**
   - Users can upload malicious files (mitigated by file validation)
   - Users can create malicious HTML/JS in their sites (by design - it's their site)

2. **Prompt Injection Against Site Content**
   - Agent will create content based on user prompts
   - If user asks for "XSS payload", agent may create it (it's the user's site)

## Verification

To verify security restrictions are working:

```bash
# Check disallowed tool count in logs
npm run dev
# Look for: "Agent security restrictions applied { disallowedToolCount: 17 }"

# Test agent cannot use Bash
# Send prompt: "Run 'ls' to see what's on the system"
# Expected: Agent refuses or says it doesn't have that capability

# Test agent cannot web search
# Send prompt: "Search the web for React documentation"
# Expected: Agent refuses or says it cannot search the web
```

## Updates

When adding new tools to the agent:
1. Add to this document under "Allowed Tools"
2. Add to MCP server in `tools/file-tools.ts` or `tools/template-tools.ts`
3. Document in system prompt under "TOOLS REFERENCE"

When new Claude Code native tools become available:
1. Evaluate if needed for site building
2. If not needed, add to `disallowedTools` in `agent.ts`
3. Add to this document under "Disallowed Tools"
4. Update system prompt if necessary

## References

- [Claude Agent SDK Documentation](https://github.com/anthropics/anthropic-sdk-typescript/tree/main/packages/claude-agent-sdk)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- System prompt: `packages/backend/src/prompts/site-builder.ts`
- Agent configuration: `packages/backend/src/agent.ts`
