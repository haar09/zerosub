import { join } from "node:path";

/**
 * A registry (`state.json`) as the old fork's `chains` build wrote it: every field its schema had,
 * Azure OpenAI and AWS Bedrock accounts as plain `auth: "api"` accounts with no `provider` marker, a
 * seeded Default chain nobody edited, one of the user's own, agents' chains (one turned off) and a
 * continuation link. Placeholder values only. Test-only (kept out of the package, see package.json).
 */
export function oldForkState(homes: string) {
  const account = (fields: Record<string, unknown> & { id: string }): Record<string, unknown> & { id: string } => ({
    autoLabel: false,
    auth: "subscription",
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...fields,
  });
  return {
    version: 1,
    accounts: [
      account({ id: "claude-main", family: "claude", label: "Claude (CLI login)", kind: "main", home: null, email: "user@example.com", plan: "max" }),
      account({ id: "codex-main", family: "codex", label: "ChatGPT (CLI login)", kind: "main", home: null, email: "user@example.com", plan: "plus" }),
      account({ id: "codex-azure1", family: "codex", label: "Azure", kind: "managed", home: join(homes, "codex-azure1"), auth: "api", identity: "azure|example" }),
      account({
        id: "claude-bedrock1",
        family: "claude",
        label: "Bedrock",
        kind: "managed",
        home: join(homes, "claude-bedrock1"),
        auth: "api",
        identity: "bedrock|eu-central-1|host",
        apiError: null,
      }),
      account({ id: "claude-key1", family: "claude", label: "Key", kind: "managed", home: join(homes, "claude-key1"), auth: "api", identity: "api|example" }),
    ],
    defaults: { claude: "claude-main", codex: "codex-main", pi: null, grok: null },
    bindings: { "agent-old": { accountId: "claude-main", source: "user", at: "2026-11-01T00:00:00.000Z" } },
    sessions: { "agent-old": { accountId: "claude-main", family: "claude", openedAt: "2026-11-01T00:00:00.000Z" } },
    continuations: {},
    cleanup: {},
    nextAgent: { claude: null, codex: null, pi: null, grok: null },
    piHomes: { dir: null, from: [] },
    moves: {},
    chains: [
      {
        id: "default",
        name: "Default",
        steps: [
          { source: "claude", accountId: null, model: null, thinking: null },
          { source: "codex", accountId: null, model: null, thinking: null },
          { source: "account", accountId: "claude-bedrock1", model: null, thinking: null },
          { source: "account", accountId: "codex-azure1", model: null, thinking: null },
        ],
        auto: true,
      },
      {
        id: "chain-0a1b2c3d",
        name: "Work",
        steps: [
          { source: "claude", accountId: null, model: null, thinking: null },
          { source: "account", accountId: "claude-bedrock1", model: null, thinking: null },
          { source: "codex", accountId: null, model: "gpt-5.5", thinking: "high" },
        ],
        auto: false,
        picker: false,
      },
    ],
    defaultChain: "default",
    chainsSeeded: true,
    agentChains: {
      "agent-1": { chainId: "chain-0a1b2c3d", step: 1, manual: true, at: "2026-11-15T10:00:00.000Z" },
      "agent-2": { chainId: "default", step: 0, manual: false, at: "2026-11-15T11:00:00.000Z" },
      "agent-3": { chainId: null, step: 0, manual: false, at: "2026-11-15T12:00:00.000Z" },
    },
    links: {
      "agent-1": { next: { agentId: "agent-2", title: "Fix the build (continued)", workspaceId: "ws-1" }, previous: null },
      "agent-2": { next: null, previous: { agentId: "agent-1", title: "Fix the build", workspaceId: "ws-1" } },
    },
  };
}

/** `azure.json` as the old fork wrote it. */
export const OLD_AZURE_FILE = {
  endpoint: "https://example-resource.openai.azure.com/openai/v1",
  key: "azure-placeholder-key-0123456789",
  prices: { "gpt-5.5": { input: 1.25, cachedInput: 0.125, cacheWrite: null, output: 10 } },
};

