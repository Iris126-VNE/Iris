import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  computeCatalogVersion,
  projectCompactDelta,
  type ConnectorToHubMessage,
  type HubToConnectorMessage,
  type McpCallResultEnvelope
} from "@revit-mcp/protocol";
import type { HubConfig } from "./config.js";
import type { HubStore } from "./store.js";

interface PendingDispatch {
  resolve: (msg: Extract<ConnectorToHubMessage, { type: "call_result" }>) => void;
  timer: NodeJS.Timeout;
  onLateResult: (msg: Extract<ConnectorToHubMessage, { type: "call_result" }>) => void;
}

export class ConnectorRelay {
  private readonly wss: WebSocketServer;
  private readonly sockets = new Map<string, WebSocket>(); // instanceId -> ws
  private readonly pending = new Map<string, PendingDispatch>(); // callId -> handler
  private readonly lateHandlers = new Map<string, (msg: Extract<ConnectorToHubMessage, { type: "call_result" }>) => void>();
  public readonly liveCatalogVersion = computeCatalogVersion();

  constructor(
    server: HttpServer,
    private readonly config: HubConfig,
    private readonly store: HubStore
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/ws/connector") {
        socket.destroy();
        return;
      }

      const tenantId = this.authenticateRequest(req, url);
      if (!tenantId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, tenantId);
      });
    });
  }

  private authenticateRequest(req: IncomingMessage, url: URL): string | undefined {
    const authHeader = req.headers.authorization;
    let token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
    if (!token) {
      token = url.searchParams.get("token") ?? undefined;
    }
    if (!token) return undefined;
    return this.config.apiKeys.get(token);
  }

  private handleConnection(ws: WebSocket, tenantId: string): void {
    let boundInstanceId: string | undefined;

    ws.on("message", (raw) => {
      let msg: ConnectorToHubMessage;
      try {
        msg = JSON.parse(raw.toString("utf8")) as ConnectorToHubMessage;
      } catch {
        return;
      }

      if (msg.type === "hello") {
        boundInstanceId = msg.instanceId;
        this.sockets.set(msg.instanceId, ws);
        this.store.upsertInstance({
          instanceId: msg.instanceId,
          tenantId,
          channelBound: true,
          revitYear: msg.revitYear,
          machineAlias: msg.machineAlias,
          catalogVersion: msg.catalogVersion,
          lastSeenUtc: new Date().toISOString(),
          openDocuments: msg.openDocuments
        });

        const ack: HubToConnectorMessage = {
          type: "hello_ack",
          hubCatalogVersion: this.liveCatalogVersion,
          catalogSkew: msg.catalogVersion !== this.liveCatalogVersion,
          heartbeatIntervalMs: Math.floor(this.config.heartbeatTimeoutMs / 3)
        };
        ws.send(JSON.stringify(ack));
        console.log(`[relay] Connector online: ${msg.instanceId} (Revit ${msg.revitYear}, tenant=${tenantId})`);
        return;
      }

      if (msg.type === "heartbeat" && boundInstanceId) {
        const existing = this.store.getInstanceForTenant(tenantId, boundInstanceId);
        if (existing) {
          this.store.upsertInstance({
            ...existing,
            channelBound: true,
            lastSeenUtc: msg.timestampUtc,
            openDocuments: msg.openDocuments
          });
        }
        return;
      }

      if (msg.type === "call_result") {
        const pending = this.pending.get(msg.callId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.callId);
          pending.resolve(msg);
          return;
        }
        const late = this.lateHandlers.get(msg.callId);
        if (late) {
          this.lateHandlers.delete(msg.callId);
          late(msg);
        }
      }
    });

    ws.on("close", () => {
      if (boundInstanceId) {
        if (this.sockets.get(boundInstanceId) === ws) {
          this.sockets.delete(boundInstanceId);
          this.store.markInstanceOffline(boundInstanceId);
          console.log(`[relay] Connector offline: ${boundInstanceId}`);
        }
      }
    });
  }

  async dispatchCall(params: {
    callId: string;
    tenantId: string;
    instanceId: string;
    tool: string;
    documentScope: "session" | "document";
    documentKey?: string;
    isMutation: boolean;
    dryRun?: boolean;
    expectedContext?: string;
    payload: Record<string, unknown>;
  }): Promise<{ full: McpCallResultEnvelope; compact: McpCallResultEnvelope }> {
    const ws = this.sockets.get(params.instanceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const refused: McpCallResultEnvelope = {
        schema: "mcp-call-result/1",
        status: "refused",
        statusCode: "INSTANCE_OFFLINE",
        callId: params.callId,
        instanceId: params.instanceId,
        documentScope: params.documentScope,
        documentKey: params.documentKey,
        error: {
          code: "INSTANCE_OFFLINE",
          message: `Instance '${params.instanceId}' is not currently connected.`,
          errorClass: "transient",
          recoveryHint: "Open Revit with the connector running and re-check revit_list_instances."
        }
      };
      return { full: refused, compact: refused };
    }

    const buildEnvelopes = (
      res: Extract<ConnectorToHubMessage, { type: "call_result" }>
    ): { full: McpCallResultEnvelope; compact: McpCallResultEnvelope } => {
      const full: McpCallResultEnvelope = {
        schema: "mcp-call-result/1",
        status: res.status,
        statusCode: res.statusCode,
        callId: params.callId,
        instanceId: params.instanceId,
        documentScope: params.documentScope,
        documentKey: params.documentKey,
        checkpointName: res.checkpointName,
        result: res.result,
        changes: res.changes,
        error: res.error
      };

      const compact: McpCallResultEnvelope =
        params.isMutation && res.status === "succeeded"
          ? {
              ...full,
              result: projectCompactDelta(res.changes, res.checkpointName, res.warningsCount ?? 0)
            }
          : full;

      return { full, compact };
    };

    const reqMsg: HubToConnectorMessage = {
      type: "call_request",
      callId: params.callId,
      tool: params.tool,
      documentKey: params.documentKey,
      dryRun: params.dryRun,
      expectedContext: params.expectedContext,
      payload: params.payload
    };

    return new Promise((resolve) => {
      const onLateResult = (res: Extract<ConnectorToHubMessage, { type: "call_result" }>) => {
        const { full, compact } = buildEnvelopes(res);
        this.store.updateCall(params.callId, full, compact);
      };

      const timer = setTimeout(() => {
        this.pending.delete(params.callId);
        this.lateHandlers.set(params.callId, onLateResult);
        const inProgress: McpCallResultEnvelope = {
          schema: "mcp-call-result/1",
          status: "in_progress",
          statusCode: "EXECUTION_IN_PROGRESS",
          callId: params.callId,
          instanceId: params.instanceId,
          documentScope: params.documentScope,
          documentKey: params.documentKey
        };
        resolve({ full: inProgress, compact: inProgress });
      }, this.config.callTimeoutMs);

      this.pending.set(params.callId, {
        timer,
        onLateResult,
        resolve: (res) => resolve(buildEnvelopes(res))
      });

      ws.send(JSON.stringify(reqMsg));
    });
  }
}
