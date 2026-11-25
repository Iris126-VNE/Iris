import { createHash } from "node:crypto";
import WebSocket from "ws";
import {
  CATALOG_TOOLS,
  computeCatalogVersion,
  type ConnectorToHubMessage,
  type HubToConnectorMessage
} from "@revit-mcp/protocol";

const HUB_WS_URL = process.env.HUB_WS_URL ?? "ws://localhost:8765/ws/connector";
const API_KEY = process.env.API_KEY ?? "dev-secret-key";
const INSTANCE_ID = process.env.INSTANCE_ID ?? "revit-mock-2025-01";

const fakeDocKey = createHash("sha256").update("C:\\Projects\\Demo_ATGT.rvt").digest("hex");

const openDocuments = [
  {
    documentKey: fakeDocKey,
    title: "Demo_ATGT.rvt",
    isActive: true,
    isFamilyDocument: false,
    isReadOnly: false,
    contextFingerprint: "fp-demo-001"
  }
];

const ws = new WebSocket(HUB_WS_URL, {
  headers: { Authorization: `Bearer ${API_KEY}` }
});

ws.on("open", () => {
  console.log(`[mock-connector] Connected to ${HUB_WS_URL} as ${INSTANCE_ID}`);
  const hello: ConnectorToHubMessage = {
    type: "hello",
    instanceId: INSTANCE_ID,
    revitYear: 2025,
    machineAlias: "MOCK-WORKSTATION",
    catalogVersion: computeCatalogVersion(),
    supportedTools: CATALOG_TOOLS.map((t) => t.name),
    openDocuments
  };
  ws.send(JSON.stringify(hello));

  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const hb: ConnectorToHubMessage = {
        type: "heartbeat",
        instanceId: INSTANCE_ID,
        timestampUtc: new Date().toISOString(),
        openDocuments
      };
      ws.send(JSON.stringify(hb));
    }
  }, 15_000);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString("utf8")) as HubToConnectorMessage;
  if (msg.type === "hello_ack") {
    console.log(`[mock-connector] Handshake OK (catalogSkew=${msg.catalogSkew})`);
    return;
  }

  if (msg.type === "call_request") {
    console.log(`[mock-connector] Executing tool=${msg.tool} callId=${msg.callId} dryRun=${Boolean(msg.dryRun)}`);
    let result: unknown = { echo: msg.payload };
    let changes: ConnectorToHubMessage extends { type: "call_result" } ? never : any = undefined;

    if (msg.tool === "session_get_health") {
      result = { ok: true, revitYear: 2025, queueDepth: 0 };
    } else if (msg.tool === "document_list_open") {
      result = { documents: openDocuments };
    } else if (msg.tool === "level_list") {
      result = {
        levels: [
          { id: 311, name: "Level 1", elevationMeter: 0.0 },
          { id: 312, name: "Level 2", elevationMeter: 3.6 }
        ]
      };
    } else if (msg.tool === "parameter_batch_set_safe") {
      const updates = Array.isArray(msg.payload.updates) ? msg.payload.updates : [];
      const ids = updates.map((u: any) => Number(u.elementId)).filter((n) => !Number.isNaN(n));
      changes = {
        added: [],
        modified: ids,
        deleted: [],
        transactionNames: ["parameter_batch_set_safe"],
        changeKind: msg.dryRun ? "RolledBack" : "Committed"
      };
      result = { updatedCount: ids.length, dryRun: Boolean(msg.dryRun) };
    }

    const reply: ConnectorToHubMessage = {
      type: "call_result",
      callId: msg.callId,
      status: "succeeded",
      statusCode: "OK",
      checkpointName: msg.dryRun ? undefined : `chk_${msg.tool}`,
      result,
      changes,
      warningsCount: 0
    };
    ws.send(JSON.stringify(reply));
  }
});

ws.on("close", (code) => {
  console.log(`[mock-connector] Disconnected (code=${code})`);
});
