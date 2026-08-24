import { CAIL_CANONICAL_ISSUER } from "@cuny-ai-lab/cail-identity";
import { canonicalTestSubject, createTestIdentityIssuer } from "@cuny-ai-lab/cail-identity/testing";

const issuer = await createTestIdentityIssuer({
  kid: "site-studio-local-browser",
  issuer: CAIL_CANONICAL_ISSUER,
});
const subject = canonicalTestSubject("site-studio-local-browser");

const token = await issuer.mintIdentityJwt({
  audience: "cail:site-studio",
  subject,
  email: "site-studio-local-browser@gc.cuny.edu",
  name: "Site Studio Local Browser",
  entitlements: ["site-studio"],
});
const gatewayToken = await issuer.mintIdentityJwt({
  audience: "cail:gateway",
  subject,
  email: "site-studio-local-browser@gc.cuny.edu",
  name: "Site Studio Local Browser",
  entitlements: ["site-studio"],
});

console.log(
  JSON.stringify({
    jwks: issuer.jwksJson,
    issuer: CAIL_CANONICAL_ISSUER,
    token,
    gatewayToken,
  }),
);
