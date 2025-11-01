import { discovery, buildAuthorizationUrl, authorizationCodeGrant, randomNonce, randomState, ClientSecretPost, Configuration } from 'openid-client';

let microsoftConfig: Configuration | null = null;

function getBaseUrl(): string {
  return process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
}

export async function getMicrosoftConfig(): Promise<Configuration> {
  if (microsoftConfig) return microsoftConfig;
  const tenant = process.env.AZURE_TENANT_ID || 'organizations';
  const issuer = new URL(`https://login.microsoftonline.com/${tenant}/v2.0`);
  const clientId = process.env.AZURE_CLIENT_ID!;
  const clientSecret = process.env.AZURE_CLIENT_SECRET!;
  if (!clientId || !clientSecret) {
    throw new Error('Azure AD OIDC requires AZURE_CLIENT_ID and AZURE_CLIENT_SECRET');
  }
  // Discover server metadata and bind client credentials
  microsoftConfig = await discovery(issuer, clientId, undefined, ClientSecretPost(clientSecret));
  return microsoftConfig;
}

export function generateState(): string {
  return randomState();
}

export function generateNonce(): string {
  return randomNonce();
}

export async function getMicrosoftAuthorizationUrl(state: string, nonce: string): Promise<string> {
  const config = await getMicrosoftConfig();
  const redirectUri = `${getBaseUrl()}/api/auth/callback/microsoft`;
  const url = buildAuthorizationUrl(config, {
    scope: 'openid email profile',
    state,
    nonce,
    response_type: 'code',
    redirect_uri: redirectUri,
    prompt: 'select_account',
  });
  return url.toString();
}

export async function redeemMicrosoftCode(currentRequestUrl: string, expectedState: string, expectedNonce: string) {
  const config = await getMicrosoftConfig();
  const tokens = await authorizationCodeGrant(
    config,
    new URL(currentRequestUrl),
    { expectedState, expectedNonce }
  );
  // The function returns TokenEndpointResponse & helpers; id_token claims parsed via oauth4webapi? openid-client v6 needs fetchUserInfo or decode id_token; id_token claims exposed on tokens.id_token? we'll rely on helpers
  return tokens;
}
