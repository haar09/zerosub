import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import type { ChainStep } from "../shared/chains";
import { absentPi } from "./fakes.test-support";

const CLAUDE = MAIN_ACCOUNT_ID.claude;
const CODEX = MAIN_ACCOUNT_ID.codex;
const BEDROCK = "claude-bedrock";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-chains-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const inFuture = (minutes = 30) => new Date(Date.now() + minutes * 60_000).toISOString();
const pool = (source: "claude" | "codex", model: string | null = null): ChainStep => ({ source, accountId: null, model, thinking: null });
const api = (accountId: string): ChainStep => ({ source: "account", accountId, model: null, thinking: null });

const MODES: Record<string, Array<{ id: string; label: string; colorTier: string }>> = {
  claude: [
    { id: "plan", label: "Plan Mode", colorTier: "planning" },
    { id: "default", label: "Always Ask", colorTier: "safe" },
    { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
    { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
  ],
  codex: [
    { id: "auto", label: "Default Permissions", colorTier: "moderate" },
    { id: "full-access", label: "Full Access", colorTier: "dangerous" },
  ],
};

function adapter(family: "claude" | "codex", portable: boolean): FamilyAdapter {
  const reading = (): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null });
  return {
    family,
    portable,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async () => ({}),
    identity: async () => null,
    usage: async () => reading(),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    logout: async () => undefined,
    detectLimit: (event: { outcome: { kind: string } }) =>
      event.outcome.kind === "failed" ? { kind: "window", resetsAt: inFuture(60), message: "You've hit your session limit" } : null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

interface Options {
  steps: ChainStep[];
  modeId?: string;
  /** The agent's chain record; `off` turns its chain off. */
  record?: { step: number; manual?: boolean } | "off";
  accounts?: Partial<Record<string, Record<string, unknown>>>;
  session?: string;
}

async function setUp(options: Options) {
  const store = new StateStore(join(root, "state.json"));
  const base = (id: string, family: string, label: string, kind: "main" | "managed", extra: Record<string, unknown> = {}) => ({
    id, family, label, kind, home: kind === "main" ? null : join(root, id), createdAt: "2026-10-01T00:00:00Z", ...extra, ...(options.accounts?.[id] ?? {}),
  });
  await store.update((draft) =>
    Object.assign(draft, {
      accounts: [
        base(CLAUDE, "claude", "marketing", "main"),
        base(CODEX, "codex", "hello", "main"),
        base(BEDROCK, "claude", "bed", "managed", { auth: "api" }),
      ],
      defaults: { claude: CLAUDE, codex: CODEX, pi: null },
      chains: [{ id: "work", name: "Work", steps: options.steps, auto: false }],
      defaultChain: "work",
      chainsSeeded: true,
      agentChains:
        options.record === "off"
          ? { [AGENT]: { chainId: null, step: 0, at: new Date().toISOString() } }
          : { [AGENT]: { chainId: "work", step: options.record?.step ?? 0, manual: options.record?.manual ?? false, at: new Date().toISOString() } },
      sessions: { [AGENT]: { accountId: options.session ?? CLAUDE, family: "claude", openedAt: new Date(Date.now() - 60 * 60_000).toISOString() } },
    } satisfies Partial<StoredState>),
  );
  const source = {
    id: AGENT,
    provider: "claude",
    status: "idle",
    title: "Fix the build",
    model: "claude-opus-5-5",
    currentModeId: options.modeId ?? "bypassPermissions",
    workspaceId: "ws-1",
    archivedAt: null,
    lastUserMessageAt: "2026-09-23T07:00:00.000Z",
    labels: {},
  };
  const agents: Array<Record<string, unknown>> = [source];
  const created: Array<{ agentId: string; config: { provider: string; modeId?: string; thinkingOptionId?: string }; title: string; prompt: string; labels: Record<string, string> }> = [];
  const notes: Array<{ agentId: string; kind: string; data: Record<string, unknown> }> = [];
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "claude", available: true }, { provider: "codex", available: true }] }),
      listModes: async (provider: string) => ({ modes: MODES[provider] }),
      listModels: async (provider: string) => ({ models: [{ id: provider === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", isDefault: true }] }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (request: (typeof created)[number]) => {
            created.push(request);
            agents.push({ id: request.agentId, provider: "codex", status: "running", title: request.title, workspaceId: "ws-1", archivedAt: null, labels: request.labels });
          },
        },
      }),
    },
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: agents.find((agent) => agent.id === id) ?? source }),
        send: async () => undefined,
        timeline: {
          append: async (item: { kind: string; data: Record<string, unknown> }) => void notes.push({ agentId: id, kind: item.kind, data: item.data }),
          refetch: async () => ({ entries: [] }),
        },
      }),
    },
  };
  const context = { paseo } as never;
  let service!: Service;
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (id: string) => {
      await service.onSessionOpen({ agentId: id, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never, context);
      return { ok: true as const };
    },
  };
  service = new Service(
    { claude: adapter("claude", true), codex: adapter("codex", false), pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  services.push(service);
  const limitTurn = () =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      context,
    );
  const rows = (agentId = AGENT) => notes.filter((note) => note.agentId === agentId && note.kind === "zerosub-switch").map((note) => note.data);
  return { service, store, paseo, created, notes, rows, limitTurn, context };
}

