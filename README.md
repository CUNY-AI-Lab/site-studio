# Site Studio

An academic implementation of AI-powered web development, inspired by Vercel's v0.app. Site Studio introduces agentic AI processes to students and academics, enabling them to create professional websites through natural language conversation.

## Overview

Site Studio is designed to help academic students and researchers build professional web presence without requiring extensive web development knowledge. Users can create profile pages, CV sites, research portfolios, and publication archives by simply describing what they want to an AI agent.

### Goals

- **Democratize Web Development**: Make professional website creation accessible to academics regardless of technical background
- **Introduce Agentic AI**: Provide hands-on experience with AI agents that can plan, propose, and execute development tasks
- **Academic Focus**: Tailored for academic use cases like CV pages, research portfolios, and publication listings
- **Learning Tool**: Demonstrate modern AI-assisted development workflows in an educational context

**Key Features:**
- 🤖 **AI Agent with Plan/Execute Mode** - Agent proposes changes before executing them
- ✅ **User Approval Workflow** - Review and approve proposed actions before they're applied
- 📝 **Live Code Editor** - See and edit the HTML/CSS/JS directly with Monaco Editor
- 👀 **Live Preview** - Watch your site update in real-time with dual iframe system
- 📁 **File Management** - Full access to project files and structure
- 🎨 **Resizable Interface** - Drag to resize chat sidebar with modern UI components

## Technology Stack

### Frontend
- **SvelteKit 5**: Modern reactive framework with runes
- **Tailwind CSS v4**: Utility-first styling with @tailwindcss/vite
- **shadcn-svelte**: High-quality UI components (Dialog, Button, Tabs, Resizable)
- **Monaco Editor**: VS Code-powered code editing
- **Lucide Icons**: Beautiful icon set

### Backend
- **Express 5**: Web server framework
- **Claude Agent SDK (@anthropic-ai/claude-agent-sdk)**: Official agent framework
- **MCP (Model Context Protocol)**: Tool server pattern for agent capabilities
- **File System Tools**: Direct project manipulation

### AI
- **Claude 3.5 Sonnet**: Anthropic's latest model
- **Permission-based Execution**: Interactive approval workflow
- **Session Management**: Maintains conversation context across plan and execute phases

## Architecture

```
site-studio/
├── packages/
│   ├── backend/          # Express + Claude Agent SDK
│   │   ├── src/
│   │   │   ├── agent.ts         # Agent configuration with plan/execute modes
│   │   │   ├── index.ts         # Express server with SSE streaming
│   │   │   └── tools.ts         # MCP tool definitions
│   │   └── projects/            # User project files
│   │
│   └── frontend/                # SvelteKit 5 with Runes
│       ├── src/
│       │   ├── routes/
│       │   │   └── +page.svelte           # Main builder interface
│       │   └── lib/components/
│       │       ├── AgentChat.svelte       # Chat with streaming & approval
│       │       ├── PlanApprovalCard.svelte # Visual action approval
│       │       ├── CodeView.svelte        # File browser + Monaco
│       │       └── Preview.svelte         # Dual iframe for flicker-free updates
│       └── ...
└── package.json                 # Root workspace config
```

## Academic Use Cases

### Student Portfolios
- Personal academic homepages
- Course project showcases
- Assignment submissions
- Research documentation

### Faculty & Researchers
- Professional CV pages
- Research group websites
- Lab documentation sites
- Conference presentation archives

### Publication Management
- Publication list pages
- Citation tracking
- DOI-linked archives
- Conference paper listings

### Educational Applications
- Teaching AI agent concepts
- Demonstrating human-AI collaboration
- Web development introduction
- Modern framework examples

## Getting Started

### Prerequisites

- Node.js 18+
- npm or pnpm
- Anthropic API key

### Installation

```bash
# Clone the repository
cd site-studio

# Install all dependencies
npm install

# Set up backend environment
cd packages/backend
echo "ANTHROPIC_API_KEY=your-api-key-here" > .env

# Build backend
npm run build

# Return to root
cd ../..
```

### Running the App

In the root directory:

```bash
# Run both backend and frontend concurrently
npm run dev

# Or run separately in different terminals:
npm run dev:backend   # http://localhost:3001
npm run dev:frontend  # http://localhost:5173
```

The app will open at `http://localhost:5173`

## Usage

### Creating Your First Site

1. **Initialize a Project**: Enter a project name when prompted (e.g., "my-cv", "research-portfolio")

2. **Describe Your Site**: Tell the agent what you want in natural language

3. **Review the Plan**: The agent proposes specific actions with details about what files will be created/modified

4. **Approve & Execute**: Click "Approve & Execute" to proceed with the changes

5. **Iterate**: Continue refining through conversation

### Example Academic Prompts

**CV & Profile Pages:**
- "Create a professional CV page with sections for education, research experience, and publications"
- "Add a section for my academic honors and awards"
- "Include a downloadable PDF version of my CV"

**Research Portfolios:**
- "Build a research portfolio showcasing my machine learning projects with images"
- "Create a publications page that links to DOIs and arXiv papers"
- "Add a page for my conference presentations with slides and recordings"

**Lab & Group Sites:**
- "Design a lab website with team member profiles and current projects"
- "Create a project showcase with filtering by research area"
- "Add a news section for lab announcements and publications"

**Course Sites:**
- "Build a course project page with weekly assignments and resources"
- "Create a student portfolio template for class submissions"
- "Design a simple documentation site for my thesis project"

