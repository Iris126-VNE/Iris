import { createHash } from "node:crypto";
import type {
  McpCallResultEnvelope,
  PartedAnswerSlice,
  RevitInstanceInfo
} from "@revit-mcp/protocol";

export interface StoredCallRecord {
  callId: string;
  tenantId: string;
  tool: string;
  argsHash: string;
  idempotencyKey?: string;
  fullEnvelope: McpCallResultEnvelope;
  compactEnvelope: McpCallResultEnvelope;
  createdAtMs: number;
}

export class HubStore {
  private readonly instances = new Map<string, RevitInstanceInfo>();
  private readonly calls = new Map<string, StoredCallRecord>();
  private readonly idempotencyIndex = new Map<string, string>(); // `${tenantId}:${key}` -> callId

  constructor(private readonly retentionMs: number, private readonly partByteLimit: number) {}

  upsertInstance(info: RevitInstanceInfo): void {
    this.instances.set(info.instanceId, info);
  }

  markInstanceOffline(instanceId: string): void {
    const existing = this.instances.get(instanceId);
    if (existing) {
      this.instances.set(instanceId, { ...existing, channelBound: false });
    }
  }

  getInstanceForTenant(tenantId: string, instanceId: string): RevitInstanceInfo | undefined {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.tenantId !== tenantId) return undefined;
    return inst;
  }

  listInstancesForTenant(tenantId: string, includeDisconnected = false): RevitInstanceInfo[] {
    const result: RevitInstanceInfo[] = [];
    for (const inst of this.instances.values()) {
      if (inst.tenantId !== tenantId) continue;
      if (!includeDisconnected && !inst.channelBound) continue;
      result.push(inst);
    }
    return result;
  }

  hashArgs(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  lookupIdempotency(tenantId: string, key: string): StoredCallRecord | undefined {
    const callId = this.idempotencyIndex.get(`${tenantId}:${key}`);
    if (!callId) return undefined;
    return this.getCall(tenantId, callId);
  }

  saveCall(record: StoredCallRecord): void {
    this.calls.set(record.callId, record);
    if (record.idempotencyKey) {
      this.idempotencyIndex.set(`${record.tenantId}:${record.idempotencyKey}`, record.callId);
    }
    this.pruneExpired();
  }

  updateCall(callId: string, fullEnvelope: McpCallResultEnvelope, compactEnvelope: McpCallResultEnvelope): void {
    const existing = this.calls.get(callId);
    if (!existing) return;
    existing.fullEnvelope = fullEnvelope;
    existing.compactEnvelope = compactEnvelope;
  }

  getCall(tenantId: string, callId: string): StoredCallRecord | undefined {
    const rec = this.calls.get(callId);
    if (!rec || rec.tenantId !== tenantId) return undefined;
    if (Date.now() - rec.createdAtMs > this.retentionMs) {
      this.calls.delete(callId);
      return undefined;
    }
    return rec;
  }

  /** Split canonical JSON text into <= partByteLimit UTF-8 slices */
  sliceText(callId: string, canonicalText: string, part = 1): PartedAnswerSlice | null {
    const buf = Buffer.from(canonicalText, "utf8");
    if (buf.byteLength <= this.partByteLimit && part === 1) {
      return null; // No parting needed
    }

    const textSha256 = createHash("sha256").update(buf).digest("hex");
    const chunks: string[] = [];
    let offset = 0;
    while (offset < buf.byteLength) {
      let end = Math.min(offset + this.partByteLimit, buf.byteLength);
      // Avoid splitting a multi-byte UTF-8 character
      while (end > offset && end < buf.byteLength && (buf[end] & 0xc0) === 0x80) {
        end--;
      }
      chunks.push(buf.subarray(offset, end).toString("utf8"));
      offset = end;
    }

    const totalParts = chunks.length;
    const safePart = Math.max(1, Math.min(part, totalParts));
    return {
      schema: "mcp-answer-part/1",
      part: safePart,
      parts: totalParts,
      textSha256,
      next:
        safePart < totalParts
          ? {
              tool: "revit_read_result",
              arguments: { callId, part: safePart + 1, textSha256 }
            }
          : null,
      text: chunks[safePart - 1]
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, rec] of this.calls.entries()) {
      if (now - rec.createdAtMs > this.retentionMs) {
        this.calls.delete(id);
      }
    }
  }
}
