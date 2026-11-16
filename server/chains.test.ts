import { describe, expect, it } from "vitest";
import type { Chain } from "../shared/chains";
import { chainProblem, chainViews, earliestFree, placement, seedChains, seededSteps, stepLabel, stepOf } from "./chains";
import { chooseAccount } from "./routing";
import { StoredStateSchema, type StoredState } from "./state";

const soon = () => new Date(Date.now() + 30 * 60_000).toISOString();

function stateWith(accounts: Array<Record<string, unknown>>, extra: Partial<StoredState> = {}): StoredState {
  return StoredStateSchema.parse({
    accounts: accounts.map((account) => ({ kind: "managed", home: `/tmp/${String(account.id)}`, createdAt: "2026-10-01T00:00:00Z", ...account })),
    ...extra,
  });
}

const claudeSub = { id: "claude-main", family: "claude", label: "Claude", kind: "main", home: null };
const codexSub = { id: "codex-main", family: "codex", label: "ChatGPT", kind: "main", home: null };
const bedrock = { id: "claude-bedrock", family: "claude", label: "Bedrock", auth: "api", provider: "bedrock" };
const azure = { id: "codex-azure", family: "codex", label: "Azure", auth: "api", provider: "azure" };
/** A Claude API-key account (upstream #65): no provider marker. */
const claudeKey = { id: "claude-key", family: "claude", label: "Key", auth: "api" };

const pool = (source: "claude" | "codex") => ({ source, accountId: null, model: null, thinking: null });
const api = (accountId: string) => ({ source: "account" as const, accountId, model: null, thinking: null });
const chain = (steps: Chain["steps"]): Chain => ({ id: "c", name: "Work", steps, auto: false });

describe("seeding the default chain", () => {
  it("seeds Claude → ChatGPT → each Bedrock → each Azure, once", () => {
    const state = stateWith([claudeSub, codexSub, bedrock, azure]);
    expect(seedChains(state)).toBe(true);
    expect(state.chains).toHaveLength(1);
    expect(state.chains[0]!.steps.map((step) => step.accountId ?? step.source)).toEqual(["claude", "codex", "claude-bedrock", "codex-azure"]);
    expect(state.defaultChain).toBe(state.chains[0]!.id);
    expect(seedChains(state)).toBe(false);
    expect(state.chains).toHaveLength(1);
  });

  it("leaves out providers without accounts, and waits until there is one", () => {
    const empty = stateWith([{ ...claudeSub, signedIn: false }]);
    expect(seedChains(empty)).toBe(false);
    expect(empty.chainsSeeded).toBe(false);
    const claudeOnly = stateWith([claudeSub, bedrock]);
    seedChains(claudeOnly);
    expect(claudeOnly.chains[0]!.steps.map((step) => step.accountId ?? step.source)).toEqual(["claude", "claude-bedrock"]);
  });

  it("keeps an unedited seeded chain in step with new accounts, and never touches one the user edited or deleted", () => {
    const state = stateWith([claudeSub]);
    seedChains(state);
    state.accounts.push(StoredStateSchema.shape.accounts.parse([{ ...bedrock, kind: "managed", home: "/tmp/b", createdAt: "x" }])[0]!);
    expect(seedChains(state)).toBe(true);
    expect(state.chains[0]!.steps).toHaveLength(2);
    state.chains[0]!.auto = false;
    state.chains[0]!.steps = [pool("claude")];
    expect(seedChains(state)).toBe(false);
    expect(state.chains[0]!.steps).toHaveLength(1);
    state.chains = [];
    expect(seedChains(state)).toBe(false);
    expect(state.chains).toHaveLength(0);
  });

  it("leaves Claude API-key accounts out of the seeded chain", () => {
    const state = stateWith([claudeSub, claudeKey, bedrock]);
    seedChains(state);
    expect(state.chains[0]!.steps.map((step) => step.accountId ?? step.source)).toEqual(["claude", "claude-bedrock"]);
  });

  it("seeds nothing a second time once chains were seeded", () => {
    const state = stateWith([claudeSub], { chainsSeeded: true });
    expect(seedChains(state)).toBe(false);
    expect(seededSteps(state)).toHaveLength(1);
    expect(state.chains).toHaveLength(0);
  });
});

