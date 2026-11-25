/**
 * End-to-end smoke test against a running Hub Server + Mock Connector.
 * Usage:
 *   1. Terminal 1: npm run dev:hub
 *   2. Terminal 2: npm run mock:connector
 *   3. Terminal 3: npm run test:e2e
 */

const HUB_URL = process.env.HUB_URL ?? "http://localhost:8765/mcp";
const API_KEY = process.env.API_KEY ?? "dev-secret-key";

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(HUB_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const raw = await res.text();
    const dataLine = raw
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`Invalid SSE response: ${raw}`);
    return JSON.parse(dataLine.slice(5).trim());
  }
  return res.json();
}

async function main() {
  console.log("1. Listing Hub MCP tools (Door Pattern)...");
  const listRes = await rpc("tools/list");
  console.log("   Exposed tools:", listRes.result.tools.map((t: any) => t.name));

  console.log("2. Calling revit_list_instances...");
  const instRes = await rpc("tools/call", { name: "revit_list_instances", arguments: {} });
  const instData = JSON.parse(instRes.result.content[0].text);
  console.log("   Instances:", instData.instances.length);
  if (instData.instances.length === 0) {
    throw new Error("No connector online. Start mock-connector first.");
  }

  const inst = instData.instances[0];
  const docKey = inst.openDocuments[0].documentKey;

  console.log("3. Calling revit_call -> level_list...");
  const levelRes = await rpc("tools/call", {
    name: "revit_call",
    arguments: {
      tool: "level_list",
      arguments: { instanceId: inst.instanceId, documentKey: docKey, payload: {} }
    }
  });
  console.log("   Levels:", levelRes.result.content[0].text);

  console.log("4. Calling revit_call -> parameter_batch_set_safe (compact_delta + idempotencyKey)...");
  const mutRes = await rpc("tools/call", {
    name: "revit_call",
    arguments: {
      tool: "parameter_batch_set_safe",
      arguments: {
        instanceId: inst.instanceId,
        documentKey: docKey,
        idempotencyKey: "e2e-idem-001",
        payload: { updates: [{ elementId: 1001, parameterName: "Comments", value: "OK" }] }
      }
    }
  });
  console.log("   Mutation compact_delta:", mutRes.result.content[0].text);
  console.log("E2E smoke test PASSED.");
}

main().catch((err) => {
  console.error("E2E test FAILED:", err);
  process.exit(1);
});