### Editing & Previewing

**Code View:**
- Click files in the tree to view/edit them
- Monaco editor with syntax highlighting
- Auto-save on changes
- Toggle between Preview and Code views

**Live Preview:**
- See changes in real-time
- Dual iframe system prevents white flash on updates
- Manual refresh available if needed

## Agent Capabilities

The agent can:
- **Create templates** (blank, portfolio, blog)
- **Add new pages** with navigation
- **Write HTML/CSS/JS** code
- **Modify existing files**
- **Organize files** into directories
- **Explain design decisions** as it builds

## Agent Architecture

### Plan/Execute Mode

Site Studio implements a two-phase workflow inspired by professional development practices:

**Planning Phase** (`interactive` permission mode):
1. User describes what they want
2. Agent analyzes the request and determines necessary actions
3. Agent returns a `permission_request` with proposed tool calls
4. Frontend displays the PlanApprovalCard showing each action
5. User reviews and either approves or rejects

**Execution Phase** (`bypassPermissions` mode):
1. Upon approval, backend resumes the session with approval message
2. Agent executes the previously proposed actions
3. Results stream back via Server-Sent Events
4. Frontend updates in real-time

This approach ensures:
- **Transparency**: Users see exactly what will happen
- **Control**: Nothing happens without explicit approval
- **Learning**: Students understand the steps involved
- **Safety**: Prevents unintended modifications

### MCP Tools

The backend provides these MCP tools to the agent:

**File Operations:**
- `list_files()` - Browse project structure
- `read_file(path)` - Read file contents
- `write_file(path, content)` - Create/update files
- `delete_file(path)` - Remove files
- `create_directory(path)` - Make folders

**Templates:**
- `scaffold_template(type)` - Start from template
- `add_page(name, title)` - Quick page creation

### Session Management

- Session IDs track conversation context
- Sessions persist across plan → execute transitions
- Multiple projects can have separate sessions
- Context includes file history and user preferences

## Development

### Backend

```bash
cd packages/backend

# Development with auto-rebuild
npm run dev

# Build only
npm run build

# Start production server
npm start
```

### Frontend

```bash
cd packages/frontend

# Development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Project Structure

### User Projects

Projects are stored in `packages/backend/projects/` by default. Each project is a directory containing the site files.

Example:
```
projects/
└── my-portfolio/
    ├── index.html
    ├── styles.css
    └── about.html
```

### Monorepo

Site Studio uses npm workspaces:
- `@site-studio/backend` - Backend server
- `@site-studio/frontend` - Web interface

## API Endpoints

### Projects
- `GET /api/projects` - List all projects
- `POST /api/projects` - Create new project
- `GET /api/projects/:id/files` - List project files
- `GET /api/projects/:id/files/*` - Read specific file

### Agent
- `POST /api/query` - Send message to agent (SSE stream)

### Preview
- `GET /preview/:id/*` - Serve project files

## Templates

### Blank
Minimal HTML/CSS starter with basic structure.

### Portfolio
Personal/professional showcase with:
- Hero section
- About section
- Project grid
- Contact section

### Blog
Simple blog layout with:
- Post listing
- Readable typography
- Classic blog design

## Educational Context

Site Studio serves as a teaching tool for multiple concepts:

### AI Agent Concepts
- **Tool Use**: How AI agents interact with external systems
- **Planning**: Breaking complex tasks into discrete actions
- **Execution**: Carrying out predetermined steps
- **Permission Systems**: Controlling AI agent autonomy

### Human-AI Collaboration
- **Approval Workflows**: Review before execution patterns
- **Iterative Refinement**: Conversational development
- **Transparency**: Understanding AI decision-making
- **Control**: Human oversight of autonomous systems

### Web Development
- **HTML/CSS/JavaScript**: Fundamental web technologies
- **File Structure**: Organizing web projects
- **Live Development**: Real-time feedback loops
- **Code Reading**: Understanding generated code

### Modern Frameworks
- **SvelteKit**: Reactive UI development
- **Server-Sent Events**: Real-time communication
- **Component Architecture**: Modular design patterns
- **API Design**: REST endpoints and streaming

## Future Enhancements

**Academic Features:**
- [ ] Publication bibliography integration
- [ ] ORCID and Google Scholar linking
- [ ] Academic CV templates with LaTeX export
- [ ] Citation formatting tools

**Platform Features:**
- [ ] More templates (landing page, documentation, etc.)
- [ ] Image upload and management
- [ ] GitHub Pages deployment
- [ ] Project export as ZIP

**Collaboration Features:**
- [ ] Multi-user projects (for lab groups)
- [ ] Template sharing
- [ ] Public gallery of academic sites
- [ ] Institution-specific templates

## License

MIT

## Contributing

This is an academic project. Contributions, suggestions, and educational use cases are welcome! Areas of interest:

- Additional academic-focused templates
- Educational documentation and tutorials
- Accessibility improvements
- Performance optimizations
- New MCP tool implementations

## Acknowledgments

- **Inspired by** Vercel's v0.app - demonstrating the power of AI-assisted development
- **Built with** Anthropic's Claude Agent SDK and Claude 3.5 Sonnet
- **UI Components** from shadcn-svelte
- **Designed for** academic students, researchers, and educators

## Support

For issues, questions, or educational inquiries, please open an issue on the repository.

---

**Site Studio** - Built with ❤️ for academic students and researchers
