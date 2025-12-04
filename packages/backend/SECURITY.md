# Site Studio Agent Security Model

## Overview

The Site Studio AI agent is restricted to only site-building operations. This document outlines the security controls in place to prevent the agent from accessing inappropriate resources.

## Security Architecture

Security is enforced through **three layers**:

### 1. Tool Restrictions (`disallowedTools`)

The primary security control. The agent SDK's `disallowedTools` option blocks access to dangerous tools at the SDK level.

**Allowed Tools:**
- MCP tools (`mcp__site-studio__*`) - Custom file/template operations via storage abstraction
- `Read` tool - For viewing uploaded PDFs/images

**Blocked Tools:**
```typescript
disallowedTools: [
  'Bash', 'BashOutput', 'KillShell',  // System access
  'WebSearch', 'WebFetch',             // Web access
  'Task', 'SlashCommand', 'Skill',     // Agent spawning
  'Edit', 'Write', 'Glob', 'Grep',     // Local filesystem
  'AskUserQuestion', 'NotebookEdit',   // Not needed
]
```

### 2. Path Traversal Validation (Storage Layer)

All file paths are validated in the storage abstraction to prevent path traversal attacks:

```typescript
function validateFilePath(filePath: string): string {
  // Reject absolute paths
  if (filePath.startsWith('/')) {
    throw new Error('Absolute paths are not allowed');
  }

  // Reject path traversal attempts
  if (filePath.includes('..')) {
    throw new Error('Path traversal is not allowed');
  }

  // Additional validation for null bytes, normalization, etc.
  // ...
}
```

This prevents attacks like:
- `../../../etc/passwd`
- `../../other-user/project/secret.txt`
- Null byte injection

### 3. Storage Key Isolation

All storage operations use user-controlled key prefixes:

**R2 Storage:**
```
projects/{userId}/{projectId}/{filePath}
```

**Filesystem Storage:**
```
{SANDBOXES_DIR}/{userId}/{projectId}/{filePath}
```

The `userId` and `projectId` come from the authenticated session, not from agent input. Only `filePath` comes from the agent, and it's validated.

## What We Protect Against

### System Information Disclosure
- Agent cannot run `bash` commands to probe the system
- Agent cannot reveal OS version, file paths, environment variables
- No shell access of any kind

### Inappropriate Web Access
- Agent cannot search for or fetch external content
- Agent cannot be tricked into fetching malicious URLs

### Agent Recursion/Escalation
- Agent cannot spawn sub-agents with different permissions
- Agent cannot execute slash commands or skills

### Cross-User Data Access
- Path traversal is blocked at the storage layer
- Storage keys enforce user isolation
- Each user can only access their own projects

### Path Traversal Attacks
- `..` sequences are rejected
- Absolute paths are rejected
- Null bytes are rejected
- Paths are normalized and re-validated

## What We Don't Protect Against

### User-Provided Malicious Content
- Users can upload files (validated by file type/size)
- Users can create HTML/JS in their sites (by design - it's their site)

### Prompt Injection Against Site Content
- If user asks for "XSS payload", agent may create it (it's the user's site)
- Agent is a tool, user is responsible for content

## Implementation Files

| File | Security Role |
|------|--------------|
| `agent.ts` | `disallowedTools` configuration |
| `storage/r2-storage.ts` | Path validation, key prefixes |
| `storage/filesystem-storage.ts` | Path validation, directory isolation |
| `prompts/site-builder.ts` | Instructions to stay focused on site building |

## NOT Security Controls

The following exist for session management, NOT security:

- `sandbox/manager.ts` - Session tracking, path utilities
- `sandbox/config.ts` - Path configuration

These files do NOT enforce security. The actual security comes from `disallowedTools` and path validation in storage.

## Verification

To verify security restrictions are working:

```bash
# Check disallowed tool count in logs
npm run dev
# Look for: "Agent query options configured { disallowedToolCount: 12 }"

# Test agent cannot use Bash
# Send prompt: "Run 'ls' to see what's on the system"
# Expected: Agent refuses or says it doesn't have that capability

# Test path traversal is blocked
# Agent tries to read "../../../etc/passwd"
# Expected: Error "Path traversal is not allowed"
```

## Adding New Security Controls

When adding new tools or features:

1. Consider if it needs to be in `disallowedTools`
2. Ensure file paths go through `validateFilePath()`
3. Ensure storage operations use `userId`/`projectId` keys
4. Document any new attack vectors and mitigations
