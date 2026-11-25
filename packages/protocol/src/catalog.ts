import { createHash } from "node:crypto";
import type { CatalogGroupDef, CatalogToolDef, ChangeRecord, CompactDeltaResult } from "./types.js";

export const CATALOG_GROUPS: CatalogGroupDef[] = [
  { id: "context", title: "Context", description: "Session health, open documents, selection and workspace state." },
  { id: "query", title: "Query", description: "Inspect elements, model queries, levels, grids and spatial data." },
  { id: "parameter", title: "Parameter", description: "Read and batch-update element parameters safely." },
  { id: "authoring", title: "Authoring", description: "Place families and create project elements safely." },
  { id: "automation", title: "Automation", description: "Multi-step transactional batch execution with $from references." }
];

export const CATALOG_TOOLS: CatalogToolDef[] = [
  {
    name: "session_get_health",
    group: "context",
    description: "Check Revit connector runtime health, queue depth, and active Revit version.",
    permissionLevel: "read",
    documentScope: "session",
    supportsDryRun: false,
    keywords: ["health", "status", "ping", "revit", "kiem tra ket noi"],
    payloadSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "document_list_open",
    group: "context",
    description: "List all open Revit documents with their opaque documentKey and active status.",
    permissionLevel: "read",
    documentScope: "session",
    supportsDryRun: false,
    keywords: ["document", "open", "list", "file", "du an dang mo"],
    payloadSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "element_inspect",
    group: "query",
    description: "Inspect one or more Revit elements by element ID (category, type, location, parameters).",
    permissionLevel: "read",
    documentScope: "document",
    supportsDryRun: false,
    keywords: ["inspect", "element", "id", "thong tin doi tuong", "kiem tra"],
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      required: ["elementIds"],
      properties: {
        elementIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50 },
        includeParameters: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "level_list",
    group: "query",
    description: "List all levels in the document with ID, name, and elevation in meters.",
    permissionLevel: "read",
    documentScope: "document",
    supportsDryRun: false,
    keywords: ["level", "cao do", "tang", "storey"],
    payloadSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "grid_list",
    group: "query",
    description: "List all datum grids in the document with ID, name, and start/end coordinates in meters.",
    permissionLevel: "read",
    documentScope: "document",
    supportsDryRun: false,
    keywords: ["grid", "luoi truc", "truc"],
    payloadSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "parameter_batch_set_safe",
    group: "parameter",
    description: "Update parameter values across multiple elements inside one TransactionGroup checkpoint.",
    permissionLevel: "mutate",
    documentScope: "document",
    supportsDryRun: true,
    keywords: ["parameter", "set", "batch", "dien tham bien", "hang loat"],
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      required: ["updates"],
      properties: {
        onlyEmpty: { type: "boolean", default: false },
        updates: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["elementId", "parameterName", "value"],
            properties: {
              elementId: { type: "integer" },
              parameterName: { type: "string", minLength: 1 },
              value: { type: ["string", "number", "boolean"] }
            }
          }
        }
      }
    }
  },
  {
    name: "family_place_point_safe",
    group: "authoring",
    description: "Place a point-based FamilyInstance (e.g. traffic sign, bollard, column) at (x, y, z) in meters.",
    permissionLevel: "mutate",
    documentScope: "document",
    supportsDryRun: true,
    keywords: ["family", "place", "point", "dat doi tuong", "bien bao", "atgt"],
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      required: ["familySymbolId", "levelId", "xMeter", "yMeter"],
      properties: {
        familySymbolId: { type: "integer" },
        levelId: { type: "integer" },
        xMeter: { type: "number" },
        yMeter: { type: "number" },
        zMeter: { type: "number", default: 0 },
        rotationDeg: { type: "number", default: 0 },
        comments: { type: "string" }
      }
    }
  },
  {
    name: "batch_execute_safe",
    group: "automation",
    description: "Execute multiple catalog tools in one TransactionGroup, supporting $from references between steps.",
    permissionLevel: "mutate",
    documentScope: "document",
    supportsDryRun: true,
    keywords: ["batch", "multi-step", "transaction", "chuoi lenh"],
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        onStepFailure: { type: "string", enum: ["rollback", "continue"], default: "rollback" },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref", "tool", "payload"],
            properties: {
              ref: { type: "string", minLength: 1, maxLength: 64 },
              tool: { type: "string", minLength: 1 },
              payload: { type: "object" }
            }
          }
        }
      }
    }
  }
];

export function computeCatalogVersion(): string {
  const canonical = JSON.stringify(
    CATALOG_TOOLS.map((t) => ({
      name: t.name,
      documentScope: t.documentScope,
      permissionLevel: t.permissionLevel,
      supportsDryRun: t.supportsDryRun,
      payloadSchema: t.payloadSchema
    }))
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildAdvertisedInputSchema(tool: CatalogToolDef): Record<string, unknown> {
  const required: string[] = ["instanceId", "payload"];
  const properties: Record<string, unknown> = {
    instanceId: { type: "string", description: "Connected Revit instanceId from revit_list_instances." },
    idempotencyKey: { type: "string", description: "Optional key to safely retry without duplicate execution." },
    payload: tool.payloadSchema
  };

  if (tool.documentScope === "document") {
    required.push("documentKey");
    properties.documentKey = {
      type: "string",
      pattern: "^[0-9a-f]{64}$",
      description: "64-hex documentKey from revit_list_instances."
    };
  }

  if (tool.supportsDryRun) {
    properties.dryRun = { type: "boolean", default: false, description: "Validate and preview changes without committing." };
  }

  if (tool.permissionLevel !== "read") {
    properties.expectedContext = {
      type: "string",
      description: "Optional document context fingerprint to prevent conflicting edits."
    };
    properties.response_detail = {
      type: "string",
      enum: ["compact_delta", "full"],
      default: "compact_delta"
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required,
    properties
  };
}

export function projectCompactDelta(
  changes: ChangeRecord | undefined,
  checkpointId: string | undefined,
  warningsCount = 0
): CompactDeltaResult {
  const MAX_IDS = 32;
  const added = changes?.added ?? [];
  const modified = changes?.modified ?? [];
  const deleted = changes?.deleted ?? [];

  return {
    checkpointId,
    createdIds: added.slice(0, MAX_IDS),
    modifiedIds: modified.slice(0, MAX_IDS),
    deletedIds: deleted.slice(0, MAX_IDS),
    createdCount: added.length,
    modifiedCount: modified.length,
    deletedCount: deleted.length,
    idsTruncated: added.length > MAX_IDS || modified.length > MAX_IDS || deleted.length > MAX_IDS,
    warningsCount
  };
}
