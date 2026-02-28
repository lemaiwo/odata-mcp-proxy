import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.js';

/**
 * Creates a new MCP server instance configured with the given identity.
 *
 * The returned {@link McpServer} is **not** yet connected to any transport.
 * The caller is responsible for:
 *
 * 1. Registering tools (via {@link McpServer.tool} or the tool-registry helper).
 * 2. Connecting a transport (stdio or Streamable HTTP) by calling
 *    {@link McpServer.connect}.
 *
 * @param name    Server name advertised during the MCP initialization handshake.
 * @param version Server version advertised during the MCP initialization handshake.
 * @returns A configured but not-yet-connected McpServer instance.
 */
export function createMcpServer(name: string, version: string): McpServer {
  const server = new McpServer({
    name,
    version,
  });

  logger.info('MCP server instance created', {
    name,
    version,
  });

  return server;
}
