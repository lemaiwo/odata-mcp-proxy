declare module '@sap/xsenv' {
  /**
   * Loads default-env.json (or a custom path) and sets VCAP_SERVICES,
   * VCAP_APPLICATION, and destinations into process.env.
   */
  function loadEnv(path?: string): void;

  export default { loadEnv };
}
