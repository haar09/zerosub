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
import { preferences } from "../shared/preferences";
import { absentPi } from "./fakes.test-support";

const CLAUDE = MAIN_ACCOUNT_ID.claude;
const CODEX = MAIN_ACCOUNT_ID.codex;
const BEDROCK = "claude-bedrock";
/** A Claude API-key account (upstream #65): no provider marker. */
const KEY = "claude-key";
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
const pool = (source: "claude" | "codex", model: string | null = null, modeId: string | null = null): ChainStep => ({ source, accountId: null, model, thinking: null, modeId });
const api = (accountId: string): ChainStep => ({ source: "account", accountId, model: null, thinking: null, modeId: null });

// As Paseo 0.9.1 lists them.
const MODES: Record<string, Array<{ id: string; label: string; colorTier: string; icon: string }>> = {
  claude: [
    { id: "plan", label: "Plan Mode", colorTier: "planning", icon: "ShieldEllipsis" },
    { id: "default", label: "Always Ask", colorTier: "safe", icon: "Shield" },
    { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate", icon: "ShieldPlus" },
    { id: "auto", label: "Auto mode", colorTier: "moderate", icon: "ShieldCheck" },
    { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous", icon: "ShieldOff" },
  ],
  codex: [
    { id: "auto", label: "Default Permissions", colorTier: "moderate", icon: "Shield" },
    { id: "auto-review", label: "Auto-review", colorTier: "moderate", icon: "ShieldCheck" },
    { id: "full-access", label: "Full Access", colorTier: "dangerous", icon: "ShieldOff" },
  ],
};

function adapter(family: "claude" | "codex", portable: boolean, redeems: string[] = []): FamilyAdapter {
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
    redeemReset: async (home: string | null) => {
      redeems.push(home ?? "main");
      return redeemable ? { outcome: "reset", message: "Reset spent.", left: 0 } : { outcome: "none", message: "none", left: 0 };
    },
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
  /** Provider entries in the daemon config, and the families they map to besides the built-in ones. */
  providers?: Record<string, Record<string, unknown>>;
  families?: Record<string, "claude" | "codex">;
  profiles?: Array<{ id: string; name: string; provider: string }>;
  /** The daemon refuses config patches. */
  readOnlyConfig?: boolean;
  /** More Claude accounts besides the CLI login, the Bedrock and the API-key one. */
  more?: Array<Record<string, unknown>>;
  /** A banked reset can be spent on the Claude accounts. */
  redeemable?: boolean;
}

/** Whether the adapters' banked resets work (see `Options.redeemable`). */
let redeemable = false;

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
        base(BEDROCK, "claude", "bed", "managed", { auth: "api", provider: "bedrock" }),
        base(KEY, "claude", "key", "managed", { auth: "api" }),
        ...(options.more ?? []).map((extra) => base(String(extra.id), "claude", String(extra.label), "managed", extra)),
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
    } as unknown as Partial<StoredState>),
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
  const config: { providers: Record<string, Record<string, unknown>>; agentProfiles: unknown[] } = {
    providers: structuredClone(options.providers ?? {}),
    agentProfiles: options.profiles ?? [],
  };
  const patches: Array<Record<string, unknown>> = [];
  const paseo = {
    config: {
      get: async () => ({ config: structuredClone(config) }),
      // Like Paseo's daemon: each entry given is merged into what's there; `removeProviders` drops entries.
      patch: async (patch: { providers?: Record<string, Record<string, unknown>>; removeProviders?: string[] }) => {
        if (options.readOnlyConfig) throw new Error("EACCES: permission denied, open '/home/u/.paseo/config.json'");
        patches.push(structuredClone(patch));
        for (const id of patch.removeProviders ?? []) delete config.providers[id];
        for (const [id, entry] of Object.entries(patch.providers ?? {})) config.providers[id] = { ...config.providers[id], ...entry };
        return { config: structuredClone(config) };
      },
    },
    providers: {
      listAvailable: async () => ({
        providers: ["claude", "codex", ...Object.keys(options.families ?? {})].map((provider) => ({ provider, available: true })),
      }),
      listModes: async (provider: string) => ({ modes: MODES[{ claude: "claude", codex: "codex", ...options.families }[provider] ?? provider] }),
      listModels: async (provider: string) => ({
        models: [{ id: ({ codex: "codex", ...options.families }[provider] ?? provider) === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", isDefault: true }],
      }),
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
  redeemable = options.redeemable ?? false;
  const redeems: string[] = [];
  service = new Service(
    { claude: adapter("claude", true, redeems), codex: adapter("codex", false), pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const, ...options.families }), invalidate: () => undefined } as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  services.push(service);
  const limitTurn = () =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      context,
    );
  const rows = (agentId = AGENT) => notes.filter((note) => note.agentId === agentId && note.kind === "zerosub-switch").map((note) => note.data);
  return { service, store, paseo, created, notes, rows, limitTurn, context, config, patches, agents, redeems };
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

  it("moves on to a Claude API-key step in place", async () => {
    const { store, rows, created, limitTurn } = await setUp({ steps: [pool("claude"), api(KEY), api(BEDROCK)] });
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(KEY);
    expect(created).toHaveLength(0);
    expect(rows().at(-1)).toMatchObject({ outcome: "switched", to: "key", chain: { step: 2, steps: 3, label: "key (Claude API key)" } });
  });

  it("returns from a Claude API-key step once the subscription has room", async () => {
    const { service, store, rows, paseo } = await setUp({ steps: [pool("claude"), api(KEY)], record: { step: 1 }, session: KEY });
    await service.alignSessions(paseo as never);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(CLAUDE);
    expect(rows().at(-1)).toMatchObject({ reason: "room", outcome: "switched", chain: { step: 1, label: "Claude subscription" } });
  });

  it("never puts an agent on a Claude API key that isn't a step of its chain", async () => {
    const { service, store, created, limitTurn } = await setUp({ steps: [pool("claude"), api(BEDROCK)] });
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
    expect(created).toHaveLength(0);
  });

  it("spends a banked reset before moving on to a paid step, as an agent without a chain would", async () => {
    const { service, store, rows, created, limitTurn, redeems } = await setUp({ steps: [pool("claude"), api(BEDROCK)], redeemable: true });
    service.setPreferences(preferences.schema.parse({ autoRedeem: true, paidApiFallback: true }));
    await limitTurn();
    const state = await store.read();
    expect(redeems).toHaveLength(1);
    expect(state.sessions[AGENT]?.accountId).toBe(CLAUDE);
    expect(state.agentChains[AGENT]).toMatchObject({ chainId: "work", step: 0 });
    expect(created).toHaveLength(0);
    expect(rows().at(-1)).toMatchObject({ outcome: "reset", to: "marketing" });
  });

  it("moves to another subscription of its step first, before a banked reset or the chain's next step", async () => {
    const { service, store, limitTurn, redeems } = await setUp({
      steps: [pool("claude"), api(BEDROCK)],
      redeemable: true,
      more: [{ id: "claude-other", label: "other" }],
    });
    service.setPreferences(preferences.schema.parse({ autoRedeem: true, paidApiFallback: true }));
    await limitTurn();
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe("claude-other");
    expect(state.agentChains[AGENT]).toMatchObject({ chainId: "work", step: 0 });
    expect(redeems).toEqual([]);
  });

  it("walks on to the paid step once no reset can be spent, with paid fallback off too", async () => {
    const { service, store, rows, limitTurn, redeems } = await setUp({ steps: [pool("claude"), api(BEDROCK)] });
    service.setPreferences(preferences.schema.parse({ autoRedeem: true, paidApiFallback: false }));
    await limitTurn();
    expect(redeems).toHaveLength(1);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
    expect(rows().at(-1)).toMatchObject({ outcome: "switched", to: "bed", chain: { step: 2 } });
  });

  it("skips a Bedrock step for an agent in Claude's Auto mode, which Bedrock can't run, and says so where it lands", async () => {
    const { store, rows, created, limitTurn } = await setUp({ steps: [pool("claude"), api(BEDROCK), api(KEY)], modeId: "auto" });
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(KEY);
    expect((await store.read()).agentChains[AGENT]).toMatchObject({ chainId: "work", step: 2 });
    expect(created).toHaveLength(0);
    expect(rows().at(-1)).toMatchObject({ outcome: "switched", to: "key", chain: { step: 3 } });
    expect(String(rows().at(-1)!.detail)).toMatch(/bed \(AWS Bedrock\) wasn't used: Bedrock can't run Claude's Auto mode/);
  });

  it("stops with a note when only a Bedrock step is left for an agent whose mode Paseo doesn't say (Auto is its default)", async () => {
    const stuck = await setUp({ steps: [pool("claude"), api(BEDROCK)], modeId: "" });
    stuck.agents[0]!.currentModeId = null;
    await stuck.limitTurn();
    expect((await stuck.store.read()).sessions[AGENT]?.accountId).toBe(CLAUDE);
    expect(stuck.rows().at(-1)).toMatchObject({ outcome: "stayed", reason: "exhausted" });
    expect(String(stuck.rows().at(-1)!.detail)).toMatch(/Every later step of chain “Work” is out too\. bed \(AWS Bedrock\) wasn't used/);
  });

  it("moves on from a Bedrock step that Claude Code's API Error reply in a completed turn shows throttled", async () => {
    const { service, store, rows, created, context } = await setUp({
      steps: [pool("claude"), api(BEDROCK), pool("codex")],
      record: { step: 1 },
      session: BEDROCK,
      accounts: { [CLAUDE]: { limitedUntil: inFuture() } },
    });
    await service.onTurnEnded(
      {
        agent: { id: AGENT, provider: "claude" },
        turnId: "t",
        outcome: { kind: "completed" },
        timeline: [
          { type: "user_message", text: "Fix the build." },
          { type: "assistant_message", text: "API Error: 429 Too many tokens, please wait before trying again." },
        ],
      } as never,
      context,
    );
    expect((await store.read()).accounts.find((account) => account.id === BEDROCK)?.limitedUntil).not.toBeNull();
    expect(created).toHaveLength(1);
    expect(rows().at(-1)).toMatchObject({ outcome: "continued", toFamily: "codex", chain: { step: 3, from: expect.stringMatching(/bed/) } });
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

  it("forks an agent in Auto mode to Auto-review, not Default Permissions, and names the mode in the note", async () => {
    const { created, rows, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex")], modeId: "auto" });
    await limitTurn();
    expect(created[0]?.config.modeId).toBe("auto-review");
    expect(rows().at(-1)).toMatchObject({ outcome: "continued", detail: null, chain: { step: 2, mode: "Auto-review" } });
    const accepting = await setUp({ steps: [pool("claude"), pool("codex")], modeId: "acceptEdits" });
    await accepting.limitTurn();
    expect(accepting.created[0]?.config.modeId).toBe("auto");
  });

  it("forks an agent in Auto mode past a Bedrock step to the other provider, saying why it skipped Bedrock", async () => {
    const { store, rows, created, limitTurn } = await setUp({ steps: [pool("claude"), api(BEDROCK), pool("codex")], modeId: "auto" });
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(CLAUDE);
    expect(created).toHaveLength(1);
    expect(created[0]?.config.modeId).toBe("auto-review");
    expect(rows().at(-1)).toMatchObject({ outcome: "continued", toFamily: "codex", chain: { step: 3, mode: "Auto-review" } });
    expect(String(rows().at(-1)!.detail)).toMatch(/bed \(AWS Bedrock\) wasn't used: Bedrock can't run Claude's Auto mode/);
  });

  it("forks in the mode the step sets, even one that allows more than the original's", async () => {
    const { created, rows, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex", "gpt-6.1-sol", "full-access")], modeId: "acceptEdits" });
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(created[0]!.config).toEqual({ provider: "codex/gpt-6.1-sol", modeId: "full-access" });
    expect(rows().at(-1)).toMatchObject({ outcome: "continued", detail: null, chain: { step: 2, model: "gpt-6.1-sol", mode: "Full Access" } });
  });

  it("falls back to the closest mode when the step's mode isn't one the provider has, and says so", async () => {
    const { created, rows, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex", null, "yolo")], modeId: "bypassPermissions" });
    await limitTurn();
    expect(created[0]?.config.modeId).toBe("full-access");
    const row = rows().at(-1)!;
    expect(row).toMatchObject({ outcome: "continued", chain: { mode: "Full Access" } });
    expect(String(row.detail)).toMatch(/Step 2's permission mode “yolo” isn't one ChatGPT has here, so the new agent got “Full Access”/);
  });

  it("forks an agent in Plan Mode or Always Ask when the step sets a mode of its own", async () => {
    const planning = await setUp({ steps: [pool("claude"), pool("codex", null, "auto")], modeId: "plan" });
    await planning.limitTurn();
    expect(planning.created).toHaveLength(1);
    expect(planning.created[0]!.config.modeId).toBe("auto");
    expect(planning.rows().at(-1)).toMatchObject({ outcome: "continued", chain: { mode: "Default Permissions" } });
    await planning.service.stop();

    // A step whose mode the provider lacks still follows the safety rule: nothing as careful, no fork.
    const asking = await setUp({ steps: [pool("claude"), pool("codex", null, "yolo")], modeId: "default" });
    await asking.limitTurn();
    expect(asking.created).toHaveLength(0);
    expect(String(asking.rows().at(-1)!.detail)).toMatch(/permission mode “yolo” isn't one ChatGPT has here, and ChatGPT has no mode as careful/);
  });

  it("tries a later step of the other provider that sets a mode after one that couldn't take the agent", async () => {
    const { created, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex"), pool("codex", "gpt-6.1-sol", "auto-review")], modeId: "plan" });
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(created[0]!.config).toEqual({ provider: "codex/gpt-6.1-sol", modeId: "auto-review" });
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

  it("doesn't return an agent in Auto mode to an earlier Bedrock step, and does for one in another mode", async () => {
    const steps = [pool("claude"), api(BEDROCK), api(KEY)];
    const auto = await setUp({ steps, record: { step: 2 }, session: KEY, modeId: "auto", accounts: { [CLAUDE]: { limitedUntil: inFuture() } } });
    await auto.service.alignSessions(auto.paseo as never);
    expect((await auto.store.read()).sessions[AGENT]?.accountId).toBe(KEY);
    // A session that opens without its mode known asks Paseo for it before a Bedrock step.
    await auto.service.onSessionOpen({ agentId: AGENT, provider: "claude", reason: "resume", purpose: "interactive", env: {} } as never, auto.context);
    expect((await auto.store.read()).sessions[AGENT]?.accountId).toBe(KEY);
    await auto.service.stop();

    const editing = await setUp({ steps, record: { step: 2 }, session: KEY, modeId: "acceptEdits", accounts: { [CLAUDE]: { limitedUntil: inFuture() } } });
    await editing.service.alignSessions(editing.paseo as never);
    expect((await editing.store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
  });

  it("keeps an agent in Auto mode on a Bedrock step picked for it by hand", async () => {
    const { service, store, paseo } = await setUp({ steps: [pool("claude"), api(BEDROCK)], record: { step: 1, manual: true }, session: BEDROCK, modeId: "auto" });
    await service.alignSessions(paseo as never);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
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
    // Without a chain, the fork toggle (off) and the paid fallback rule (on here) decide: Bedrock, not ChatGPT.
    const { service, store, created, rows, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex")], record: "off" });
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    await limitTurn();
    expect(created).toHaveLength(0);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(BEDROCK);
    expect(rows().at(-1)).toMatchObject({ outcome: "switched", to: "bed" });
    expect(rows().at(-1)?.chain).toBeUndefined();
  });

  it("keeps a subscription step off Bedrock while ChatGPT has room", async () => {
    // The chain says ChatGPT comes before Bedrock, so the paid fallback rule doesn't apply, even when it's on.
    const { service, store, created, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex"), api(BEDROCK)] });
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    await limitTurn();
    expect(created).toHaveLength(1);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(CLAUDE);
  });

  it("lists each provider's permission modes, and saves a step's mode only when its provider has it", async () => {
    const { service, store, paseo } = await setUp({ steps: [pool("claude")] });
    const modes = await service.chainModes(paseo as never);
    expect(modes.codex?.map((mode) => [mode.id, mode.label, mode.colorTier])).toEqual([
      ["auto", "Default Permissions", "moderate"],
      ["auto-review", "Auto-review", "moderate"],
      ["full-access", "Full Access", "dangerous"],
    ]);
    expect(modes.claude?.map((mode) => mode.id)).toEqual(["plan", "default", "acceptEdits", "auto", "bypassPermissions"]);

    const { id } = await service.saveChain({ name: "Moded", steps: [pool("claude"), { ...pool("codex"), modeId: " full-access " }] }, paseo as never);
    expect((await store.read()).chains.find((chain) => chain.id === id)?.steps.map((step) => step.modeId)).toEqual([null, "full-access"]);
    await expect(service.saveChain({ name: "Odd", steps: [{ ...pool("codex"), modeId: "bypassPermissions" }] }, paseo as never)).rejects.toThrow(
      /Step 1: ChatGPT has no permission mode “bypassPermissions”/,
    );
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

  it("binds the chain of the provider a new agent was created on, over the default, and /chain still works", async () => {
    const chainProvider = "zerosub-chain-other-claude";
    const { service, store, context, paseo, agents } = await setUp({ steps: [pool("claude"), api(BEDROCK)], families: { [chainProvider]: "claude" } });
    await store.update((draft) => {
      draft.chains.push({ id: "other", name: "Other", steps: [pool("claude"), pool("codex")], auto: false });
    });
    await service.onSessionOpen({ agentId: "picked", provider: chainProvider, reason: "create", purpose: "interactive", workspaceId: "ws-1", env: {} } as never, context);
    // Picked explicitly, so it counts outside a workspace too (`paseo run --provider …`).
    await service.onSessionOpen({ agentId: "cli", provider: chainProvider, reason: "create", purpose: "interactive", env: {} } as never, context);
    let state = await store.read();
    expect(state.agentChains.picked).toMatchObject({ chainId: "other", step: 0 });
    expect(state.agentChains.cli).toMatchObject({ chainId: "other", step: 0 });
    expect(state.sessions.picked?.accountId).toBe(CLAUDE);

    // Reopening doesn't bind it again: `/chain off` sticks.
    agents.push({ id: "picked", provider: chainProvider, status: "idle", workspaceId: "ws-1", archivedAt: null, labels: {} });
    expect(await service.setAgentChain(paseo as never, "picked", "off")).toEqual({ chain: null });
    await service.onSessionOpen({ agentId: "picked", provider: chainProvider, reason: "resume", purpose: "interactive", workspaceId: "ws-1", env: {} } as never, context);
    state = await store.read();
    expect(state.agentChains.picked?.chainId).toBeNull();
    expect(await service.setAgentChain(paseo as never, "picked", "chain", "work")).toEqual({ chain: "Work" });
  });

  it("gives no chain to a new agent on a deleted chain's provider", async () => {
    const chainProvider = "zerosub-chain-gone-claude";
    const { service, store, context } = await setUp({ steps: [pool("claude")], families: { [chainProvider]: "claude" } });
    await service.onSessionOpen({ agentId: "late", provider: chainProvider, reason: "create", purpose: "interactive", workspaceId: "ws-1", env: {} } as never, context);
    expect((await store.read()).agentChains.late).toMatchObject({ chainId: null });
  });

  it("forks to the other family's own provider, never a chain's provider entry", async () => {
    const families = { "zerosub-chain-work-claude": "claude", "zerosub-chain-work-codex": "codex" } as const;
    const { created, store, limitTurn } = await setUp({ steps: [pool("claude"), pool("codex")], families });
    await limitTurn();
    expect(created[0]?.config.provider).toBe("codex/gpt-5.6-sol");
    expect((await store.read()).agentChains[created[0]!.agentId]).toMatchObject({ chainId: "work", step: 1 });

    // With Codex's own entry bringing its own key, a profile of the user's that runs Codex is next.
    const own = await setUp({
      steps: [pool("claude"), pool("codex")],
      families: { codex: undefined as unknown as "codex", "zerosub-chain-work-codex": "codex", "my-codex": "codex" },
    });
    await own.limitTurn();
    expect(own.created[0]?.config.provider).toBe("my-codex/gpt-5.6-sol");
  });
});

describe("chains as Paseo providers", () => {
  const userEntry = { extends: "claude", label: "Claude (work proxy)", env: { HTTPS_PROXY: "http://proxy:8080" } };

  it("publishes each chain, keeps the user's entries, and does nothing when it's all in place", async () => {
    const { service, paseo, config, patches } = await setUp({ steps: [pool("claude"), pool("codex")], providers: { "claude-work": userEntry } });
    await service.syncChainProviders(paseo as never);
    expect(config.providers["claude-work"]).toEqual(userEntry);
    expect(config.providers["zerosub-chain-work-claude"]).toEqual({
      extends: "claude",
      label: "⛓ Work",
      description: "ZeroSub fallback chain: Claude subscription → ChatGPT subscription",
      env: { ZEROSUB_CHAIN: "work" },
    });
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0]!.providers as object)).toEqual(["zerosub-chain-work-claude"]);
    await service.syncChainProviders(paseo as never);
    expect(patches).toHaveLength(1);
  });

  it("follows renames, the picker toggle and deletion; keeps an entry an agent still uses, marked deleted", async () => {
    const { service, store, paseo, config, agents } = await setUp({ steps: [pool("claude"), pool("codex")] });
    await service.syncChainProviders(paseo as never);
    const { id } = await service.saveChain({ id: "work", name: "Day job", steps: [pool("claude"), pool("codex")] }, paseo as never);
    expect(config.providers["zerosub-chain-work-claude"]?.label).toBe("⛓ Day job");

    // A new chain, hidden from the picker: no entry. Shown again: there it is.
    const { id: hidden } = await service.saveChain({ name: "Night", steps: [pool("codex")], picker: false }, paseo as never);
    expect(Object.keys(config.providers)).toEqual(["zerosub-chain-work-claude"]);
    expect((await store.read()).chains.find((chain) => chain.id === hidden)?.picker).toBe(false);
    await service.saveChain({ id: hidden, name: "Night", steps: [pool("codex")], picker: true }, paseo as never);
    expect(config.providers[`zerosub-chain-${hidden}-codex`]).toMatchObject({ extends: "codex", label: "⛓ Night" });
    // Saving without saying keeps the choice.
    await service.saveChain({ id: hidden, name: "Night", steps: [pool("codex")] }, paseo as never);
    expect(config.providers[`zerosub-chain-${hidden}-codex`]).toBeDefined();

    // An agent (archived even) on the chain's provider keeps the entry once the chain is deleted.
    agents.push({ id: "on-chain", provider: "zerosub-chain-work-claude", status: "closed", archivedAt: "2026-11-01T00:00:00Z", labels: {} });
    await service.deleteChain(id, paseo as never);
    expect(config.providers["zerosub-chain-work-claude"]).toMatchObject({ extends: "claude", label: "⛓ Day job (deleted)" });
    agents.pop();
    await service.syncChainProviders(paseo as never);
    expect(config.providers["zerosub-chain-work-claude"]).toBeUndefined();
  });

  it("keeps the old family's entry while a profile uses it when the first step moves to the other provider", async () => {
    const profiles = [{ id: "p", name: "Work", provider: "zerosub-chain-work-claude" }];
    const { service, paseo, config } = await setUp({ steps: [pool("claude"), pool("codex")], profiles });
    await service.syncChainProviders(paseo as never);
    await service.saveChain({ id: "work", name: "Work", steps: [pool("codex"), pool("claude")] }, paseo as never);
    expect(config.providers["zerosub-chain-work-codex"]).toMatchObject({ extends: "codex", label: "⛓ Work" });
    expect(config.providers["zerosub-chain-work-claude"]).toMatchObject({ extends: "claude", label: "⛓ Work · Claude" });
    profiles.length = 0;
    await service.syncChainProviders(paseo as never);
    expect(config.providers["zerosub-chain-work-claude"]).toBeUndefined();
  });

  it("says so when the daemon won't let it write its config, and saving a chain still works", async () => {
    const { service, store, paseo } = await setUp({ steps: [pool("claude")], readOnlyConfig: true });
    await service.saveChain({ name: "Other", steps: [pool("codex")] }, paseo as never);
    expect((await store.read()).chains.map((chain) => chain.name)).toEqual(["Work", "Other"]);
    expect((service as unknown as { chainProviders: { error: string | null } }).chainProviders.error).toMatch(/EACCES/);
  });
});

