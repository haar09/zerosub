import { describe, expect, it } from "vitest";
import type { Chain } from "../shared/chains";
import {
  chainForProvider,
  chainProviderId,
  parseChainProviderId,
  planChainProviders,
  planChanges,
  providersInConfig,
} from "./chain-providers";
import { chainViews } from "./chains";
import { familiesFromConfig } from "./families";
import { StoredStateSchema, type StoredState } from "./state";

const claudeSub = { id: "claude-main", family: "claude", label: "Claude", kind: "main", home: null };
const codexSub = { id: "codex-main", family: "codex", label: "ChatGPT", kind: "main", home: null };
const azure = { id: "codex-azure", family: "codex", label: "Azure", kind: "managed", home: "/tmp/a", auth: "api" };

const pool = (source: "claude" | "codex") => ({ source, accountId: null, model: null, thinking: null });
const api = (accountId: string) => ({ source: "account" as const, accountId, model: null, thinking: null });

function stateWith(chains: Chain[]): StoredState {
  return StoredStateSchema.parse({
    accounts: [claudeSub, codexSub, azure].map((account) => ({ createdAt: "2026-10-01T00:00:00Z", ...account })),
    chains,
    chainsSeeded: true,
  });
}

const work: Chain = { id: "work", name: "Work", steps: [pool("claude"), pool("codex")], auto: false };
const entry = (family: "claude" | "codex", label: string, chainId = "work", description = "ZeroSub fallback chain: Claude subscription → ChatGPT subscription") => ({
  extends: family,
  label,
  description,
  env: { ZEROSUB_CHAIN: chainId },
});

describe("chain provider IDs", () => {
  it("name the chain and the family, and nothing else parses as one", () => {
    expect(chainProviderId("chain-1a2b", "codex")).toBe("zerosub-chain-chain-1a2b-codex");
    expect(parseChainProviderId("zerosub-chain-chain-1a2b-codex")).toEqual({ chainId: "chain-1a2b", family: "codex" });
    expect(parseChainProviderId("zerosub-chain-x-pi")).toBeNull();
    expect(parseChainProviderId("claude")).toBeNull();
  });

  it("bind a new agent to the chain, or to none once it's deleted", () => {
    const state = stateWith([work]);
    expect(chainForProvider(state, "zerosub-chain-work-claude")).toEqual({ chainId: "work" });
    expect(chainForProvider(state, "zerosub-chain-gone-claude")).toEqual({ chainId: null });
    expect(chainForProvider(state, "claude")).toBeUndefined();
  });
});

