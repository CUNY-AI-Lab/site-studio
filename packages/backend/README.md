# Site Studio Backend

Agent-powered backend server for Site Studio.

## Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Build TypeScript
npm run build

# Start server
npm start
```

## Development

```bash
npm run dev
```

## API Endpoints

### Projects

- `GET /api/projects` - List all projects
- `POST /api/projects` - Create a new project
  - Body: `{ "name": "my-site" }`
- `GET /api/projects/:id/files` - List files in project
- `GET /api/projects/:id/files/*` - Read a file

### Agent

- `POST /api/query` - Send a prompt to the agent (SSE streaming)
  - Body: `{ "prompt": "Create a portfolio page", "projectId": "my-site", "sessionId": "optional-session-id" }`

### Preview

- `GET /preview/:id/*` - Serve project files for live preview

## Tools Available

The agent has access to these tools:

**File Tools:**
- `list_files()` - List all project files
- `read_file(path)` - Read a file
- `write_file(path, content)` - Create/update a file
- `delete_file(path)` - Delete a file
- `create_directory(path)` - Create a directory

**Template Tools:**
- `scaffold_template(type)` - Create from template (blank, portfolio, blog)
- `add_page(name, title)` - Add a new HTML page
