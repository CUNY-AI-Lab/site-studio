import {
  SessionClient,
  fetchObservability,
  loadStoredCookie,
  parseArgs,
  persistSessionCookie,
  printObservabilitySummary,
  saveObservability,
} from './_debug-common.mjs';

function printUsage() {
  console.log(`Usage:
  node scripts/project-observability.mjs --project <id>

Options:
  --base-url http://127.0.0.1:8792
  --project <id>
  --cookie "site-studio-session=..."
  --json true
  --save true
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help === 'true' || !args.project) {
  printUsage();
  process.exit(args.help === 'true' ? 0 : 1);
}

const baseUrl = args['base-url'] || 'http://127.0.0.1:8792';
const session = new SessionClient(baseUrl, args.cookie || process.env.SITE_STUDIO_COOKIE || await loadStoredCookie());
await session.ensureSession();
await persistSessionCookie(session.cookie);

const observability = await fetchObservability(session, args.project);

if (args.json === 'true') {
  console.log(JSON.stringify(observability, null, 2));
} else {
  printObservabilitySummary(observability);
}

if (args.save === 'true') {
  const path = await saveObservability(observability, 'site-observability');
  console.log(`saved trace: ${path}`);
}
