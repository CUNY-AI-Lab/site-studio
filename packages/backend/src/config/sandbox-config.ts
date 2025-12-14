/**
 * SDK Sandbox Configuration
 *
 * Enables OS-level sandboxing (Linux bubblewrap) for safe Bash command execution.
 * When enabled, agents can run commands like `hugo`, `npm`, etc. in an isolated environment.
 */

export interface SandboxConfig {
  enabled: boolean;
  autoAllowBash: boolean;
  network: {
    allowLocalBinding: boolean;
  };
}

/**
 * Read sandbox configuration from environment variables
 */
export function getSandboxConfig(): SandboxConfig {
  return {
    enabled: process.env.AGENT_SANDBOX_ENABLED === 'true',
    autoAllowBash: process.env.AGENT_SANDBOX_AUTO_ALLOW_BASH === 'true',
    network: {
      allowLocalBinding: process.env.AGENT_SANDBOX_ALLOW_LOCAL_BINDING === 'true',
    },
  };
}

/**
 * Build SDK sandbox settings from config
 * Returns undefined if sandbox is disabled
 */
export function buildSandboxSettings(config: SandboxConfig) {
  if (!config.enabled) return undefined;

  return {
    enabled: true,
    autoAllowBashIfSandboxed: config.autoAllowBash,
    allowUnsandboxedCommands: false, // Never allow escaping the sandbox
    network: {
      allowLocalBinding: config.network.allowLocalBinding,
    },
  };
}
