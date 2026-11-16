import type { Chain } from "../shared/chains";
import { FAMILY_LABEL } from "../shared/model";
import { stepFamily, stepLabel, type ChainFamily } from "./chains";
import type { StoredState } from "./state";

/**
 * Fallback chains as Paseo providers (this fork). Paseo's Agent profiles and provider picker only
 * offer providers, and a plugin can't add fields to a profile, so each chain is published as a custom
 * provider entry in the daemon config (`agents.providers`): it `extends` the family of the chain's
 * first step, so it lists that provider's models and runs its CLI, and an agent created on it follows
 * the chain (see `Service.route`). ZeroSub only ever touches entries whose ID starts with
 * `CHAIN_PROVIDER_PREFIX`; everything else in the config is the user's.
 *
 * The family is part of the ID because an agent's provider can't change: an entry that switched from
 * Claude to Codex would reopen its Claude agents with Codex. When a chain's first step moves to the
 * other provider, a new entry takes over and the old one stays, relabelled, only while an agent,
 * an Agent profile or a metadata-generation setting still uses it (Paseo can't reopen an agent whose
 * provider is gone). The same goes for a deleted chain's entry, and a hidden one's.
 */
export const CHAIN_PROVIDER_PREFIX = "zerosub-chain-";
export const CHAIN_ENV = "ZEROSUB_CHAIN";

export type ChainProviderEntry = {
  extends: ChainFamily;
  label: string;
  description: string;
  env: Record<string, string>;
};

export function chainProviderId(chainId: string, family: ChainFamily): string {
  return `${CHAIN_PROVIDER_PREFIX}${chainId}-${family}`;
}

export function isChainProviderId(id: string): boolean {
  return id.startsWith(CHAIN_PROVIDER_PREFIX);
}

/** The chain and family a ZeroSub chain provider ID names; null for any other provider. */
export function parseChainProviderId(id: string): { chainId: string; family: ChainFamily } | null {
  const match = /^zerosub-chain-(.+)-(claude|codex)$/.exec(id);
  return match ? { chainId: match[1]!, family: match[2] as ChainFamily } : null;
}

/** The family the chain's first step that isn't broken runs on; null when it has none. */
export function chainFamily(state: StoredState, chain: Chain): ChainFamily | null {
  for (const step of chain.steps) {
    const family = stepFamily(state, step);
    if (family) return family;
  }
  return null;
}

export const CHAIN_LABEL_MARK = "⛓";

/** "⛓ Work": what the chain is called in Paseo's provider picker and Agent profiles. */
export function chainProviderLabel(name: string): string {
  return `${CHAIN_LABEL_MARK} ${name.trim()}`;
}

/** The entry the chain is published as, or null when it isn't (hidden, or no step it can start on). */
export function publishedEntry(state: StoredState, chain: Chain): { id: string; entry: ChainProviderEntry } | null {
  if (chain.picker === false) return null;
  const family = chainFamily(state, chain);
  if (!family) return null;
  return { id: chainProviderId(chain.id, family), entry: entryFor(state, chain, family) };
}

function entryFor(state: StoredState, chain: Chain, family: ChainFamily, suffix = ""): ChainProviderEntry {
  const steps = chain.steps.map((step) => stepLabel(state, step)).join(" → ");
  const description = `ZeroSub fallback chain: ${steps}`;
  return {
    extends: family,
    label: chainProviderLabel(chain.name) + suffix,
    description: description.length > 300 ? `${description.slice(0, 299)}…` : description,
    env: { [CHAIN_ENV]: chain.id },
  };
}

/** An entry kept for what still uses it, though the chain no longer publishes it. */
function retainedEntry(state: StoredState, id: string, existing: Record<string, unknown>): ChainProviderEntry | null {
  const parsed = parseChainProviderId(id);
  if (!parsed) return null;
  const { chainId, family } = parsed;
  const chain = state.chains.find((entry) => entry.id === chainId);
  if (chain) {
    const primary = chainFamily(state, chain);
    return entryFor(state, chain, family, primary === family ? "" : ` · ${FAMILY_LABEL[family]}`);
  }
  const before = typeof existing.label === "string" && existing.label.trim() ? existing.label.trim() : chainProviderLabel(chainId);
  return {
    extends: family,
    label: before.endsWith(" (deleted)") ? before : `${before} (deleted)`,
    description: `ZeroSub: this fallback chain was deleted. Agents on it run on ${FAMILY_LABEL[family]} without a chain.`,
    env: { [CHAIN_ENV]: chainId },
  };
}