describe("where an agent is in its chain", () => {
  const steps = chain([pool("claude"), pool("codex"), api("claude-bedrock"), api("codex-azure")]);

  it("passes over steps the agent can't run on, except the one picked by hand for it", () => {
    const state = stateWith([{ ...claudeSub, limitedUntil: soon() }, bedrock, claudeKey]);
    const steps = chain([pool("claude"), api("claude-bedrock"), api("claude-key")]);
    const onBedrock = (step: Chain["steps"][number]) => step.accountId === "claude-bedrock";
    expect(placement(state, steps, { step: 2, manual: false }, "claude", Date.now())).toBe(1);
    expect(placement(state, steps, { step: 2, manual: false }, "claude", Date.now(), onBedrock)).toBe(2);
    expect(placement(state, steps, { step: 0, manual: false }, "claude", Date.now(), onBedrock)).toBe(2);
    expect(placement(state, steps, { step: 1, manual: true }, "claude", Date.now(), onBedrock)).toBe(1);
  });

  it("returns to the earliest step of its family with room", () => {
    const state = stateWith([claudeSub, codexSub, bedrock, azure]);
    expect(placement(state, steps, { step: 2, manual: false }, "claude", Date.now())).toBe(0);
  });

  it("stays on a step picked by hand while it has room", () => {
    const state = stateWith([claudeSub, codexSub, bedrock, azure]);
    expect(placement(state, steps, { step: 2, manual: true }, "claude", Date.now())).toBe(2);
  });

  it("doesn't look past a step of the other provider that has room", () => {
    const state = stateWith([{ ...claudeSub, limitedUntil: soon() }, codexSub, bedrock]);
    expect(placement(state, steps, { step: 0, manual: false }, "claude", Date.now())).toBe(0);
    const chatgptOut = stateWith([{ ...claudeSub, limitedUntil: soon() }, { ...codexSub, limitedUntil: soon() }, bedrock]);
    expect(placement(chatgptOut, steps, { step: 0, manual: false }, "claude", Date.now())).toBe(2);
  });

  it("skips a step whose account was removed", () => {
    const state = stateWith([{ ...claudeSub, limitedUntil: soon() }, { ...codexSub, limitedUntil: soon() }]);
    const broken = chain([pool("claude"), api("gone"), api("claude-bedrock")]);
    expect(placement(state, broken, { step: 0, manual: false }, "claude", Date.now())).toBe(0);
    expect(chainProblem(state, { id: "x", name: "New", steps: broken.steps })).toMatch(/Step 2: pick an AWS Bedrock, Claude API-key or Azure OpenAI account/);
  });

  it("starts a ChatGPT agent at the first ChatGPT step", () => {
    const state = stateWith([claudeSub, codexSub]);
    expect(placement(state, steps, { step: 0, manual: false }, "codex", Date.now())).toBe(1);
  });

  it("finds the step an account belongs to", () => {
    const state = stateWith([claudeSub, codexSub, bedrock, azure]);
    expect(stepOf(state, steps, state.accounts[2]!)).toBe(2);
    expect(stepOf(state, steps, state.accounts[1]!)).toBe(1);
    expect(stepOf(state, chain([pool("claude")]), state.accounts[2]!)).toBeNull();
  });

  it("takes a Claude API-key account as a step of its own, never as part of the Claude subscriptions", () => {
    const state = stateWith([claudeSub, claudeKey, codexSub, { id: "codex-key", family: "codex", label: "Odd", auth: "api" }]);
    const keyed = chain([pool("claude"), api("claude-key")]);
    expect(chainProblem(state, { id: "x", name: "Keyed", steps: keyed.steps })).toBeNull();
    expect(chainViews({ ...state, chains: [keyed] }, Date.now())[0]?.steps[1]).toMatchObject({ family: "claude", status: "ready" });
    expect(stepLabel(state, api("claude-key"))).toBe("Key (Claude API key)");
    expect(stepOf(state, keyed, state.accounts[1]!)).toBe(1);
    expect(stepOf(state, chain([pool("claude")]), state.accounts[1]!)).toBeNull();
    // A Codex API account without the Azure marker isn't one.
    expect(chainProblem(state, { id: "y", name: "Odd", steps: [api("codex-key")] })).toMatch(/Step 1: pick/);
  });

  it("says when the earliest step frees up", () => {
    const early = new Date(Date.now() + 10 * 60_000).toISOString();
    const state = stateWith([{ ...claudeSub, limitedUntil: soon() }, { ...codexSub, limitedUntil: early }]);
    expect(earliestFree(state, steps, Date.now())).toBe(early);
  });
});

describe("routing on a chain step", () => {
  const input = { agentId: "a", family: "claude" as const, reason: "create" as const, now: Date.now(), autoSwitch: true, balanceNewAgents: false, portable: true, usageOf: () => null };

  it("keeps a subscription step off paid accounts", () => {
    const state = stateWith([{ ...claudeSub, limitedUntil: soon() }, bedrock]);
    // The paid fallback rule (`paidApiFallback`), without a chain.
    expect(chooseAccount(state, { ...input, paidFallback: true })?.account.id).toBe("claude-bedrock");
    // On a chain's subscription step the chain decides, even with the preference on.
    expect(chooseAccount(state, { ...input, paidFallback: true, step: { kind: "pool" } })?.account.id).toBe("claude-main");
  });

  it("runs an account step on its account", () => {
    const state = stateWith([claudeSub, bedrock], { bindings: { a: { accountId: "claude-main", source: "user", at: "now" } } });
    expect(chooseAccount(state, { ...input, reason: "refresh", step: { kind: "account", accountId: "claude-bedrock" } })?.account.id).toBe("claude-bedrock");
  });

  it("ignores a paid pin on a subscription step", () => {
    const state = stateWith([claudeSub, bedrock], { bindings: { a: { accountId: "claude-bedrock", source: "auto", at: "now" } } });
    expect(chooseAccount(state, { ...input, reason: "refresh", step: { kind: "pool" } })?.account.id).toBe("claude-main");
  });
});
