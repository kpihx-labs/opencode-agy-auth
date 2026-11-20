/**
 * v2-clean.ts — V2-only Antigravity provider plugin.
 *
 * Invariants:
 *  - `options.ids` (default ["agy"]) declares N independent accounts. Each
 *    maps to one OpenCode integration + provider and one OAuth credential
 *    stored by OpenCode — never in a plugin file.
 *  - No account/model namespacing, no plugin-owned secret store, no failover.
 *  - Catalogs come from each account's live quota, are loaded before the
 *    synchronous transforms, and are replayed on credential changes.
 *  - HTTP hooks are registered ONCE and are provider-agnostic: any request to
 *    a Google Generative Language endpoint is rewritten to the Antigravity
 *    internal endpoint. Legacy sessions (`google-agy`) and agent-level model
 *    overrides are therefore covered without special cases.
 *  - All request shaping lives in small pure helpers below, not inline patches.
 */
import { spawn } from "node:child_process";

import { authorizeAgy, exchangeAgyWithVerifier } from "./sdk/oauth";
import { parseOAuthCallbackInput } from "./plugin/oauth-authorize";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./plugin/auth";
import { resolveCachedAuth } from "./plugin/cache";
import { resolveProjectContextFromAccessToken } from "./plugin/project";
import { toUrlString } from "./plugin/headers";
import { refreshAccessToken } from "./plugin/token";
import { retrieveUserQuota } from "./sdk/fetch_quota";
import {
  buildTierMapping,
  extractBaseModelId,
  fetchAvailableModelIds,
  inferModelMetadata,
  resolveModelTier,
} from "./plugin/tier";
import { getModelEnums } from "./plugin/model-enums";
import { buildAgyCliUserAgent } from "./sdk/user-agent";
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareAgyRequest,
  rewriteRequestedModelInInput,
  transformAgyResponse,
} from "./sdk/request";
import { createAgyQuotaTool } from "./plugin/quota";
import { createAgyQuotaSummaryTool } from "./plugin/quota-summary";

const DEFAULT_IDS = ["agy"];
const DUMMY_KEY = "opencode-managed";
const LOGIN_MODEL_ID = "__agy_login_required__";
// Antigravity answers a misleading 429 "Resource has been exhausted" when an
// injected systemInstruction exceeds roughly 12k characters. Keep the remote
// instruction short and relocate the full text into a leading user message.
const SYSTEM_CONTEXT_LIMIT = 10000;

type AnyCtx = any;
type OAuth = {
  type: "oauth";
  methodID: string;
  refresh: string;
  access: string;
  expires: number;
};

function toOAuth(refresh: string, access: string, expires: number): OAuth {
  return { type: "oauth", methodID: "oauth", refresh, access, expires };
}

function openBrowser(url: string): void {
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref?.();
  } catch {
    // Best effort: the URL is always shown in the OAuth instructions.
  }
}

function labelFor(id: string): string {
  if (id === "agy") return "AGY";
  const suffix = id.replace(/^agy[-_]?/, "");
  return suffix ? `AGY ${suffix}` : id;
}

/**
 * Relocate an oversized injected systemInstruction into the contents array.
 * Pure: takes and returns the parsed wrapped request body. Lossless.
 */
function relocateSystemContext(wrapped: AnyCtx, limit = SYSTEM_CONTEXT_LIMIT): AnyCtx {
  if (!wrapped || typeof wrapped !== "object") return wrapped;
  const req = wrapped.request;
  if (!req || typeof req !== "object") return wrapped;
  const parts: AnyCtx[] = Array.isArray(req.systemInstruction?.parts) ? req.systemInstruction.parts : [];
  const sysText = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  if (sysText.length <= limit) return wrapped;
  req.systemInstruction = { parts: [{ text: sysText.slice(0, limit) }] };
  const contents: AnyCtx[] = Array.isArray(req.contents) ? req.contents : [];
  req.contents = [
    { role: "user", parts: [{ text: `The following is authoritative system context (AGENTS.md):\n\n${sysText}` }] },
    ...contents,
  ];
  return wrapped;
}