describe("fallback chains", () => {
  it("moves on to a step of the same family in place", async () => {
    const { store, rows, created, limitTurn } = await setUp({ steps: [pool("claude"), api(BEDROCK)] });
    await limitTurn();
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(BEDROCK);
    expect(state.agentChains[AGENT]).toMatchObject({ chainId: "work", step: 1 });
    expect(created).toHaveLength(0);
    expect(rows().at(-1)).toMatchObject({
      outcome: "switched",
      to: "bed",
      chain: { name: "Work", step: 2, steps: 2, label: "bed (AWS Bedrock)", from: "Claude subscriptions at their limit" },
    });
  });

  it("forks to the other family with the step's model, at the same permission level, and links both ways", async () => {
    const { store, rows, notes, created, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex", "gpt-5.5")] });
    await limitTurn();
    expect(created).toHaveLength(1);
    const fork = created[0]!;
    expect(fork.config).toEqual({ provider: "codex/gpt-5.5", modeId: "full-access" });
    const state = await store.read();
    expect(state.agentChains[fork.agentId]).toMatchObject({ chainId: "work", step: 1 });
    expect(state.links[AGENT]?.next).toMatchObject({ agentId: fork.agentId });
    expect(state.links[fork.agentId]?.previous).toMatchObject({ agentId: AGENT, title: "Fix the build" });
    expect(rows().at(-1)).toMatchObject({
      outcome: "continued",
      toFamily: "codex",
      continuedIn: { agentId: fork.agentId },
      chain: { step: 2, label: "ChatGPT subscription", model: "gpt-5.5", from: "Claude subscriptions at their limit" },
    });
    expect(notes.filter((note) => note.agentId === fork.agentId && note.kind === "zerosub-link").map((note) => note.data)).toEqual([
      expect.objectContaining({ direction: "from", agentId: AGENT, title: "Fix the build", workspaceId: "ws-1" }),
    ]);

    // Prompting the original again while Claude is still out points to the same fork.
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(rows().at(-1)).toMatchObject({ outcome: "continued", continuedIn: { agentId: fork.agentId } });
    expect(notes.filter((note) => note.kind === "zerosub-link")).toHaveLength(1);
  });

  it("starts the fork on the provider's default model when the step names none", async () => {
    const { created, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex")] });
    await limitTurn();
    expect(created[0]?.config.provider).toBe("codex/gpt-5.6-sol");
  });

  it("skips broken and exhausted steps", async () => {
    const { store, created, rows, limitTurn } = await setUp({
      steps: [pool("claude"), api("removed-account"), pool("codex"), api(BEDROCK)],
      accounts: { [CODEX]: { limitedUntil: inFuture() } },
    });
    await limitTurn();
    expect(created).toHaveLength(0);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
    expect(rows().at(-1)).toMatchObject({ chain: { step: 4 } });
  });

  it("skips the other family for an agent in Plan Mode, and stops when nothing else is left", async () => {
    const skipping = await setUp({ steps: [pool("claude"), pool("codex"), api(BEDROCK)], modeId: "plan" });
    await skipping.limitTurn();
    expect(skipping.created).toHaveLength(0);
    expect((await skipping.store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
    await skipping.service.stop();

    const stopping = await setUp({ steps: [pool("claude"), pool("codex")], modeId: "default" });
    await stopping.limitTurn();
    expect(stopping.created).toHaveLength(0);
    const note = stopping.rows().at(-1)!;
    expect(note).toMatchObject({ outcome: "stayed", reason: "exhausted" });
    expect(String(note.detail)).toMatch(/Every later step of chain “Work” is out too or can't take this agent/);
    expect(String(note.detail)).toMatch(/no mode as careful as this agent's \(“Always Ask”\)/);
  });

  it("stops and says when the earliest step frees up once every step is out", async () => {
    const early = inFuture(10);
    const { rows, created, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex")], accounts: { [CODEX]: { limitedUntil: early } } });
    await limitTurn();
    expect(created).toHaveLength(0);
    expect(rows().at(-1)).toMatchObject({ outcome: "stayed", resetsAt: early });
  });

  it("returns to an earlier step of its family once it has room", async () => {
    const { service, store, rows, paseo } = await setUp({ steps: [pool("claude"), api(BEDROCK)], record: { step: 1 }, session: BEDROCK });
    await service.alignSessions(paseo as never);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(CLAUDE);
    expect(rows().at(-1)).toMatchObject({ reason: "room", outcome: "switched", chain: { step: 1, label: "Claude subscription" } });
  });

  it("stays on a step picked by hand", async () => {
    const { service, store, paseo } = await setUp({ steps: [pool("claude"), api(BEDROCK)], record: { step: 1, manual: true }, session: BEDROCK });
    await service.alignSessions(paseo as never);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
  });

  it("starts new agents at the first step of the default chain", async () => {
    const { service, store, context } = await setUp({ steps: [pool("claude"), api(BEDROCK)], record: { step: 1 }, session: BEDROCK });
    await service.onSessionOpen({ agentId: "new", provider: "claude", reason: "create", purpose: "interactive", workspaceId: "ws-1", env: {} } as never, context);
    const state = await store.read();
    expect(state.agentChains.new).toMatchObject({ chainId: "work", step: 0 });
    expect(state.sessions.new?.accountId).toBe(CLAUDE);
  });

  it("gives no chain to Paseo's helpers or to agents from before chains", async () => {
    const { service, store, context } = await setUp({ steps: [pool("claude")] });
    await service.onSessionOpen({ agentId: "helper", provider: "claude", reason: "create", purpose: "interactive", env: {} } as never, context);
    await service.onSessionOpen({ agentId: "old", provider: "claude", reason: "resume", purpose: "interactive", workspaceId: "ws-1", env: {} } as never, context);
    const state = await store.read();
    expect(state.agentChains.helper).toBeUndefined();
    expect(state.agentChains.old).toBeUndefined();
  });

  it("behaves as without chains when the agent's chain is off", async () => {
    // Without a chain, the fork toggle (off) and the last-resort rule decide: Bedrock, not ChatGPT.
    const { store, created, rows, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex")], record: "off" });
    await limitTurn();
    expect(created).toHaveLength(0);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
    expect(rows().at(-1)).toMatchObject({ outcome: "switched", to: "bed" });
    expect(rows().at(-1)?.chain).toBeUndefined();
  });

  it("keeps a subscription step off Bedrock while ChatGPT has room", async () => {
    // The chain says ChatGPT comes before Bedrock, so the last-resort rule doesn't apply.
    const { store, created, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex"), api(BEDROCK)] });
    await limitTurn();
    expect(created).toHaveLength(1);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(CLAUDE);
  });

  it("sets, follows and turns off an agent's chain", async () => {
    const { service, store, paseo } = await setUp({ steps: [pool("claude"), api(BEDROCK)], record: "off" });
    await service.saveChain({ name: "Other", steps: [pool("claude")] });
    const other = (await store.read()).chains.find((chain) => chain.name === "Other")!;
    expect(await service.setAgentChain(paseo as never, AGENT, "chain", other.id)).toEqual({ chain: "Other" });
    expect((await store.read()).agentChains[AGENT]).toMatchObject({ chainId: other.id, step: 0 });
    expect(await service.setAgentChain(paseo as never, AGENT, "default")).toEqual({ chain: "Work" });
    expect(await service.setAgentChain(paseo as never, AGENT, "off")).toEqual({ chain: null });
    expect((await store.read()).agentChains[AGENT]?.chainId).toBeNull();
    await expect(service.saveChain({ name: "other", steps: [pool("codex")] })).rejects.toThrow(/already a chain called/);
    await service.deleteChain(other.id);
    await service.setDefaultChain(null);
    expect((await store.read()).defaultChain).toBeNull();
  });

  it("places a manual pick at its step, and refuses an account the chain doesn't have", async () => {
    const { service, store, paseo } = await setUp({ steps: [pool("claude"), api(BEDROCK)] });
    await service.setAgentAccount(paseo as never, AGENT, BEDROCK);
    expect((await store.read()).agentChains[AGENT]).toMatchObject({ step: 1, manual: true });
    const narrow = await setUp({ steps: [pool("claude")] });
    await expect(narrow.service.setAgentAccount(narrow.paseo as never, AGENT, BEDROCK)).rejects.toThrow(/isn't a step of chain “Work”/);
  });
});
