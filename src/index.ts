// =============================================================================
// MCP Server — Main Entry Point
//
// Wires together configuration, destination resolution, OData client,
// MCP server + tool registration, and the chosen transport (HTTP or stdio).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { config, apiConfig } from './config/index.js';
import { initLogger, logger } from './utils/logger.js';
import { resolveDestination } from './client/destination-service.js';
import { ODataClient } from './client/odata-client.js';
import { createMcpServer } from './server/mcp-server.js';
import { registerAllTools } from './tools/registry.js';
import { registerApiDocResources } from './resources/index.js';

// ── 1. Initialize logger with configured level ─────────────────────────────

initLogger(config.logLevel);
logger.info(`Starting ${apiConfig.server.name}`, {
  transport: config.mcpTransport,
  port: config.mcpTransport === 'http' ? config.port : 'N/A',
  logLevel: config.logLevel,
  enabledCategories: config.enabledApiCategories,
});

// ── 2. Create OData client ──────────────────────────────────────────────────
//
// The destination is resolved lazily on the first request. The SDK caches
// destinations and tokens internally, so subsequent calls are fast.

const getDestination = (jwt?: string) => resolveDestination(config.sapDestinationName, jwt);

const odataClient = new ODataClient(
  getDestination,
  apiConfig.api.pathPrefix,
  config.requestTimeout,
);

logger.info('OData client created', {
  destinationName: config.sapDestinationName,
  timeout: config.requestTimeout,
});

// ── 3. Create MCP server and register tools ─────────────────────────────────

const mcpServer = createMcpServer(apiConfig.server.name, apiConfig.server.version);

registerAllTools(
  mcpServer,
  odataClient,
  apiConfig.entitySets,
  config.enabledApiCategories,
);

registerApiDocResources(mcpServer, apiConfig.entitySets, apiConfig.server.name);

logger.info('MCP server ready', {
  totalDefinitions: apiConfig.entitySets.length,
  enabledCategories: config.enabledApiCategories,
});

// ── 4. Start the chosen transport ───────────────────────────────────────────

if (config.mcpTransport === 'http') {
  // --------------------------------------------------------------------------
  // HTTP transport — Streamable HTTP over Express
  // --------------------------------------------------------------------------
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { createHttpServer, startHttpServer } = await import(
    './server/http.js'
  );

  const app = createHttpServer(config.port);

  // Map of active sessions (sessionId -> transport) for stateful mode.
  const sessions = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  // Handler for POST /mcp — initialization and JSON-RPC requests
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // If the request carries a session ID, route to the existing transport.
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No existing session — create a new transport for this session.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, transport);
        logger.debug('MCP session initialized', { sessionId: id });
      },
    });

    // Clean up when the transport closes.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        logger.debug('MCP session closed', { sessionId: sid });
      }
    };

    // Connect the MCP server to this transport.
    await mcpServer.connect(transport);

    // Handle the initial request (which will be the initialization handshake).
    await transport.handleRequest(req, res, req.body);
  });

  // Handler for GET /mcp — SSE stream for server-to-client notifications
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid mcp-session-id header.',
      });
      return;
    }

    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // Handler for DELETE /mcp — session termination
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid mcp-session-id header.',
      });
      return;
    }

    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
  });

  // Start listening
  await startHttpServer(app, config.port);

  logger.info(`${apiConfig.server.name} running on HTTP port ${config.port}`, {
    transport: 'http',
    port: config.port,
    healthCheck: `http://localhost:${config.port}/health`,
    mcpEndpoint: `http://localhost:${config.port}/mcp`,
  });
} else {
  // --------------------------------------------------------------------------
  // Stdio transport
  // --------------------------------------------------------------------------
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  );

  const transport = new StdioServerTransport();

  await mcpServer.connect(transport);

  logger.info(`${apiConfig.server.name} running on stdio transport`, {
    transport: 'stdio',
  });
}

// ── 5. Graceful shutdown ────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    await mcpServer.close();
    logger.info('MCP server closed');
  } catch (error) {
    logger.error('Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
