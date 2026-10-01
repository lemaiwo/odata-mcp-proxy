// =============================================================================
// User propagation (self-hosted)
//
// Turns the signed-in user's validated OIDC access token into a backend token
// for that same user, without the BTP Destination Service. Works with any
// OIDC identity provider because the proxy performs the exchange itself:
//
//   saml-bearer    — the proxy signs a SAML 2.0 assertion for the user and
//                    trades it at the backend's OAuth server (RFC 7522). Same
//                    flow as BTP's OAuth2SAMLBearerAssertion destinations;
//                    supported by SAP ABAP / S/4HANA (on-prem and Cloud).
//   jwt-bearer     — the user's token is presented as an assertion (RFC 7523)
//                    to an authorization server that trusts the IdP.
//   token-exchange — OAuth 2.0 Token Exchange (RFC 8693) at an authorization
//                    server that supports it (Keycloak, Okta, Auth0, …).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SignedXml } from 'xml-crypto';

export type UserAuthType = 'saml-bearer' | 'jwt-bearer' | 'token-exchange';
export const USER_AUTH_TYPES: readonly UserAuthType[] = ['saml-bearer', 'jwt-bearer', 'token-exchange'];

/**
 * Decode a JWT payload WITHOUT verifying it. Only call this on tokens the
 * inbound auth middleware has already validated.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Malformed user token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

/** Accept either an inline PEM (literal "\n" allowed, for env vars) or a file path. */
export function readPem(value: string): string {
  return value.includes('-----BEGIN') ? value.replace(/\\n/g, '\n') : readFileSync(value, 'utf-8');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface SamlAssertionOptions {
  /** Issuer — must match the trusted SAML provider name configured in SAP. */
  issuer: string;
  /** Audience — the SAP system's own SAML provider name. */
  audience: string;
  /** Recipient — the backend OAuth token endpoint. */
  recipient: string;
  /** Subject NameID, e.g. the user's email or SAP user ID. */
  nameId: string;
  nameIdFormat: string;
  /** PEM private key used to sign the assertion. */
  signingKey: string;
  /** PEM certificate embedded in KeyInfo (must be trusted by SAP). */
  signingCert: string;
  /** Assertion lifetime in seconds (default 600). */
  lifetimeSeconds?: number;
  now?: Date;
}

/** Build and sign (RSA-SHA256, exclusive c14n) a SAML 2.0 bearer assertion. */
export function buildSamlAssertion(opts: SamlAssertionOptions): string {
  const now = opts.now ?? new Date();
  const notBefore = new Date(now.getTime() - 60_000).toISOString(); // clock-skew allowance
  const notOnOrAfter = new Date(now.getTime() + (opts.lifetimeSeconds ?? 600) * 1000).toISOString();
  const issueInstant = now.toISOString();

  const xml =
    `<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" ` +
    `IssueInstant="${issueInstant}" Version="2.0">` +
    `<saml2:Issuer>${xmlEscape(opts.issuer)}</saml2:Issuer>` +
    `<saml2:Subject>` +
    `<saml2:NameID Format="${xmlEscape(opts.nameIdFormat)}">${xmlEscape(opts.nameId)}</saml2:NameID>` +
    `<saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${xmlEscape(opts.recipient)}"/>` +
    `</saml2:SubjectConfirmation>` +
    `</saml2:Subject>` +
    `<saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml2:AudienceRestriction><saml2:Audience>${xmlEscape(opts.audience)}</saml2:Audience></saml2:AudienceRestriction>` +
    `</saml2:Conditions>` +
    `<saml2:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_${randomUUID()}">` +
    `<saml2:AuthnContext><saml2:AuthnContextClassRef>` +
    `urn:oasis:names:tc:SAML:2.0:ac:classes:PreviousSession` +
    `</saml2:AuthnContextClassRef></saml2:AuthnContext>` +
    `</saml2:AuthnStatement>` +
    `</saml2:Assertion>`;

  const sig = new SignedXml({
    privateKey: opts.signingKey,
    publicCert: opts.signingCert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "/*[local-name()='Assertion']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  // SAML schema: <Signature> must directly follow <Issuer>.
  sig.computeSignature(xml, {
    location: { reference: "/*[local-name()='Assertion']/*[local-name()='Issuer']", action: 'after' },
  });
  return sig.getSignedXml();
}

/** Settings for one destination's user-propagating grant (from `{PREFIX}_*` env vars). */
export interface UserGrantSettings {
  type: UserAuthType;
  tokenUrl: string;
  clientId: string;
  scope?: string;
  // saml-bearer
  samlIssuer?: string;
  samlAudience?: string;
  samlNameIdClaim?: string;
  samlNameIdFormat?: string;
  samlSigningKey?: string;
  samlSigningCert?: string;
  samlAssertionEncoding?: 'base64url' | 'base64';
  // token-exchange
  exchangeAudience?: string;
  exchangeResource?: string;
}

/**
 * Build the token-request body for a user-propagating grant. Client
 * authentication (HTTP Basic) is added by the caller.
 */
export function buildUserGrantParams(
  settings: UserGrantSettings,
  userJwt: string,
  claims: Record<string, unknown>,
): URLSearchParams {
  const params = new URLSearchParams({ client_id: settings.clientId });

  switch (settings.type) {
    case 'saml-bearer': {
      const claimName = settings.samlNameIdClaim ?? 'email';
      const nameId = claims[claimName];
      if (typeof nameId !== 'string' || nameId.length === 0) {
        throw new Error(`User token has no "${claimName}" claim to use as the SAML NameID`);
      }
      const assertion = buildSamlAssertion({
        issuer: settings.samlIssuer!,
        audience: settings.samlAudience!,
        recipient: settings.tokenUrl,
        nameId,
        nameIdFormat: settings.samlNameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
        signingKey: settings.samlSigningKey!,
        signingCert: settings.samlSigningCert!,
      });
      params.set('grant_type', 'urn:ietf:params:oauth:grant-type:saml2-bearer');
      params.set('assertion', Buffer.from(assertion, 'utf-8').toString(settings.samlAssertionEncoding ?? 'base64url'));
      break;
    }
    case 'jwt-bearer':
      params.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      params.set('assertion', userJwt);
      break;
    case 'token-exchange':
      params.set('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
      params.set('subject_token', userJwt);
      params.set('subject_token_type', 'urn:ietf:params:oauth:token-type:access_token');
      params.set('requested_token_type', 'urn:ietf:params:oauth:token-type:access_token');
      if (settings.exchangeAudience) params.set('audience', settings.exchangeAudience);
      if (settings.exchangeResource) params.set('resource', settings.exchangeResource);
      break;
  }

  if (settings.scope) params.set('scope', settings.scope);
  return params;
}
