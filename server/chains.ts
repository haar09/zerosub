import { randomBytes } from "node:crypto";
import { MAX_CHAIN_STEPS, POOL_LABEL, type Chain, type ChainStep, type ChainStepView, type ChainView } from "../shared/chains";
import { FAMILY_LABEL, isAzureAccount, isBedrockAccount, isPaidFallback, type Family } from "../shared/model";
import { canStandIn, isUsable } from "./routing";
import { accountsOf, findAccount, type AgentChain, type StoredAccount, type StoredState } from "./state";

/** Families a chain step can run on. */
export type ChainFamily = "claude" | "codex";

export function isChainFamily(family: Family): family is ChainFamily {
  return family === "claude" || family === "codex";
}

/** The family a step runs on; null when it names an account that's gone or isn't Bedrock/Azure. */
export function stepFamily(state: StoredState, step: ChainStep): ChainFamily | null {
  if (step.source === "claude" || step.source === "codex") return step.source;
  const account = findAccount(state, step.accountId);
  if (!account || !isPaidFallback(account)) return null;
  return account.family === "claude" ? "claude" : "codex";
}

export function isBroken(state: StoredState, step: ChainStep): boolean {
  return stepFamily(state, step) === null;
}

/** The step's account, for an `account` step that isn't broken. */
export function stepAccount(state: StoredState, step: ChainStep): StoredAccount | undefined {
  if (step.source !== "account") return undefined;
  const account = findAccount(state, step.accountId);
  return account && isPaidFallback(account) ? account : undefined;
}

/**
 * A step has room: a subscription pool with an account that can take work (signed in, enabled, not
 * at its limit), or an API account that's signed in, enabled and not cooling down after an error.
 */
export function stepAvailable(state: StoredState, step: ChainStep, now: number): boolean {
  if (step.source === "claude" || step.source === "codex") {
    return accountsOf(state, step.source).some((account) => canStandIn(account, now));
  }
  const account = stepAccount(state, step);
  return account !== undefined && isUsable(account, now);
}

export function stepLabel(state: StoredState, step: ChainStep): string {
  if (step.source === "claude" || step.source === "codex") return POOL_LABEL[step.source];
  const account = findAccount(state, step.accountId);
  if (!account || !isPaidFallback(account)) return "Removed account";
  return `${account.label} (${isBedrockAccount(account) ? "AWS Bedrock" : "Azure OpenAI"})`;
}

/** "Claude subscriptions at their limit", for the note about leaving a step. */
export function leavingText(state: StoredState, step: ChainStep | undefined, account: StoredAccount, reason: "limit" | "signed_out"): string {
  if (step && (step.source === "claude" || step.source === "codex")) {
    return `${FAMILY_LABEL[step.source]} subscriptions ${reason === "limit" ? "at their limit" : "unavailable"}`;
  }
  return `${account.label} ${reason === "limit" ? "at its limit" : "unavailable"}`;
}

/** The chain an agent follows, or null for none (no record, "no chain", or a chain that's been deleted). */
export function chainOf(state: StoredState, agentId: string): { chain: Chain; record: AgentChain } | null {
  const record = state.agentChains[agentId];
  if (!record?.chainId) return null;
  const chain = state.chains.find((entry) => entry.id === record.chainId);
  if (!chain || chain.steps.length === 0) return null;
  return { chain, record };
}

/**
 * The step an agent of `family` runs at now. It returns to the earliest step of its own family at or
 * before the one it reached that has room (not below a step picked by hand, while that has room).
 * With none, it goes on to the next step that has room when that's of its own family too (an idle
 * agent isn't forked to the other provider: only a turn that runs out does that). Otherwise it stays
 * at the step it reached, or the first one of its family. Null when the chain has none of its family.
 */
export function placement(state: StoredState, chain: Chain, record: Pick<AgentChain, "step" | "manual">, family: Family, now: number): number | null {
  const steps = chain.steps;
  const same = (index: number) => steps[index] !== undefined && stepFamily(state, steps[index]!) === family;
  const open = (index: number) => same(index) && stepAvailable(state, steps[index]!, now);
  const reached = Math.min(record.step, steps.length - 1);
  const from = record.manual && open(reached) ? reached : 0;
  for (let index = from; index <= reached; index += 1) if (open(index)) return index;
  for (let index = reached + 1; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (isBroken(state, step) || !stepAvailable(state, step, now)) continue;
    if (same(index)) return index;
    break;
  }
  if (same(reached)) return reached;
  for (let index = 0; index < steps.length; index += 1) if (same(index)) return index;
  return null;
}

