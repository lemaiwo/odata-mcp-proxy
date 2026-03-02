declare module '@sap/xssec' {
  export interface SecurityContext {
    getUserName(): string;
    getEmail(): string | undefined;
    getGivenName(): string | undefined;
    getFamilyName(): string | undefined;
    getGrantedScopes(): string[];
    checkScope(scope: string): boolean;
  }

  const xssec: {
    createSecurityContext(
      token: string,
      credentials: Record<string, unknown>,
      callback: (err: Error | null, ctx?: SecurityContext) => void,
    ): void;
  };

  export default xssec;
}
