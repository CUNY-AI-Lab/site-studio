# Site Studio

AI-powered web development tool for academics. Build professional websites through natural language conversation with an AI agent that proposes changes before executing them.

## Features

- 🤖 **Plan/Execute AI Agent** - Review and approve proposed changes before execution
- 📝 **Live Code Editor** - CodeMirror 6 with syntax highlighting and auto-save
- 👀 **Live Preview** - Real-time updates with flicker-free dual iframe system
- 📁 **File Management** - Complete project file access and organization
- 🎨 **Modern UI** - SvelteKit 5 with shadcn-svelte components

## Tech Stack

**Frontend:** SvelteKit 5, Tailwind CSS v4, CodeMirror 6
**Backend:** Express 5, Claude Agent SDK, MCP Tools
**AI:** Claude Sonnet 4.5 with interactive approval workflow

## Quick Start

```bash
# Install dependencies
npm install

# Configure backend
cd packages/backend
echo "ANTHROPIC_API_KEY=your-key-here" > .env
npm run build

# Run (from root)
cd ../..
npm run dev
```

Open http://localhost:5173

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

## Architecture

```
site-studio/
├── packages/
│   ├── backend/         # Express + Claude Agent SDK
│   │   ├── agent.ts     # Plan/execute mode configuration
│   │   ├── index.ts     # API server with SSE streaming
│   │   └── tools.ts     # MCP file system tools
│   └── frontend/        # SvelteKit 5
│       └── src/
│           ├── routes/
│           └── lib/components/
└── package.json         # npm workspaces
```

## How It Works

### Plan Phase
1. User describes desired changes
2. Agent analyzes and proposes specific actions
3. Frontend displays plan with file operations
4. User reviews and approves/rejects

### Execute Phase
1. Agent executes approved actions
2. Results stream via Server-Sent Events
3. Preview updates in real-time

This ensures transparency, control, and safety—nothing happens without approval.

## Available Tools

The agent can:
- Create/read/write/delete files
- Organize project structure
- Generate templates (blank, portfolio, blog)
- Add new pages with navigation
- Explain design decisions

## Development

```bash
# Backend
cd packages/backend
npm run dev          # http://localhost:3001

# Frontend
cd packages/frontend
npm run dev          # http://localhost:5173
```

## API Endpoints

- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id/files` - List files
- `POST /api/query` - Send message (SSE stream)
- `GET /preview/:id/*` - Preview files

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

Built with Anthropic's Claude Agent SDK and Claude Sonnet 4.5. Inspired by Vercel's v0.
