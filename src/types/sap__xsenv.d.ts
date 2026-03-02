declare module '@sap/xsenv' {
  /**
   * Loads default-env.json (or a custom path) and sets VCAP_SERVICES,
   * VCAP_APPLICATION, and destinations into process.env.
   */
  function loadEnv(path?: string): void;

  /**
   * Looks up bound services by label, tag, or name and returns the credentials.
   * @param query - Map of result key to service selector ({ label?, tag?, name? })
   */
  function getServices(
    query: Record<string, { label?: string; tag?: string; name?: string }>,
  ): Record<string, Record<string, unknown>>;

  export default { loadEnv, getServices };
}