/** `bedrock.json` as the old fork wrote it (the host's own AWS credentials, one model override). */
export const OLD_BEDROCK_FILE = {
  region: "eu-central-1",
  source: "host",
  models: { model: "eu.anthropic.claude-opus-example", opus: "", sonnet: "", haiku: "" },
  prices: { "eu.anthropic.claude-opus-example": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 } },
};

/** `bedrock.json` for an access key, as the old fork wrote it. */
export const OLD_BEDROCK_KEYS_FILE = {
  region: "us-east-1",
  source: "keys",
  models: { model: "", opus: "", sonnet: "", haiku: "" },
  prices: {},
  accessKeyId: "AKIAEXAMPLEPLACEHOLDER",
  secretAccessKey: "placeholder-secret",
  sessionToken: "placeholder-session",
};

/** `api-usage.json` as the old fork wrote it. */
export function oldApiUsage(month: string) {
  return {
    accounts: {
      "codex-azure1": { month, models: { "gpt-5.5": { input: 1200, cachedInput: 300, cacheWrite: 0, output: 450 } }, uncounted: 1, updatedAt: `${month}-02T00:00:00.000Z` },
      "claude-bedrock1": { month, models: { "eu.anthropic.claude-opus-example": { input: 10, cachedInput: 5, cacheWrite: 2, output: 7 } }, uncounted: 0, updatedAt: null },
    },
    threads: { "thread-1": { input: 1200, cachedInput: 300, cacheWrite: 0, output: 450, at: new Date().toISOString() } },
    messages: { "session-1": { ids: ["msg_1", "msg_2"], at: new Date().toISOString() } },
  };
}

/**
 * The registry as this fork's deployment build (4ad6e15, before the rebase onto v1.12.0) wrote it,
 * every field as its schema saved it: the old fork's state after the provider markers were set, with
 * an added Claude subscription in `homes/` (#69 later keeps those elsewhere), a Pi account and a move
 * of its home on record (no `family`, as records of then), a refused Bedrock account, a removed
 * account's folder up for cleanup, and no `claudeHomes`. Placeholder values only.
 */
