/**
 * Environment variable validation module
 * Validates required environment variables at startup to fail fast
 */

interface ValidationResult {
  valid: boolean;
  missing: string[];
  errors: string[];
}

/**
 * Validates all required environment variables based on configuration
 * Exits the process if validation fails
 */
export function validateEnvironment(): void {
  const result: ValidationResult = {
    valid: true,
    missing: [],
    errors: [],
  };

  // Validate storage configuration
  const storageType = process.env.STORAGE_TYPE || 'filesystem';

  if (storageType === 'r2') {
    const r2Required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

    for (const key of r2Required) {
      if (!process.env[key]) {
        result.missing.push(key);
        result.valid = false;
      }
    }

    if (!process.env.R2_BUCKET_NAME) {
      console.warn('⚠️  R2_BUCKET_NAME not set, using default: "site-studio"');
    }
  }

  // Validate AI provider configuration
  const usesBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === '1';
  const usesVertex = process.env.CLAUDE_CODE_USE_VERTEX === '1';

  if (usesBedrock) {
    const bedrockRequired = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

    for (const key of bedrockRequired) {
      if (!process.env[key]) {
        result.missing.push(key);
        result.valid = false;
      }
    }
  } else if (usesVertex) {
    // Vertex AI uses Application Default Credentials, but we can warn if not set
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.warn('⚠️  GOOGLE_APPLICATION_CREDENTIALS not set, ensure gcloud auth is configured');
    }
  } else {
    // Default to Anthropic API
    if (!process.env.ANTHROPIC_API_KEY) {
      result.missing.push('ANTHROPIC_API_KEY');
      result.valid = false;
    }
  }

  // Validate internal auth token (no default allowed)
  if (!process.env.INTERNAL_AUTH_TOKEN) {
    console.warn('⚠️  INTERNAL_AUTH_TOKEN not set, internal endpoints will be inaccessible');
  }

  // Validate auth mode
  const authMode = process.env.AUTH_MODE || 'anonymous';
  if (authMode !== 'anonymous' && authMode !== 'required') {
    result.errors.push(`Invalid AUTH_MODE: "${authMode}". Must be "anonymous" or "required"`);
    result.valid = false;
  }

  // Report results
  if (!result.valid) {
    console.error('❌ Environment validation failed!\n');

    if (result.missing.length > 0) {
      console.error('Missing required environment variables:');
      for (const key of result.missing) {
        console.error(`  - ${key}`);
      }
    }

    if (result.errors.length > 0) {
      console.error('\nConfiguration errors:');
      for (const error of result.errors) {
        console.error(`  - ${error}`);
      }
    }

    console.error('\nPlease check your .env file and environment configuration.');
    console.error('See packages/backend/.env.example for reference.\n');

    process.exit(1);
  }

  // Success - log configuration summary
  console.log('✅ Environment validation passed');
  console.log(`   Storage: ${storageType}`);
  console.log(`   AI Provider: ${usesBedrock ? 'AWS Bedrock' : usesVertex ? 'Google Vertex' : 'Anthropic API'}`);
  console.log(`   Auth Mode: ${authMode}`);
}

/**
 * Get an environment variable with a fallback value
 * Logs a warning if fallback is used
 */
export function getEnvOrDefault(key: string, defaultValue: string, warnIfMissing = true): string {
  const value = process.env[key];

  if (!value) {
    if (warnIfMissing) {
      console.warn(`⚠️  ${key} not set, using default: "${defaultValue}"`);
    }
    return defaultValue;
  }

  return value;
}

/**
 * Get a required environment variable or throw an error
 */
export function getRequiredEnv(key: string): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}