function sameEntry(existing: unknown, wanted: ChainProviderEntry): boolean {
  if (!existing || typeof existing !== "object") return false;
  const entry = existing as Record<string, unknown>;
  const env = entry.env && typeof entry.env === "object" ? (entry.env as Record<string, unknown>) : {};
  return (
    entry.extends === wanted.extends &&
    entry.label === wanted.label &&
    entry.description === wanted.description &&
    env[CHAIN_ENV] === wanted.env[CHAIN_ENV]
  );
}

export interface ChainProviderPlan {
  /** Entries to add or update (only ZeroSub's fields; a patch merges them into what's there). */
  set: Record<string, ChainProviderEntry>;
  /** ZeroSub entries nothing uses any more. */
  remove: string[];
  /** ZeroSub entries no chain publishes, kept because something may still use them. */
  kept: string[];
}

/**
 * What to change in the daemon's provider entries so they match the chains. `inUse` holds the
 * provider IDs agents (archived ones too), Agent profiles and metadata generation use; null when
 * that's unknown, which keeps every entry a chain no longer publishes.
 */
export function planChainProviders(
  state: StoredState,
  providers: Record<string, unknown> | undefined,
  inUse: ReadonlySet<string> | null,
): ChainProviderPlan {
  const current = providers ?? {};
  const plan: ChainProviderPlan = { set: {}, remove: [], kept: [] };
  const wanted = new Map<string, ChainProviderEntry>();
  for (const chain of state.chains) {
    const published = publishedEntry(state, chain);
    if (published) wanted.set(published.id, published.entry);
  }
  for (const [id, entry] of wanted) if (!sameEntry(current[id], entry)) plan.set[id] = entry;
  for (const [id, value] of Object.entries(current)) {
    if (!isChainProviderId(id) || wanted.has(id)) continue;
    const existing = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const retained = retainedEntry(state, id, existing);
    if (!retained || (inUse !== null && !inUse.has(id))) {
      plan.remove.push(id);
      continue;
    }
    plan.kept.push(id);
    if (!sameEntry(existing, retained)) plan.set[id] = retained;
  }
  return plan;
}

/** Whether the plan changes anything. */
export function planChanges(plan: ChainProviderPlan): boolean {
  return Object.keys(plan.set).length > 0 || plan.remove.length > 0;
}

/** The provider IDs Agent profiles and metadata generation in the daemon config refer to. */
export function providersInConfig(config: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  for (const profile of profiles) {
    const provider = profile && typeof profile === "object" ? (profile as Record<string, unknown>).provider : undefined;
    if (typeof provider === "string") ids.push(provider.split("/")[0]!);
  }
  const metadata = config.metadataGeneration && typeof config.metadataGeneration === "object" ? (config.metadataGeneration as Record<string, unknown>) : {};
  for (const entry of Array.isArray(metadata.providers) ? metadata.providers : []) {
    const provider = entry && typeof entry === "object" ? (entry as Record<string, unknown>).provider : undefined;
    if (typeof provider === "string") ids.push(provider);
  }
  return ids;
}

/**
 * The chain a new agent created on `provider` follows: `chainId` for one of ZeroSub's chain
 * providers (null when its chain was deleted), or undefined for any other provider.
 */
export function chainForProvider(state: StoredState, provider: string): { chainId: string | null } | undefined {
  const parsed = parseChainProviderId(provider);
  if (!parsed) return undefined;
  const chain = state.chains.find((entry) => entry.id === parsed.chainId);
  return { chainId: chain && chain.steps.length > 0 ? chain.id : null };
}
