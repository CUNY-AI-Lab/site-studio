# Site Studio

AI-powered web development tool for academics. Build professional websites through natural language conversation with an AI agent that proposes changes before executing them.

## Features

- **Plan/Execute AI Agent** - Review and approve proposed changes before execution
- **Live Code Editor** - CodeMirror 6 with syntax highlighting and auto-save
- **Live Preview** - Real-time updates with flicker-free dual iframe system
- **File Management** - Complete project file access and organization
- **Build Tools** - Run Hugo, npm, and other build tools (sandbox mode)
- **Cloud Storage** - Cloudflare R2 for production deployments
- **Modern UI** - SvelteKit 5 with shadcn-svelte components

## Tech Stack

**Frontend:** SvelteKit 5, Tailwind CSS v4, CodeMirror 6
**Backend:** Express 5, Claude Agent SDK, MCP Tools
**AI:** Claude with interactive approval workflow
**Storage:** Filesystem (dev) or Cloudflare R2 (prod)

## Quick Start

```bash
# Install dependencies
npm install

# Start development servers
./dev.sh
```

Open http://localhost:5173

### Production Setup

```bash
# Configure backend
cd packages/backend
cp .env.example .env
# Edit .env with your settings (R2 credentials, etc.)
npm run build

# Run
npm start
```

## Usage

1. **Create Project** - Choose a template or start blank
2. **Describe** - Tell the agent what you want in natural language
3. **Review Plan** - See exactly what will be created/modified
4. **Approve** - Execute the proposed changes
5. **Iterate** - Refine through conversation

### Example Prompts

- "Create a professional CV page with education, research, and publications sections"
- "Add a project showcase with filtering by research area"
- "Build a publications page linking to DOIs and arXiv papers"
- "Design a lab website with team profiles and current projects"
- "Initialize a Hugo site and build it" (sandbox mode)

## Architecture

```
site-studio/
├── packages/
│   ├── backend/           # Express + Claude Agent SDK
│   │   ├── src/
│   │   │   ├── index.ts       # API server with SSE streaming
│   │   │   ├── agent.ts       # Agent config, sandbox, hooks
│   │   │   ├── tools/         # MCP tools (file-tools, template-tools)
│   │   │   ├── storage/       # Storage abstraction (filesystem/R2)
│   │   │   └── services/      # ProjectSyncService
│   │   └── prompts/           # System prompts
│   │
│   └── frontend/          # SvelteKit 5
│       └── src/
│           ├── routes/        # Dashboard, Editor
│           └── lib/
│               ├── components/  # AgentChat, Preview, CodeView
│               └── api/         # API client
│
└── package.json           # npm workspaces
```

## How It Works

### Plan Phase
1. User describes desired changes
2. Agent analyzes and proposes specific actions
3. Frontend displays plan with file diff preview
4. User reviews and approves/rejects each action

### Execute Phase
1. Agent executes approved actions
2. Results stream via Server-Sent Events
3. Preview updates in real-time

This ensures transparency, control, and safety—nothing happens without approval.

## Two Agent Modes

### Mode 1: MCP Tools (Default)
- Uses custom MCP tools for file operations
- Direct storage access (filesystem or R2)
- Standard Claude Code tools blocked

### Mode 2: Sandbox + Build Tools
Enable with `AGENT_SANDBOX_ENABLED=true`:
- Uses standard tools (Edit, Write, Bash)
- Can run Hugo, npm, and other build commands
- OS-level isolation via bubblewrap (Linux)
- Files auto-sync to R2 via PostToolUse hooks

## Available Tools

The agent can:
- Create/read/write/delete files
- Organize project structure
- Generate templates (portfolio, blog, CV)
- Add new pages with navigation
- Run build tools (Hugo, npm) in sandbox mode
- Explain design decisions

## Configuration

Key environment variables:

```bash
# Storage
STORAGE_TYPE=r2              # 'filesystem' or 'r2'

# R2 Storage
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=site-studio

# Sandbox Mode (enables build tools)
AGENT_SANDBOX_ENABLED=true
AGENT_SANDBOX_AUTO_ALLOW_BASH=true
```

See `packages/backend/.env.example` for full configuration.

## API Endpoints

- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id/files` - List files
- `POST /api/query` - Send message (SSE stream)
- `POST /api/query/tool-approve` - Approve/reject tool
- `GET /preview/:id/*` - Preview files
- `POST /api/projects/:id/publish` - Publish site

## Development

```bash
# Both packages
./dev.sh

# Backend only
cd packages/backend && npm run dev    # http://localhost:3001

# Frontend only
cd packages/frontend && npm run dev   # http://localhost:5173
```

## Educational Use

Site Studio demonstrates:
- **AI Agent Concepts** - Tool use, planning, execution, permissions
- **Human-AI Collaboration** - Approval workflows, transparency, control
- **Web Development** - HTML/CSS/JS, project structure, live development
- **Modern Patterns** - Reactive UI, SSE streaming, component architecture

Perfect for teaching agentic AI and modern web development to students.

## License

MIT

## Acknowledgments

Built with Anthropic's Claude Agent SDK. Inspired by Vercel's v0.