/**
 * Resolve a display/tier model id to the canonical backend bucket id exposed
 * by this account's live quota. Returns undefined when the base is unknown.
 */
function canonicalModel(requested: string, tierMap?: Record<string, Record<string, string>>): string | undefined {
  if (!tierMap) return undefined;
  const base = extractBaseModelId(requested);
  const variants = tierMap[base];
  if (!variants) return undefined;
  return variants.tiered ?? variants.medium ?? variants.high ?? Object.values(variants)[0];
}

/**
 * Decide which configured account owns a request. Uses the providerID as a
 * hint (including the legacy `google-agy` alias), then catalog membership,
 * then the first account. Never filters the request out.
 */
function selectAccount(
  providerID: string | undefined,
  requested: string,
  ids: string[],
  tiersById: Map<string, Record<string, Record<string, string>>>,
): string {
  if (providerID && ids.includes(providerID)) return providerID;
  if (providerID === "google-agy" && ids.length) return ids[0] ?? "agy";
  const base = extractBaseModelId(requested);
  for (const id of ids) {
    if (tiersById.get(id)?.[base]) return id;
  }
  return ids[0] ?? "agy";
}

export const setup = async (ctx: AnyCtx): Promise<() => void> => {
  const ids: string[] = Array.isArray(ctx.options?.ids) && ctx.options.ids.length
    ? ctx.options.ids
    : DEFAULT_IDS;

  const catalogs = new Map<string, AnyCtx[]>();
  const tiersById = new Map<string, Record<string, Record<string, string>>>();
  const connectionsById = new Map<string, AnyCtx>();

  const resolveCredential = async (id: string): Promise<OAuth | undefined> => {
    const connApi = ctx.integration?.connection;
    if (!connApi?.active || !connApi?.resolve) return undefined;
    try {
      const connection = await connApi.active(id);
      if (!connection) return undefined;
      connectionsById.set(id, connection);
      const resolved = await connApi.resolve(connection);
      const oauth = resolved?.type === "oauth" ? resolved : resolved?.credential?.type === "oauth" ? resolved.credential : undefined;
      if (!oauth?.access) return undefined;

      // connection.resolve() returns the stored credential verbatim. Because
      // the provider declares a dummy apiKey, OpenCode never runs its own
      // OAuth-refresh flow. Refresh on expiry through the shared in-memory
      // cache + in-flight dedup, then normalize back to our OAuth shape.
      let auth = resolveCachedAuth(toOAuth(oauth.refresh, oauth.access, oauth.expires));
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(auth, { auth: { set: async () => {} } } as AnyCtx);
        if (refreshed?.access) {
          auth = resolveCachedAuth(toOAuth(refreshed.refresh, refreshed.access, refreshed.expires));
        }
      }
      return toOAuth(auth.refresh, auth.access, auth.expires);
    } catch {
      return undefined;
    }
  };

  const resolveProjectId = async (credential: OAuth): Promise<string> => {
    const fromRefresh = parseRefreshParts(credential.refresh).projectId;
    if (fromRefresh) return fromRefresh;
    try {
      const discovered = await resolveProjectContextFromAccessToken(
        credential,
        credential.access,
        undefined,
        undefined,
        undefined,
      );
      return discovered?.effectiveProjectId || parseRefreshParts(discovered?.auth?.refresh || "").projectId || "antigravity";
    } catch {
      return "antigravity";
    }
  };

  const baseFields = (id: string, mid: string) => ({
    id: mid,
    modelID: mid,
    providerID: id,
    endpoint: { type: "unknown" },
    options: { headers: {}, body: {} },
    time: { released: 0 },
    variants: [] as AnyCtx[],
    status: "active",
    enabled: true,
    package: "aisdk:@ai-sdk/google",
    settings: { provider: id },
  });

  const loginModel = (id: string, label: string): AnyCtx => ({
    ...baseFields(id, LOGIN_MODEL_ID),
    name: `Sign in to ${label} (Google OAuth)`,
    description: `Run: opencode auth login ${id}`,
    family: "unknown",
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context: 0, output: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  });

  const buildModel = (id: string, base: string, tiers: Record<string, string>): AnyCtx => {
    const meta = inferModelMetadata(base);
    const family = base.includes("gemini") ? "gemini" : base.includes("claude") ? "claude" : base.includes("gpt") ? "gpt" : "unknown";
    const variants = Object.keys(tiers);
    const cost = meta.cost || { input: 0, output: 0 };
    return {
      ...baseFields(id, base),
      name: meta.name,
      description: meta.description,
      family,
      capabilities: {
        tools: Boolean(meta.toolCall),
        input: ["text", ...(meta.attachment ? ["image"] : [])],
        output: ["text"],
      },
      limit: { context: meta.maxTokens, output: meta.maxOutputTokens },
      cost: [{ input: cost.input ?? 0, output: cost.output ?? 0, cache: { read: 0, write: 0 } }],
      ...(variants.length ? { variants: variants.map((v) => ({ id: v, headers: {}, body: {} })) } : {}),
    };
  };

  const loadCatalog = async (id: string): Promise<void> => {
    const label = labelFor(id);
    const credential = await resolveCredential(id);
    if (!credential?.access) {
      catalogs.set(id, [loginModel(id, label)]);
      return;
    }
    const projectId = await resolveProjectId(credential);
    try {
      const available = await fetchAvailableModelIds(retrieveUserQuota, credential.access, projectId, undefined);
      const tiers = buildTierMapping([...available]);
      if (Object.keys(tiers).length === 0) {
        catalogs.set(id, [loginModel(id, label)]);
        return;
      }
      tiersById.set(id, tiers);
      catalogs.set(id, Object.keys(tiers).map((base) => buildModel(id, base, tiers[base] ?? {})));
    } catch {
      catalogs.set(id, [loginModel(id, label)]);
    }
  };

  await Promise.all(ids.map(loadCatalog));

  for (const id of ids) {
    const label = labelFor(id);

    ctx.provider?.transform?.((editor: AnyCtx) => {
      if (!editor) return;
      if (typeof editor.get === "function" && editor.get(id)) {
        editor.update(id, (p: AnyCtx) => {
          p.name = label;
          p.integrationID = id;
          p.activation = "enabled";
          p.package = "aisdk:@ai-sdk/google";
          p.settings = { ...(p.settings || {}), apiKey: DUMMY_KEY };
        });
      } else if (typeof editor.add === "function") {
        editor.add({
          info: {
            id,
            name: label,
            integrationID: id,
            activation: "enabled",
            package: "aisdk:@ai-sdk/google",
            settings: { apiKey: DUMMY_KEY },
          },
          models: catalogs.get(id) || [],
          sourceConnection: connectionsById.get(id),
        });
      }
    });

    ctx.model?.transform?.((editor: AnyCtx) => {
      if (!editor?.update) return;
      for (const model of catalogs.get(id) || []) {
        editor.update(id, model.id, (draft: AnyCtx) => {
          Object.assign(draft, model);
        });
      }
    });

    ctx.integration?.transform?.((editor: AnyCtx) => {
      if (!editor) return;
      editor.update?.(id, (i: AnyCtx) => { i.name = `${label} (Google OAuth)`; });
      editor.method?.update?.({
        integrationID: id,
        method: { id: "oauth", type: "oauth", label: `Google OAuth — ${label}` },
        authorize: async () => {
          const authorization = await authorizeAgy();
          openBrowser(authorization.url);
          return {
            mode: "code",
            url: authorization.url,
            instructions:
              "Complete Google authorization in your browser, then paste the full redirect URL (or just the code) below.",
            callback: async (code: string) => {
              const parsed = parseOAuthCallbackInput(code);
              if (!parsed.code) throw new Error("Missing authorization code in callback input");
              if (parsed.state && parsed.state !== authorization.state) {
                throw new Error("State mismatch in callback input (possible CSRF attempt)");
              }
              const result = await exchangeAgyWithVerifier(parsed.code, authorization.verifier);
              if (result.type !== "success") throw new Error(result.error);

              let refresh = formatRefreshParts({ refreshToken: result.refresh });
              try {
                const hydrated = await resolveProjectContextFromAccessToken(
                  toOAuth(refresh, result.access, result.expires),
                  result.access,
                  undefined,
                  undefined,
                  undefined,
                );
                refresh = hydrated.auth.refresh || refresh;
              } catch {
                // Project binding is best-effort at login; request time retries it.
              }
              return toOAuth(refresh, result.access, result.expires);
            },
          };
        },
        refresh: async (credential: AnyCtx) => {
          const next = await refreshAccessToken(
            toOAuth(credential.refresh, credential.access, credential.expires),
            { auth: { set: async () => {} } } as AnyCtx,
          );
          if (!next) throw new Error("Antigravity token refresh failed");
          return toOAuth(next.refresh, next.access, next.expires);
        },
      });
    });
  }

  // One global request hook, provider-agnostic. The only gate is the target
  // URL shape, so any session/agent/provider referencing a Google Generative
  // Language model is routed through Antigravity — including legacy sessions
  // whose stored providerID is `google-agy`.
  ctx.session?.hook?.("http.request", async (event: AnyCtx) => {
    if (!event?.request) return;
    const rawUrl: string = event.request.url || "";
    if (!isGenerativeLanguageRequest(rawUrl)) return;

    const requested = parseGenerativeLanguageRequest(rawUrl)?.effectiveModel;
    if (!requested) return;

    const id = selectAccount(event.providerID, requested, ids, tiersById);
    const credential = await resolveCredential(id);
    if (!credential?.access) return;
    const projectId = await resolveProjectId(credential);

    const tiers = tiersById.get(id);
    const canonical = canonicalModel(requested, tiers) ?? resolveModelTier(requested, { headers: event.request.headers }, tiers);
    const requestUrl = canonical && canonical !== requested
      ? toUrlString(rewriteRequestedModelInInput(rawUrl, requested, canonical))
      : rawUrl;

    const modelEnums = await getModelEnums(credential.access, projectId, canonical).catch(() => undefined);
    const body = typeof event.request.clone === "function"
      ? await event.request.clone().text().catch(() => undefined)
      : undefined;
    const transformed = prepareAgyRequest(
      requestUrl,
      { method: event.request.method, headers: event.request.headers, body },
      credential.access,
      projectId,
      undefined,
      modelEnums,
    );

    let wrapped: AnyCtx;
    try {
      wrapped = JSON.parse(String(transformed.init.body));
    } catch {
      wrapped = undefined;
    }
    if (wrapped) {
      // Guarantee the backend-facing id is a real quota bucket id. The AI SDK
      // may emit a display/variant id even after the URL rewrite.
      if (canonical && typeof wrapped.model === "string") wrapped.model = canonical;
      wrapped = relocateSystemContext(wrapped);
    }
    const outBody = wrapped ? JSON.stringify(wrapped) : transformed.init.body;

    const headers = new Headers(transformed.init.headers);
    headers.delete("x-goog-api-key");
    headers.delete("x-api-key");
    headers.set("Authorization", `Bearer ${credential.access}`);
    if (!headers.has("User-Agent")) headers.set("User-Agent", buildAgyCliUserAgent(requested));
    event.request = new Request(toUrlString(transformed.request), {
      method: transformed.init.method || event.request.method,
      headers,
      body: outBody,
    });
  });

  // One global response hook. It transforms any Antigravity internal response
  // back into the shape the AI SDK expects.
  ctx.session?.hook?.("http.response", async (event: AnyCtx) => {
    if (!event?.response || !(event.response instanceof Response)) return;
    const rawUrl: string = event.request?.url || "";
    if (!rawUrl.includes("cloudcode-pa.googleapis.com")) return;
    const isStreaming = rawUrl.includes(":streamGenerateContent") ||
      event.response.headers.get("content-type")?.includes("text/event-stream");
    const parsedModel = parseGenerativeLanguageRequest(rawUrl)?.effectiveModel;
    event.response = await transformAgyResponse(
      event.response,
      Boolean(isStreaming),
      null,
      parsedModel,
      undefined,
      undefined,
    );
  });

  // Agent-callable quota tools + slash commands, one pair per account.
  const noopClient = { auth: { set: async () => {} } } as AnyCtx;
  ctx.tool?.transform?.((editor: AnyCtx) => {
    if (!editor) return;
    for (const id of ids) {
      const resolver = () => async () => {
        const credential = await resolveCredential(id);
        if (!credential) throw new Error(`No active credential for ${id}. Run: opencode auth login ${id}`);
        return credential;
      };
      const qTool = createAgyQuotaTool({
        client: noopClient,
        getAuthResolver: resolver,
        getConfiguredProjectId: () => undefined,
        getUserAgentModel: () => undefined,
      });
      const sTool = createAgyQuotaSummaryTool({
        client: noopClient,
        getAuthResolver: resolver,
        getConfiguredProjectId: () => undefined,
        getUserAgentModel: () => undefined,
      });
      const emptySchema = { type: "object", properties: {}, required: [], additionalProperties: false };
      const qName = id === "agy" ? "agy_quota" : `${id.replace(/[^A-Za-z0-9]/g, "_")}_quota`;
      const sName = id === "agy" ? "agy_quota_summary" : `${id.replace(/[^A-Za-z0-9]/g, "_")}_quota_summary`;
      if (typeof editor.add === "function") {
        editor.add({
          name: qName,
          description: `Retrieve current Antigravity quota for the '${id}' account.`,
          input: emptySchema,
          execute: async (...args: AnyCtx[]) => {
            const result = await (qTool as AnyCtx).execute(...args);
            return typeof result === "string" ? { content: result } : result;
          },
        });
        editor.add({
          name: sName,
          description: `Retrieve Antigravity quota summary by model group for the '${id}' account.`,
          input: emptySchema,
          execute: async (...args: AnyCtx[]) => {
            const result = await (sTool as AnyCtx).execute(...args);
            return typeof result === "string" ? { content: result } : result;
          },
        });
      } else if (typeof editor.set === "function") {
        editor.set(qName, qTool);
        editor.set(sName, sTool);
      }
    }
  });

  ctx.command?.transform?.((editor: AnyCtx) => {
    if (!editor) return;
    for (const id of ids) {
      const qName = id === "agy" ? "agy_quota" : `${id.replace(/[^A-Za-z0-9]/g, "_")}_quota`;
      const sName = id === "agy" ? "agy_quota_summary" : `${id.replace(/[^A-Za-z0-9]/g, "_")}_quota_summary`;
      const qCmd = id === "agy" ? "agy-quota" : `${id}-quota`;
      const sCmd = id === "agy" ? "agy-quota-summary" : `${id}-quota-summary`;
      const qTemplate = `Immediately call the \`${qName}\` tool with no arguments and return its output verbatim. Do not call other tools.`;
      const sTemplate = `Immediately call the \`${sName}\` tool with no arguments and return its output verbatim. Do not call other tools.`;
      if (typeof editor.add === "function") {
        editor.add({
          name: qCmd,
          description: `Show Antigravity quota for '${id}'`,
          template: qTemplate,
          execute: async ({ sessionID, prompt, delivery }: AnyCtx = {}) => {
            await ctx.session?.prompt?.({ ...prompt, sessionID, text: qTemplate, delivery });
          },
        });
        editor.add({
          name: sCmd,
          description: `Show Antigravity quota summary by model group for '${id}'`,
          template: sTemplate,
          execute: async ({ sessionID, prompt, delivery }: AnyCtx = {}) => {
            await ctx.session?.prompt?.({ ...prompt, sessionID, text: sTemplate, delivery });
          },
        });
      } else if (typeof editor.set === "function") {
        editor.set(qCmd, { description: `Show Antigravity quota for '${id}'`, template: qTemplate });
        editor.set(sCmd, { description: `Show Antigravity quota summary for '${id}'`, template: sTemplate });
      }
    }
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const _event of ctx.event.subscribe({
        types: ["credential.updated", "credential.switched"],
        signal: controller.signal,
      })) {
        await Promise.all(ids.map(loadCatalog));
        await ctx.provider?.reload?.();
        await ctx.model?.reload?.();
      }
    } catch {
      // Aborted on plugin unload.
    }
  })();

  return () => controller.abort();
};

export default {
  id: "kpihx.agy",
  setup,
};