export function deployState(homes: string, piHomes: string, oldPiHomes: string) {
  return {
    version: 1,
    accounts: [
      {
        id: "claude-main",
        family: "claude",
        label: "Claude (CLI login)",
        autoLabel: false,
        kind: "main",
        auth: "subscription",
        home: null,
        email: "user@example.com",
        plan: "max",
        organization: null,
        identity: null,
        signedIn: true,
        disabled: false,
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "codex-main",
        family: "codex",
        label: "ChatGPT (CLI login)",
        autoLabel: false,
        kind: "main",
        auth: "subscription",
        home: null,
        email: "user@example.com",
        plan: "plus",
        organization: null,
        identity: null,
        signedIn: true,
        disabled: false,
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "codex-azure1",
        family: "codex",
        label: "Azure",
        autoLabel: false,
        kind: "managed",
        auth: "api",
        provider: "azure",
        home: `${homes}/codex-azure1`,
        email: null,
        plan: null,
        organization: null,
        identity: "azure|example",
        signedIn: true,
        disabled: false,
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "claude-bedrock1",
        family: "claude",
        label: "Bedrock",
        autoLabel: false,
        kind: "managed",
        auth: "api",
        provider: "bedrock",
        home: `${homes}/claude-bedrock1`,
        email: null,
        plan: null,
        organization: null,
        identity: "bedrock|eu-central-1|host",
        signedIn: false,
        disabled: false,
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        apiError: "The security token included in the request is expired",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "claude-key1",
        family: "claude",
        label: "Key",
        autoLabel: false,
        kind: "managed",
        auth: "api",
        home: `${homes}/claude-key1`,
        email: null,
        plan: null,
        organization: null,
        identity: "api|example",
        signedIn: true,
        disabled: false,
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "claude-0123456789ab",
        family: "claude",
        label: "Work",
        autoLabel: false,
        kind: "managed",
        auth: "subscription",
        home: `${homes}/claude-0123456789ab`,
        email: "work@example.com",
        plan: "max",
        organization: null,
        identity: "personal|work@example.com",
        signedIn: true,
        disabled: false,
        limitedUntil: "2026-11-16T20:00:00.000Z",
        limitKind: "window",
        limitedAt: "2026-11-16T15:00:00.000Z",
        limitSource: "turn",
        createdAt: "2026-10-02T00:00:00.000Z",
      },
      {
        id: "pi-0123456789ab",
        family: "pi",
        label: "Pi key",
        autoLabel: false,
        kind: "managed",
        auth: "api",
        home: `${piHomes}/pi-key`,
        email: null,
        plan: null,
        organization: null,
        identity: null,
        signedIn: true,
        disabled: false,
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        createdAt: "2026-10-03T00:00:00.000Z",
      },
    ],
    defaults: { claude: "claude-0123456789ab", codex: "codex-main", pi: null, grok: null },
    bindings: {
      "agent-old": { accountId: "claude-main", source: "user", at: "2026-11-01T00:00:00.000Z" },
      "agent-1": { accountId: "claude-bedrock1", source: "auto", at: "2026-11-15T10:00:00.000Z" },
      "agent-4": { accountId: "codex-azure1", source: "thread", at: "2026-11-15T13:00:00.000Z" },
    },
    sessions: {
      "agent-old": { accountId: "claude-main", family: "claude", openedAt: "2026-11-01T00:00:00.000Z" },
      "agent-1": { accountId: "claude-bedrock1", family: "claude", openedAt: "2026-11-15T10:00:00.000Z" },
    },
    continuations: {},
    cleanup: {
      [`${homes}/claude-removed`]: { family: "claude", accountId: "claude-removed", why: "removed", at: "2026-11-01T00:00:00.000Z" },
    },
    nextAgent: { claude: null, codex: null, pi: null, grok: null },
    piHomes: { dir: piHomes, from: [oldPiHomes] },
    moves: { "pi-0123456789ab": { from: `${oldPiHomes}/pi-key`, to: `${piHomes}/pi-key`, at: "2026-11-10T00:00:00.000Z" } },
    chains: [
      {
        id: "default",
        name: "Default",
        steps: [
          { source: "claude", accountId: null, model: null, thinking: null },
          { source: "codex", accountId: null, model: null, thinking: null },
          { source: "account", accountId: "claude-bedrock1", model: null, thinking: null },
          { source: "account", accountId: "codex-azure1", model: null, thinking: null },
        ],
        auto: true,
      },
      {
        id: "chain-0a1b2c3d",
        name: "Work",
        steps: [
          { source: "claude", accountId: null, model: null, thinking: null },
          { source: "account", accountId: "claude-bedrock1", model: null, thinking: null },
          { source: "codex", accountId: null, model: "gpt-5.5", thinking: "high" },
        ],
        auto: false,
        picker: false,
      },
    ],
    defaultChain: "default",
    chainsSeeded: true,
    agentChains: {
      "agent-1": { chainId: "chain-0a1b2c3d", step: 1, manual: true, at: "2026-11-15T10:00:00.000Z" },
      "agent-2": { chainId: "default", step: 0, manual: false, at: "2026-11-15T11:00:00.000Z" },
      "agent-3": { chainId: null, step: 0, manual: false, at: "2026-11-15T12:00:00.000Z" },
    },
    links: {
      "agent-1": { next: { agentId: "agent-2", title: "Fix the build (continued)", workspaceId: "ws-1" }, previous: null },
      "agent-2": { next: null, previous: { agentId: "agent-1", title: "Fix the build", workspaceId: "ws-1" } },
    },
  };
}
