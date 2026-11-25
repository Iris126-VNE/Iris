export type PermissionLevel = "read" | "mutate" | "file_lifecycle";
export type DocumentScope = "session" | "document";
export type ResponseDetail = "compact_delta" | "full";
export type CallStatus = "succeeded" | "failed" | "in_progress" | "refused";

export interface OpenDocumentInfo {
  /** SHA-256 hex digest of normalized document identity; raw local paths never leave the PC. */
  documentKey: string;
  title: string;
  isActive: boolean;
  isFamilyDocument: boolean;
  isReadOnly: boolean;
  contextFingerprint?: string;
}

export interface RevitInstanceInfo {
  instanceId: string;
  tenantId: string;
  channelBound: boolean;
  revitYear: number | null;
  machineAlias?: string;
  catalogVersion: string;
  lastSeenUtc: string;
  openDocuments: OpenDocumentInfo[];
}

export interface ChangeRecord {
  added: number[];
  modified: number[];
  deleted: number[];
  transactionNames: string[];
  changeKind: "Committed" | "RolledBack" | "GroupRolledBack" | "None";
}

export interface CompactDeltaResult {
  checkpointId?: string;
  createdIds: number[];
  modifiedIds: number[];
  deletedIds: number[];
  createdCount: number;
  modifiedCount: number;
  deletedCount: number;
  idsTruncated: boolean;
  warningsCount: number;
  verificationDigest?: string;
}

export interface McpCallResultEnvelope {
  schema: "mcp-call-result/1";
  status: CallStatus;
  statusCode: string;
  callId: string;
  instanceId: string;
  documentScope: DocumentScope;
  documentKey?: string;
  checkpointName?: string;
  result?: unknown;
  changes?: ChangeRecord;
  error?: {
    code: string;
    message: string;
    errorClass: "transient" | "fatal" | "capability";
    retryAfterMs?: number;
    recoveryHint?: string;
    outcomeUncertain?: boolean;
    details?: Record<string, unknown>;
  };
}

export interface PartedAnswerSlice {
  schema: "mcp-answer-part/1";
  part: number;
  parts: number;
  textSha256: string;
  next: {
    tool: "revit_read_result";
    arguments: {
      callId: string;
      part: number;
      textSha256: string;
    };
  } | null;
  text: string;
}

export interface CatalogGroupDef {
  id: string;
  title: string;
  description: string;
}

export interface CatalogToolDef {
  name: string;
  group: string;
  description: string;
  permissionLevel: PermissionLevel;
  documentScope: DocumentScope;
  supportsDryRun: boolean;
  /** JSON Schema for the tool's `payload` field */
  payloadSchema: Record<string, unknown>;
  keywords?: string[];
}

/** Messages sent between Hub Server and Revit Thin Connector over Outbound WSS */
export type ConnectorToHubMessage =
  | {
      type: "hello";
      instanceId: string;
      revitYear: number;
      machineAlias?: string;
      catalogVersion: string;
      supportedTools: string[];
      openDocuments: OpenDocumentInfo[];
    }
  | {
      type: "heartbeat";
      instanceId: string;
      timestampUtc: string;
      openDocuments: OpenDocumentInfo[];
    }
  | {
      type: "call_result";
      callId: string;
      status: "succeeded" | "failed";
      statusCode: string;
      checkpointName?: string;
      result?: unknown;
      changes?: ChangeRecord;
      warningsCount?: number;
      error?: McpCallResultEnvelope["error"];
    };

export type HubToConnectorMessage =
  | {
      type: "hello_ack";
      hubCatalogVersion: string;
      catalogSkew: boolean;
      heartbeatIntervalMs: number;
    }
  | {
      type: "call_request";
      callId: string;
      tool: string;
      documentKey?: string;
      dryRun?: boolean;
      expectedContext?: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "ping";
      timestampUtc: string;
    };
