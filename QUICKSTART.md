# Quick Start Guide

Get Site Studio running in 3 steps!

## Step 1: Install Dependencies

```bash
cd site-studio
npm install
```

This installs dependencies for both backend and frontend packages.

## Step 2: Set Up Backend

```bash
cd packages/backend
cp .env.example .env
npm run build
cd ../..
```

## Step 3: Run the App

From the root `site-studio` directory:

```bash
npm run dev
```

This starts both:
- **Backend**: http://localhost:3001
- **Frontend**: http://localhost:5173

Open http://localhost:5173 in your browser!

## First Project

1. You'll see a dialog asking for a project name
2. Enter something like `my-first-site`
3. Click "Create Project"
4. Try these prompts in the chat:
   - "Create a portfolio template"
   - "Add an about page"
   - "Make the header background blue"

## Troubleshooting

### "Module not found" errors
Run `npm install` again from the root directory.

### Backend won't start
Make sure you've run `npm run build` in `packages/backend`

### Agent not responding
Check that you're logged in to Claude Code (it uses your Claude.ai subscription).

### Preview not loading
Wait a few seconds after the agent creates files, then click the refresh button.

## What's Next?

- Try the other templates: `"Create a blog template"`
- Ask the agent to customize colors and styles
- Add more pages: `"Add a contact page with a form"`
- Edit files directly in the code editor
- Check the README.md for full documentation

Enjoy building! 🎨
