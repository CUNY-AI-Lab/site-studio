import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SandboxConfig {
  filesystem: {
    allowWrite: string[];
    denyRead: string[];
    denyWrite?: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets?: string[];
    allowLocalBinding?: boolean;
  };
}

const SANDBOXES_ROOT = process.env.SANDBOXES_DIR || path.join(__dirname, '../../sandboxes');

// Paths that should NEVER be accessible to any user
const GLOBAL_DENY_READ_PATHS = [
  '~/.ssh',
  '~/.aws',
  '~/.config',
  '~/.anthropic',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.config'),
];

// CDNs and services commonly needed for web development
const DEFAULT_ALLOWED_DOMAINS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'unpkg.com',
];

/**
 * Creates a sandbox configuration for a specific user and project
 */
export function createUserSandboxConfig(userId: string, projectId: string): SandboxConfig {
  const userProjectPath = path.join(SANDBOXES_ROOT, userId, projectId);
  const userUploadsPath = path.join(SANDBOXES_ROOT, userId, 'uploads');

  return {
    filesystem: {
      // Allow write only to this user's project and uploads directory
      allowWrite: [
        userProjectPath,
        userUploadsPath,
      ],
      // Deny reading sensitive paths and other users' directories
      denyRead: [
        ...GLOBAL_DENY_READ_PATHS,
        // Deny access to other users' sandboxes
        ...getOtherUsersSandboxPaths(userId),
      ],
      // Explicitly deny writing to system directories
      denyWrite: [
        '/etc',
        '/usr',
        '/bin',
        '/sbin',
        '/boot',
        '/sys',
        '/proc',
      ],
    },
    network: {
      // Allow only necessary CDNs for web development
      allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
      // Deny everything else by default
      deniedDomains: ['*'],
      // Allow Unix sockets for local IPC if needed
      allowUnixSockets: [],
      // Prevent binding to network ports
      allowLocalBinding: false,
    },
  };
}

/**
 * Get paths to other users' sandboxes to deny access
 */
function getOtherUsersSandboxPaths(currentUserId: string): string[] {
  // In production, you might query the database for all user IDs
  // For now, we use a glob pattern that denies everything except current user
  return [
    path.join(SANDBOXES_ROOT, `!(${currentUserId})`, '**'),
  ];
}

/**
 * Get the project path for a user's project within their sandbox
 */
export function getUserProjectPath(userId: string, projectId: string): string {
  return path.join(SANDBOXES_ROOT, userId, projectId);
}

/**
 * Get the uploads path for a user within their sandbox
 */
export function getUserUploadsPath(userId: string): string {
  return path.join(SANDBOXES_ROOT, userId, 'uploads');
}

/**
 * Environment variables for sandbox runtime
 */
export const SANDBOX_ENV = {
  // Set the sandboxes root directory
  SANDBOXES_ROOT,
  // Disable telemetry in sandboxed environment
  DO_NOT_TRACK: '1',
  // Limit Node.js memory usage
  NODE_OPTIONS: '--max-old-space-size=512',
};
