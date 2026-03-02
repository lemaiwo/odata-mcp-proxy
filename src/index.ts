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

// ── 2. Create one OData client per API (singletons — own OAuth token caching) ─
//
// Destinations are resolved lazily on the first request. The SDK caches
// destinations and tokens internally, so subsequent calls are fast.

interface ODataClientEntry {
  apiDef: (typeof apiConfig.apis)[number];
  client: ODataClient;
}

const odataClients: ODataClientEntry[] = apiConfig.apis.map((apiDef) => {
  const getDestination = (jwt?: string) => resolveDestination(apiDef.destination, jwt);

  const client = new ODataClient(
    getDestination,
    apiDef.pathPrefix,
    config.requestTimeout,
    apiDef.csrfProtected ?? true,
  );

  logger.info('OData client created', {
    apiName: apiDef.name,
    destination: apiDef.destination,
    pathPrefix: apiDef.pathPrefix,
    timeout: config.requestTimeout,
  });

  return { apiDef, client };
});

const allEntitySets = apiConfig.apis.flatMap((api) => api.entitySets);

logger.info('OData clients ready', {
  apis: apiConfig.apis.map((a) => a.name),
  totalDefinitions: allEntitySets.length,
  enabledCategories: config.enabledApiCategories,
});

// ── 3. Session factory ────────────────────────────────────────────────────────
//
// Each HTTP session (or the single stdio session) gets its own McpServer
// instance. McpServer.connect() can only be called once per instance, so
// re-using a singleton across sessions causes "Server already initialized"
// errors on reconnect.
//
// ODataClient instances are shared — they own their OAuth token caches.

function createMcpSession() {
  const server = createMcpServer(apiConfig.server.name, apiConfig.server.version);

  for (const { apiDef, client } of odataClients) {
    registerAllTools(server, client, apiDef.entitySets, config.enabledApiCategories);
  }

  registerApiDocResources(server, allEntitySets, apiConfig.server.name);

  return server;
}

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

  // Map of active sessions (sessionId -> transport + server) for stateful mode.
  type Session = {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    server: ReturnType<typeof createMcpSession>;
  };
  const sessions = new Map<string, Session>();

  // Handler for POST /mcp — initialization and JSON-RPC requests
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const body = req.body as { method?: string } | Array<{ method?: string }> | undefined;
    const isInitRequest = Array.isArray(body)
      ? body.some((m) => m?.method === 'initialize')
      : body?.method === 'initialize';

    // Non-initialize requests: route to existing session or 404.
    if (!isInitRequest) {
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // A non-initialize request with a missing/unknown session ID means the
      // session is gone (server restarted, session expired, client has a stale
      // ID). Return 404 so the client knows to start fresh.
      logger.debug('POST /mcp — session not found', {
        sessionIdHeader: sessionId ?? '(none)',
        method: Array.isArray(body) ? body.map((m) => m?.method).join(',') : (body?.method ?? '(none)'),
        activeSessions: sessions.size,
      });
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return;
    }

    // This is an initialize request.
    //
    // If there is an existing session for the given ID (client reconnecting
    // without first sending DELETE), close it gracefully before creating the
    // new one so we don't leak transports.
    if (sessionId && sessions.has(sessionId)) {
      const { server: oldServer } = sessions.get(sessionId)!;
      sessions.delete(sessionId);
      try { await oldServer.close(); } catch { /* ignore cleanup errors */ }
      logger.debug('Closed stale session before re-initialize', { sessionId });
    }

    // Re-use the client's session ID when one is present in the request.
    //
    // Some clients (e.g. MCP Inspector) pre-populate the previous session ID
    // in their request headers and rely on it for all subsequent requests in
    // the same connect() call — even after receiving a fresh ID from the
    // initialize response — because the old ID in requestInit.headers
    // overwrites the new one in the transport's _commonHeaders() merge.
    // By echoing back the same ID we keep the server and client in sync.
    const assignedSessionId = sessionId ?? randomUUID();

    const server = createMcpSession();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => assignedSessionId,
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, server });
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

    // Connect the fresh MCP server to this transport.
    await server.connect(transport);

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

    const { transport } = sessions.get(sessionId)!;
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

    const { transport } = sessions.get(sessionId)!;
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

  // ── 5. Graceful shutdown (HTTP) ───────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      logger.info('All MCP sessions closed');
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} else {
  // --------------------------------------------------------------------------
  // Stdio transport — single server instance, no session management needed
  // --------------------------------------------------------------------------
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  );

  const server = createMcpSession();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info(`${apiConfig.server.name} running on stdio transport`, {
    transport: 'stdio',
  });

  // ── 5. Graceful shutdown (stdio) ──────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      await server.close();
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
}