describe("planning the chains' provider entries", () => {
  it("adds missing entries and leaves the user's own alone", () => {
    const user = { extends: "claude", label: "Mine", env: { ANTHROPIC_BASE_URL: "http://x" } };
    const plan = planChainProviders(stateWith([work]), { mine: user, claude: { enabled: true } }, null);
    expect(plan.set).toEqual({ "zerosub-chain-work-claude": entry("claude", "⛓ Work") });
    expect(plan.remove).toEqual([]);
  });

  it("is idempotent", () => {
    const providers = { "zerosub-chain-work-claude": { ...entry("claude", "⛓ Work"), additionalModels: [] } };
    expect(planChanges(planChainProviders(stateWith([work]), providers, new Set()))).toBe(false);
  });

  it("updates a renamed chain's label", () => {
    const providers = { "zerosub-chain-work-claude": entry("claude", "⛓ Old name") };
    const plan = planChainProviders(stateWith([{ ...work, name: "Day job" }]), providers, new Set());
    expect(plan.set["zerosub-chain-work-claude"]?.label).toBe("⛓ Day job");
  });

  it("publishes a chain under its first step that isn't broken", () => {
    const chain: Chain = { ...work, steps: [api("removed"), api("codex-azure"), pool("claude")] };
    const plan = planChainProviders(stateWith([chain]), {}, null);
    expect(Object.keys(plan.set)).toEqual(["zerosub-chain-work-codex"]);
    expect(plan.set["zerosub-chain-work-codex"]?.description).toBe("ZeroSub fallback chain: Removed account → Azure (Azure OpenAI) → Claude subscription");
    expect(planChainProviders(stateWith([{ ...work, steps: [api("removed")] }]), {}, null).set).toEqual({});
  });

  it("moves to a new entry when the first step changes family, keeping the old one while it's used", () => {
    const providers = { "zerosub-chain-work-claude": entry("claude", "⛓ Work") };
    const state = stateWith([{ ...work, steps: [pool("codex"), pool("claude")] }]);
    const used = planChainProviders(state, providers, new Set(["zerosub-chain-work-claude"]));
    expect(used.set["zerosub-chain-work-codex"]).toMatchObject({ extends: "codex", label: "⛓ Work" });
    // The old entry keeps running Claude: its agents' sessions are Claude's.
    expect(used.set["zerosub-chain-work-claude"]).toMatchObject({ extends: "claude", label: "⛓ Work · Claude" });
    expect(used.remove).toEqual([]);
    const unused = planChainProviders(state, providers, new Set());
    expect(unused.remove).toEqual(["zerosub-chain-work-claude"]);
  });

  it("removes a deleted or hidden chain's entry once nothing uses it, and keeps it while unsure", () => {
    const providers = { "zerosub-chain-work-claude": entry("claude", "⛓ Work"), mine: { extends: "codex", label: "Mine" } };
    const deleted = planChainProviders(stateWith([]), providers, new Set(["mine"]));
    expect(deleted).toMatchObject({ set: {}, remove: ["zerosub-chain-work-claude"] });
    const unsure = planChainProviders(stateWith([]), providers, null);
    expect(unsure.remove).toEqual([]);
    expect(unsure.set["zerosub-chain-work-claude"]).toMatchObject({ extends: "claude", label: "⛓ Work (deleted)" });
    const hidden = planChainProviders(stateWith([{ ...work, picker: false }]), providers, new Set());
    expect(hidden.remove).toEqual(["zerosub-chain-work-claude"]);
  });

  it("removes stray entries under its prefix that name no family", () => {
    expect(planChainProviders(stateWith([]), { "zerosub-chain-oops": { extends: "claude", label: "x" } }, null).remove).toEqual(["zerosub-chain-oops"]);
  });

  it("reads the providers Agent profiles and metadata generation use", () => {
    expect(
      providersInConfig({
        agentProfiles: [{ id: "a", name: "A", provider: "zerosub-chain-work-claude" }, { id: "b", name: "B", provider: "codex/gpt-5.5" }],
        metadataGeneration: { providers: [{ provider: "claude" }] },
      }),
    ).toEqual(["zerosub-chain-work-claude", "codex", "claude"]);
  });

  it("shows the provider label on the chain's card", () => {
    const [view] = chainViews(stateWith([work]), Date.now());
    expect(view).toMatchObject({ picker: true, provider: { id: "zerosub-chain-work-claude", label: "⛓ Work" } });
    const [hidden] = chainViews(stateWith([{ ...work, picker: false }]), Date.now());
    expect(hidden).toMatchObject({ picker: false, provider: null });
  });
});

describe("chain providers' families", () => {
  it("map to the family they extend, so accounts are switched on them as on the built-in providers", () => {
    const families = familiesFromConfig({
      "zerosub-chain-work-claude": entry("claude", "⛓ Work"),
      "zerosub-chain-night-codex": entry("codex", "⛓ Night", "night"),
    });
    expect(families).toMatchObject({ claude: "claude", codex: "codex", "zerosub-chain-work-claude": "claude", "zerosub-chain-night-codex": "codex" });
  });

  it("leave out an entry whose base provider brings its own credentials, which Paseo passes on to it", () => {
    const families = familiesFromConfig({
      claude: { env: { ANTHROPIC_API_KEY: "sk-ant-x" } },
      "zerosub-chain-work-claude": entry("claude", "⛓ Work"),
      blanked: { extends: "claude", label: "Blanked", env: { ANTHROPIC_API_KEY: "" } },
    });
    expect(families.claude).toBeUndefined();
    expect(families["zerosub-chain-work-claude"]).toBeUndefined();
    expect(families.blanked).toBe("claude");
  });
});