/** The step an account belongs to: its own `account` step, or its family's pool. Prefers `near`. */
export function stepOf(state: StoredState, chain: Chain, account: StoredAccount, near: number | null = null): number | null {
  const matches = chain.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) =>
      isPaidFallback(account) ? step.source === "account" && step.accountId === account.id : step.source === account.family,
    )
    .map(({ index }) => index);
  if (matches.length === 0) return null;
  if (near !== null && matches.includes(near)) return near;
  return matches[0]!;
}

/** The steps a seeded chain has: each provider's subscriptions there are, then each Bedrock, then each Azure account. */
export function seededSteps(state: StoredState): ChainStep[] {
  const subscribed = (family: ChainFamily) =>
    accountsOf(state, family).some((account) => account.auth !== "api" && account.signedIn);
  const steps: ChainStep[] = [];
  const blank = { model: null, thinking: null };
  if (subscribed("claude")) steps.push({ source: "claude", accountId: null, ...blank });
  if (subscribed("codex")) steps.push({ source: "codex", accountId: null, ...blank });
  for (const account of state.accounts.filter(isBedrockAccount)) steps.push({ source: "account", accountId: account.id, ...blank });
  for (const account of state.accounts.filter(isAzureAccount)) steps.push({ source: "account", accountId: account.id, ...blank });
  return steps.slice(0, MAX_CHAIN_STEPS);
}

export const SEEDED_CHAIN_ID = "default";

/**
 * Seeds the default chain once, from the accounts there are, and keeps a seeded chain nobody edited in
 * step with them. A chain the user saved, or deleted, is never touched. True when anything changed.
 */
export function seedChains(draft: StoredState): boolean {
  let changed = false;
  if (!draft.chainsSeeded) {
    const steps = seededSteps(draft);
    if (steps.length === 0) return false; // Nothing signed in yet: seed once something is.
    if (draft.chains.length === 0) {
      draft.chains.push({ id: SEEDED_CHAIN_ID, name: "Default", steps, auto: true });
      draft.defaultChain ??= SEEDED_CHAIN_ID;
    }
    draft.chainsSeeded = true;
    return true;
  }
  for (const chain of draft.chains) {
    if (!chain.auto) continue;
    const steps = seededSteps(draft);
    if (steps.length > 0 && JSON.stringify(steps) !== JSON.stringify(chain.steps)) {
      chain.steps = steps;
      changed = true;
    }
  }
  return changed;
}

export function newChainId(): string {
  return `chain-${randomBytes(4).toString("hex")}`;
}

/** Checks a chain the user saves; returns the problem, or null. */
export function chainProblem(state: StoredState, chain: Pick<Chain, "id" | "name" | "steps">): string | null {
  const name = chain.name.trim();
  if (!name) return "Give the chain a name.";
  if (state.chains.some((other) => other.id !== chain.id && other.name.trim().toLowerCase() === name.toLowerCase())) {
    return `There's already a chain called “${name}”.`;
  }
  if (chain.steps.length === 0) return "Add at least one step.";
  if (chain.steps.length > MAX_CHAIN_STEPS) return `A chain can have at most ${MAX_CHAIN_STEPS} steps.`;
  const seen = new Set<string>();
  for (const [index, step] of chain.steps.entries()) {
    if (step.source === "account") {
      const account = findAccount(state, step.accountId);
      if (!account || !isPaidFallback(account)) return `Step ${index + 1}: pick an AWS Bedrock or Azure OpenAI account.`;
    }
    const key = JSON.stringify([step.source, step.accountId, step.model ?? null, step.thinking ?? null]);
    if (seen.has(key)) return `Step ${index + 1} repeats an earlier step.`;
    seen.add(key);
  }
  return null;
}

/** The chains as the app shows them. */
export function chainViews(state: StoredState, now: number): ChainView[] {
  return state.chains.map((chain) => ({
    id: chain.id,
    name: chain.name,
    isDefault: state.defaultChain === chain.id,
    auto: chain.auto,
    steps: chain.steps.map((step): ChainStepView => {
      const family = stepFamily(state, step);
      return {
        ...step,
        label: stepLabel(state, step),
        family,
        status: family === null ? "broken" : stepAvailable(state, step, now) ? "ready" : "exhausted",
      };
    }),
  }));
}

/** When the earliest step of `chain` frees up again, from its accounts' limits; null when none says. */
export function earliestFree(state: StoredState, chain: Chain, now: number): string | null {
  let earliest: number | null = null;
  const consider = (account: StoredAccount | undefined) => {
    if (!account?.signedIn || account.disabled || !account.limitedUntil) return;
    const until = Date.parse(account.limitedUntil);
    if (Number.isFinite(until) && until > now && (earliest === null || until < earliest)) earliest = until;
  };
  for (const step of chain.steps) {
    if (step.source === "account") consider(stepAccount(state, step));
    else for (const account of accountsOf(state, step.source).filter((entry) => entry.auth !== "api")) consider(account);
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}
