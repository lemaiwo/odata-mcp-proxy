// =============================================================================
// Scope extraction
//
// Identity providers put granted permissions in different claims and shapes:
//   - XSUAA:     `scope`  as an array            ["odata-mcp-proxy!t1.read"]
//   - Okta/KC:   `scope`  as a space-separated string "openid read write"
//   - Entra ID:  `scp`    as a space-separated string (delegated scopes)
//                `roles`  as an array (app roles assigned to the user)
// =============================================================================

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(/\s+/).filter((s) => s.length > 0);
  return [];
}

/** Collect every granted scope / role from a decoded JWT payload. */
export function extractScopes(payload: Record<string, unknown>): string[] {
  return [...new Set([...toList(payload.scope), ...toList(payload.scp), ...toList(payload.roles)])];
}
