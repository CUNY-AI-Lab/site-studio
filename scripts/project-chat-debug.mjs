import {
  SessionClient,
  connectAgent,
  createProject,
  fetchMessages,
  fetchObservability,
  loadStoredCookie,
  parseArgs,
  persistSessionCookie,
  printObservabilitySummary,
  saveObservability,
  sendChatTurn,
} from './_debug-common.mjs';

function printUsage() {
  console.log(`Usage:
  node scripts/project-chat-debug.mjs --prompt "Create a landing page"

Options:
  --base-url http://127.0.0.1:8792
  --project <id>
  --create "CLI Debug Project"
  --template blank
  --prompt "<message>"
  --idle-timeout-ms 60000
  --total-timeout-ms 180000
  --cookie "site-studio-session=..."
  --save true
  --quiet true
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help === 'true' || !args.prompt) {
  printUsage();
  process.exit(args.help === 'true' ? 0 : 1);
}

const baseUrl = args['base-url'] || 'http://127.0.0.1:8792';
const session = new SessionClient(baseUrl, args.cookie || process.env.SITE_STUDIO_COOKIE || await loadStoredCookie());
await session.ensureSession();
await persistSessionCookie(session.cookie);

let projectId = args.project;
if (!projectId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const project = await createProject(session, args.create || `CLI Debug Project ${stamp}`, args.template);
  projectId = project.id;
  console.log(`created project: ${projectId}`);
}

const messages = await fetchMessages(session, projectId);
const client = await connectAgent(session, projectId);

console.log(`project: ${projectId}`);
console.log(`agent-route: /api/agents/site-builder/${projectId}`);
console.log('--- stream ---');

const result = await sendChatTurn({
  client,
  messages,
  prompt: args.prompt,
  idleTimeoutMs: Number(args['idle-timeout-ms'] || 60000),
  totalTimeoutMs: Number(args['total-timeout-ms'] || 180000),
  verbose: args.quiet !== 'true',
});

console.log('--- result ---');
if (result.ok) {
  console.log(`completed request ${result.requestId}`);
} else {
  console.log(`incomplete request ${result.requestId}: ${result.reason}`);
}

const observability = await fetchObservability(session, projectId);
console.log('--- observability ---');
printObservabilitySummary(observability);

if (args.save === 'true') {
  const path = await saveObservability(observability, 'site-chat-trace');
  console.log(`saved trace: ${path}`);
}

client.close();
