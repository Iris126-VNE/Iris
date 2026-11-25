import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildAdvertisedInputSchema,
  CATALOG_GROUPS,
  CATALOG_TOOLS,
  type McpCallResultEnvelope
} from "@revit-mcp/protocol";
import type { KnowledgeBase } from "./knowledge.js";
import type { ConnectorRelay } from "./relay.js";
import type { HubStore } from "./store.js";

function asJsonText(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }]
  };
}

export function createTenantMcpServer(deps: {
  tenantId: string;
  store: HubStore;
  relay: ConnectorRelay;
  knowledge: KnowledgeBase;
}): McpServer {
  const { tenantId, store, relay, knowledge } = deps;

  const server = new McpServer({
    name: "revit-mcp-hub",
    version: "0.1.0"
  });

  // 1. revit_list_instances
  server.tool(
    "revit_list_instances",
    "List connected Revit instances and their open documents (opaque 64-hex documentKey) for this account.",
    {
      include_disconnected: z.boolean().optional().default(false)
    },
    async ({ include_disconnected }) => {
      const instances = store.listInstancesForTenant(tenantId, include_disconnected).map((inst) => ({
        ...inst,
        liveCatalogVersion: relay.liveCatalogVersion,
        catalogSkew: inst.catalogVersion !== relay.liveCatalogVersion
      }));

      return asJsonText({
        schema: "hosted-instances/1",
        liveCatalogVersion: relay.liveCatalogVersion,
        instances,
        nextStep:
          instances.length === 0
            ? {
                code: "open_revit_with_connector",
                instruction: "Open Revit on your PC and ensure the Revit MCP Connector add-in is connected."
              }
            : undefined
      });
    }
  );

  // 2. revit_find
  server.tool(
    "revit_find",
    "Find the right Revit catalog tools and how-to/standard cards in English or Vietnamese.",
    {
      query: z.string().min(1).max(300),
      regionProfile: z.enum(["tcvn_qcvn", "iso_iec", "en_eurocode", "us"]).optional(),
      limit: z.number().int().min(1).max(10).optional().default(5)
    },
    async ({ query, regionProfile, limit }) => {
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2);

      const matchedTools = CATALOG_TOOLS.map((tool) => {
        const hay = `${tool.name} ${tool.group} ${tool.description} ${(tool.keywords ?? []).join(" ")}`.toLowerCase();
        const score = terms.reduce((acc, term) => acc + (hay.includes(term) ? 1 : 0), 0);
        return { tool, score };
      })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ tool }) => ({
          name: tool.name,
          group: tool.group,
          description: tool.description,
          permissionLevel: tool.permissionLevel,
          documentScope: tool.documentScope,
          supportsDryRun: tool.supportsDryRun
        }));

      const cards = knowledge.search(query, regionProfile, limit).map((c) => ({
        ref: c.ref,
        kind: c.kind,
        title: c.title,
        summary: c.summary,
        relatedTools: c.relatedTools
      }));

      return asJsonText({
        query,
        tools: matchedTools,
        cards
      });
    }
  );

  // 3. revit_get
  server.tool(
    "revit_get",
    "Read a full how-to card or engineering standard reference by ref returned from revit_find.",
    {
      ref: z.string().min(1).max(120)
    },
    async ({ ref }) => {
      const doc = knowledge.get(ref);
      if (!doc) {
        return asJsonText({ error: "REF_NOT_FOUND", ref });
      }
      return asJsonText(doc);
    }
  );

  // 4. revit_tools
  server.tool(
    "revit_tools",
    "Catalog door: call with {} for groups, {group} for members, or {tool}/{tools} for exact advertised input schemas.",
    {
      group: z.string().optional(),
      tool: z.string().optional(),
      tools: z.array(z.string().min(1)).max(10).optional()
    },
    async ({ group, tool, tools }) => {
      if (tool || tools) {
        const names = tool ? [tool] : (tools ?? []);
        const found = names.map((name) => {
          const def = CATALOG_TOOLS.find((t) => t.name === name);
          if (!def) return { name, error: "TOOL_NOT_FOUND" };
          return {
            name: def.name,
            group: def.group,
            description: def.description,
            permissionLevel: def.permissionLevel,
            documentScope: def.documentScope,
            supportsDryRun: def.supportsDryRun,
            inputSchema: buildAdvertisedInputSchema(def)
          };
        });
        return asJsonText({ tools: found });
      }

      if (group) {
        const grp = CATALOG_GROUPS.find((g) => g.id === group);
        if (!grp) return asJsonText({ error: "GROUP_NOT_FOUND", group });
        const members = CATALOG_TOOLS.filter((t) => t.group === group).map((t) => ({
          name: t.name,
          description: t.description,
          permissionLevel: t.permissionLevel,
          documentScope: t.documentScope,
          supportsDryRun: t.supportsDryRun
        }));
        return asJsonText({ group: grp.id, title: grp.title, tools: members });
      }

      const groups = CATALOG_GROUPS.map((g) => ({
        ...g,
        memberCount: CATALOG_TOOLS.filter((t) => t.group === g.id).length
      }));
      return asJsonText({ catalogVersion: relay.liveCatalogVersion, groups });
    }
  );

  // 5. revit_call
  server.tool(
    "revit_call",
    "Execute one catalog tool on a connected Revit instance by exact name. Read its schema via revit_tools first.",
    {
      tool: z.string().min(1),
      arguments: z.record(z.unknown())
    },
    async ({ tool, arguments: args }) => {
      const def = CATALOG_TOOLS.find((t) => t.name === tool);
      const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

      if (!def) {
        const refused: McpCallResultEnvelope = {
          schema: "mcp-call-result/1",
          status: "refused",
          statusCode: "TOOL_NOT_FOUND",
          callId,
          instanceId: String(args.instanceId ?? ""),
          documentScope: "session",
          error: {
            code: "TOOL_NOT_FOUND",
            message: `Unknown catalog tool '${tool}'. Call revit_tools to inspect available tools.`,
            errorClass: "capability"
          }
        };
        return asJsonText(refused);
      }

      const instanceId = typeof args.instanceId === "string" ? args.instanceId : "";
      const documentKey = typeof args.documentKey === "string" ? args.documentKey : undefined;
      const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
      const dryRun = typeof args.dryRun === "boolean" ? args.dryRun : false;
      const expectedContext = typeof args.expectedContext === "string" ? args.expectedContext : undefined;
      const responseDetail = args.response_detail === "full" ? "full" : "compact_delta";
      const payload = (args.payload && typeof args.payload === "object" ? args.payload : {}) as Record<string, unknown>;

      if (!instanceId) {
        return asJsonText({
          schema: "mcp-call-result/1",
          status: "refused",
          statusCode: "INSTANCE_ID_REQUIRED",
          callId,
          instanceId: "",
          documentScope: def.documentScope
        });
      }

      if (def.documentScope === "document" && !documentKey) {
        return asJsonText({
          schema: "mcp-call-result/1",
          status: "refused",
          statusCode: "DOCUMENT_KEY_REQUIRED",
          callId,
          instanceId,
          documentScope: def.documentScope
        });
      }

      // Check tenant ownership of instance
      const inst = store.getInstanceForTenant(tenantId, instanceId);
      if (!inst || !inst.channelBound) {
        return asJsonText({
          schema: "mcp-call-result/1",
          status: "refused",
          statusCode: "INSTANCE_OFFLINE",
          callId,
          instanceId,
          documentScope: def.documentScope,
          documentKey
        });
      }

      // Idempotency check
      const argsHash = store.hashArgs({ tool, instanceId, documentKey, dryRun, payload });
      if (idempotencyKey) {
        const prev = store.lookupIdempotency(tenantId, idempotencyKey);
        if (prev) {
          if (prev.argsHash !== argsHash) {
            return asJsonText({
              schema: "mcp-call-result/1",
              status: "refused",
              statusCode: "IDEMPOTENCY_CONFLICT",
              callId,
              instanceId,
              documentScope: def.documentScope,
              documentKey
            });
          }
          const env = responseDetail === "full" ? prev.fullEnvelope : prev.compactEnvelope;
          return asJsonText(env);
        }
      }

      const { full, compact } = await relay.dispatchCall({
        callId,
        tenantId,
        instanceId,
        tool,
        documentScope: def.documentScope,
        documentKey,
        isMutation: def.permissionLevel !== "read",
        dryRun,
        expectedContext,
        payload
      });

      store.saveCall({
        callId,
        tenantId,
        tool,
        argsHash,
        idempotencyKey,
        fullEnvelope: full,
        compactEnvelope: compact,
        createdAtMs: Date.now()
      });

      const chosen = def.permissionLevel === "read" || responseDetail === "full" ? full : compact;
      const canonical = JSON.stringify(chosen);
      const slice = store.sliceText(callId, canonical, 1);
      return asJsonText(slice ?? chosen);
    }
  );

  // 6. revit_read_result
  server.tool(
    "revit_read_result",
    "Follow an in_progress call, read a parted answer slice, or fetch full unprojected result without re-executing.",
    {
      callId: z.string().min(1),
      part: z.number().int().min(1).optional(),
      textSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      response_detail: z.enum(["compact_delta", "full"]).optional().default("full")
    },
    async ({ callId, part, textSha256, response_detail }) => {
      const rec = store.getCall(tenantId, callId);
      if (!rec) {
        return asJsonText({ status: "failed", statusCode: "CALL_RESULT_EXPIRED", callId });
      }
      const env = response_detail === "compact_delta" ? rec.compactEnvelope : rec.fullEnvelope;
      const canonical = JSON.stringify(env);

      if (part !== undefined) {
        const slice = store.sliceText(callId, canonical, part);
        if (!slice) return asJsonText(env);
        if (textSha256 && slice.textSha256 !== textSha256) {
          return asJsonText({ error: "answer_changed", callId });
        }
        return asJsonText(slice);
      }

      const slice = store.sliceText(callId, canonical, 1);
      return asJsonText(slice ?? env);
    }
  );

  return server;
}
