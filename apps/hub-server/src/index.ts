import http from "node:http";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { KnowledgeBase } from "./knowledge.js";
import { createTenantMcpServer } from "./mcp.js";
import { ConnectorRelay } from "./relay.js";
import { HubStore } from "./store.js";

const config = loadConfig();
const store = new HubStore(config.resultRetentionMs, config.partByteLimit);
const knowledge = new KnowledgeBase(config.knowledgeDir);

const app = express();
app.use(express.json({ limit: "2mb" }));

const httpServer = http.createServer(app);
const relay = new ConnectorRelay(httpServer, config, store);

function authenticateHttp(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return undefined;
  return config.apiKeys.get(auth.slice(7).trim());
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    catalogVersion: relay.liveCatalogVersion,
    timestampUtc: new Date().toISOString()
  });
});

// Stateless Streamable HTTP MCP endpoint (ideal for horizontally scalable hosted hubs)
app.post("/mcp", async (req, res) => {
  const tenantId = authenticateHttp(req);
  if (!tenantId) {
    res.status(401).json({ error: "Unauthorized: missing or invalid Bearer token" });
    return;
  }

  const mcpServer = createTenantMcpServer({ tenantId, store, relay, knowledge });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

httpServer.listen(config.port, config.host, () => {
  console.log(`[hub-server] Hosted Revit MCP Hub listening on http://${config.host}:${config.port}`);
  console.log(`[hub-server] MCP Endpoint : POST http://${config.host}:${config.port}/mcp`);
  console.log(`[hub-server] Connector WSS: ws://${config.host}:${config.port}/ws/connector`);
  console.log(`[hub-server] Catalog Ver  : ${relay.liveCatalogVersion.slice(0, 12)}...`);
});
