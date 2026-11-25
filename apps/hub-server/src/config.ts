import path from "node:path";

export interface HubConfig {
  port: number;
  host: string;
  /** Map of Bearer API key -> tenantId */
  apiKeys: Map<string, string>;
  heartbeatTimeoutMs: number;
  callTimeoutMs: number;
  resultRetentionMs: number;
  partByteLimit: number;
  knowledgeDir: string;
}

function parseApiKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const source = raw?.trim() || "dev-secret-key:default-tenant";
  for (const entry of source.split(",")) {
    const [key, tenant] = entry.split(":").map((s) => s.trim());
    if (key && tenant) {
      map.set(key, tenant);
    }
  }
  return map;
}

export function loadConfig(): HubConfig {
  return {
    port: Number(process.env.PORT ?? 8765),
    host: process.env.HOST ?? "0.0.0.0",
    apiKeys: parseApiKeys(process.env.API_KEYS),
    heartbeatTimeoutMs: Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 45_000),
    callTimeoutMs: Number(process.env.CALL_TIMEOUT_MS ?? 25_000),
    resultRetentionMs: Number(process.env.RESULT_RETENTION_MS ?? 30 * 60_000),
    partByteLimit: Number(process.env.PART_BYTE_LIMIT ?? 20_000),
    knowledgeDir: process.env.KNOWLEDGE_DIR ?? path.resolve(process.cwd(), "../../knowledge")
  };
}
