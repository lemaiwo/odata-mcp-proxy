#!/usr/bin/env node

// CLI entry point for the odata-mcp-proxy package.
//
// Usage:
//   odata-mcp-proxy                          # uses api-config.json from CWD
//   odata-mcp-proxy --config my-config.json  # custom config file
//
// All other settings are controlled via environment variables (see README).

const args = process.argv.slice(2);
const configIdx = args.indexOf('--config');
if (configIdx !== -1 && args[configIdx + 1]) {
  process.env.API_CONFIG_FILE = args[configIdx + 1];
}

await import('./index.js');
