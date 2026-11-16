import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAzureAccount, isBedrockAccount, usageMonth } from "../shared/model";
import type { FamilyAdapter } from "./adapter";
import { ApiUsageStore } from "./api-usage";
import { readAzureAccount } from "./azure";
import { readBedrockAccount } from "./bedrock";
import { stepFamily } from "./chains";
import { absentPi } from "./fakes.test-support";
import type { FamilyResolver } from "./families";
import { deployBd192c7State } from "./deploy-bd192c7-state.test-support";
import { OLD_AZURE_FILE, OLD_BEDROCK_FILE, OLD_BEDROCK_KEYS_FILE, deployState, oldApiUsage, oldForkState } from "./old-fork-state.test-support";
import { markApiProviders } from "./provider-marker";
import type { Reopener } from "./reopen";
import { isLastResort } from "./routing";
import { Service } from "./service";
import { StateStore, StoredStateSchema } from "./state";

let root: string;
let homes: string;
let savedPaseo: string | undefined;
const services: Service[] = [];

/** Chains as loaded now: steps saved before steps had a permission mode get none (null, "match the original"). */
function withStepModes<T extends { steps: object[] }>(chains: readonly T[]): T[] {
  return chains.map((chain) => ({ ...chain, steps: chain.steps.map((step) => ({ ...step, modeId: null })) }));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-old-fork-"));
  homes = join(root, "homes");
  savedPaseo = process.env.PASEO_HOME;
  process.env.PASEO_HOME = join(root, "paseo");
  for (const id of ["codex-azure1", "claude-bedrock1", "claude-key1"]) await mkdir(join(homes, id), { recursive: true });
  await writeFile(join(homes, "codex-azure1", "azure.json"), JSON.stringify(OLD_AZURE_FILE));
  await writeFile(join(homes, "claude-bedrock1", "bedrock.json"), JSON.stringify(OLD_BEDROCK_FILE));
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
  if (savedPaseo === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = savedPaseo;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A host with none of the CLIs: startup only reads and migrates the registry and seeds chains. */
function service(store: StateStore): Service {
  const absent = (family: "claude" | "codex") => ({ ...absentPi(), family }) as FamilyAdapter;
  const created = new Service(
    { claude: absent("claude"), codex: absent("codex"), pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude", codex: "codex" }), invalidate: () => undefined } as unknown as FamilyResolver,
    { locate: async () => null, reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    new ApiUsageStore(join(root, "paseo", "zerosub", "api-usage.json")),
  );
  services.push(created);
  return created;
}

async function writeOldState(): Promise<{ path: string; fixture: ReturnType<typeof oldForkState> }> {
  const path = join(root, "paseo", "zerosub", "state.json");
  await mkdir(join(root, "paseo", "zerosub"), { recursive: true });
  const fixture = oldForkState(homes);
  await writeFile(path, JSON.stringify(fixture, null, 2));
  return { path, fixture };
}

describe("marking the old fork's paid API accounts", () => {
  it("marks a Codex API account with azure.json as Azure and a Claude one with bedrock.json as Bedrock, and nothing else", () => {
    const state = StoredStateSchema.parse(oldForkState(homes));
    state.accounts.push(
      StoredStateSchema.shape.accounts.parse([{ id: "pi-1", family: "pi", label: "Pi", kind: "managed", home: join(homes, "codex-azure1"), auth: "api", createdAt: "x" }])[0]!,
    );
    expect(markApiProviders(state)).toEqual(["Azure (Azure OpenAI)", "Bedrock (AWS Bedrock)"]);
    const byId = Object.fromEntries(state.accounts.map((account) => [account.id, account]));
    expect(byId["codex-azure1"]?.provider).toBe("azure");
    expect(byId["claude-bedrock1"]?.provider).toBe("bedrock");
    expect(isAzureAccount(byId["codex-azure1"]!) && isBedrockAccount(byId["claude-bedrock1"]!)).toBe(true);
    // A Claude API key without bedrock.json stays a plain API-key account (#65); so do Pi's and the CLI logins.
    for (const id of ["claude-key1", "pi-1", "claude-main", "codex-main"]) expect(byId[id]?.provider).toBeUndefined();
    expect(isLastResort(byId["claude-key1"]!)).toBe(false);
  });

  it("is idempotent, and never changes an account that already has a marker", () => {
    const state = StoredStateSchema.parse(oldForkState(homes));
    markApiProviders(state);
    const once = structuredClone(state);
    expect(markApiProviders(state)).toEqual([]);
    expect(state).toEqual(once);
    // A marker says what the account is, whatever its home has now.
    expect(markApiProviders(state, { azure: () => false, bedrock: (home) => home?.endsWith("claude-bedrock1") === true })).toEqual([]);
    expect(state.accounts.find((account) => account.id === "codex-azure1")?.provider).toBe("azure");
  });

  it("leaves an account whose home has neither file, or the other provider's, as it is", () => {
    const state = StoredStateSchema.parse(oldForkState(homes));
    expect(markApiProviders(state, { azure: () => false, bedrock: () => false })).toEqual([]);
    // Bedrock's file in a Codex home, or Azure's in a Claude one, isn't either.
    expect(markApiProviders(state, { azure: (home) => home?.includes("claude") === true, bedrock: (home) => home?.includes("codex") === true })).toEqual([]);
    expect(state.accounts.every((account) => account.provider === undefined)).toBe(true);
  });
});

describe("a registry written by the old fork", () => {
  it("loads with its chains, default chain, agents' chains and links exactly as they were", async () => {
    const { path, fixture } = await writeOldState();
    const state = await new StateStore(path).read();
    expect(state.chains).toEqual(withStepModes(fixture.chains));
    expect(fixture.chains.flatMap((chain) => chain.steps).some((step) => "modeId" in step)).toBe(false);
    expect(state.chains.flatMap((chain) => chain.steps).every((step) => step.modeId === null)).toBe(true);
    expect(state.defaultChain).toBe("default");
    expect(state.chainsSeeded).toBe(true);
    expect(state.agentChains).toEqual(fixture.agentChains);
    expect(state.links).toEqual(fixture.links);
    expect(state.accounts.map((account) => account.id)).toEqual(fixture.accounts.map((account) => account.id));
    expect(state.bindings).toEqual(fixture.bindings);
    // Loaded whole, not salvaged: the file wasn't set aside.
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(fixture, null, 2));
  });

  it("marks its Azure and Bedrock accounts on start, once, before the seeded chain follows the accounts", async () => {
    const { path, fixture } = await writeOldState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = new StateStore(path);
    await service(store).start();
    const state = await store.read();
    const byId = Object.fromEntries(state.accounts.map((account) => [account.id, account]));
    expect(byId["codex-azure1"]?.provider).toBe("azure");
    expect(byId["claude-bedrock1"]?.provider).toBe("bedrock");
    expect(byId["claude-key1"]?.provider).toBeUndefined();
    const marks = () => log.mock.calls.filter(([line]) => String(line).includes("marked accounts from an earlier build"));
    expect(marks()).toHaveLength(1);
    expect(String(marks()[0]![0])).toContain("Azure (Azure OpenAI), Bedrock (AWS Bedrock)");

    // The seeded Default chain still has its Bedrock and Azure steps, none broken; nothing else moved.
    expect(state.chains).toEqual(withStepModes(fixture.chains));
    expect(state.chains[0]!.steps.map((step) => stepFamily(state, step))).toEqual(["claude", "codex", "claude", "codex"]);
    expect(state.agentChains).toEqual(fixture.agentChains);
    expect(state.links).toEqual(fixture.links);
    const saved = JSON.parse(await readFile(path, "utf8")) as ReturnType<typeof oldForkState>;
    expect(saved.chains).toEqual(withStepModes(fixture.chains));
    expect(saved.agentChains).toEqual(fixture.agentChains);
    expect(saved.links).toEqual(fixture.links);

    // A restart finds nothing left to mark.
    await services[0]!.stop();
    await service(new StateStore(path)).start();
    expect(marks()).toHaveLength(1);
  });

  it("reads its azure.json, bedrock.json and api-usage.json as they are", async () => {
    expect(await readAzureAccount(join(homes, "codex-azure1"))).toEqual(OLD_AZURE_FILE);
    const bedrock = await readBedrockAccount(join(homes, "claude-bedrock1"));
    expect(bedrock).toMatchObject({ region: "eu-central-1", source: "host", models: OLD_BEDROCK_FILE.models, prices: OLD_BEDROCK_FILE.prices });
    await writeFile(join(homes, "claude-key1", "bedrock.json"), JSON.stringify(OLD_BEDROCK_KEYS_FILE));
    expect(await readBedrockAccount(join(homes, "claude-key1"))).toMatchObject({
      region: "us-east-1",
      source: "keys",
      accessKeyId: OLD_BEDROCK_KEYS_FILE.accessKeyId,
      secretAccessKey: OLD_BEDROCK_KEYS_FILE.secretAccessKey,
      sessionToken: OLD_BEDROCK_KEYS_FILE.sessionToken,
    });

    const month = usageMonth();
    const file = join(root, "api-usage.json");
    const old = oldApiUsage(month);
    await writeFile(file, JSON.stringify(old));
    const usage = await new ApiUsageStore(file).read();
    expect(usage.accounts).toEqual(old.accounts);
    expect(usage.threads).toEqual(old.threads);
    expect(usage.messages).toEqual(old.messages);
  });
});

describe("a registry written by the deployment build before v1.12.0 (4ad6e15)", () => {
  async function writeDeployState(): Promise<{ path: string; fixture: ReturnType<typeof deployState> }> {
    const path = join(root, "paseo", "zerosub", "state.json");
    await mkdir(join(root, "paseo", "zerosub"), { recursive: true });
    const fixture = deployState(homes, join(root, "pi-config"), join(root, "old-pi-config"));
    await writeFile(path, JSON.stringify(fixture, null, 2));
    return { path, fixture };
  }

  it("loads whole: every field as it was, and only the new folder setting for Claude accounts and the OpenCode records at their defaults", async () => {
    const { path, fixture } = await writeDeployState();
    const state = await new StateStore(path).read();
    expect(state).toEqual({ ...fixture, chains: withStepModes(fixture.chains), claudeHomes: { dir: null, from: [] }, opencodeForks: {}, opencodeHolds: {} });
    // Loaded whole, not salvaged: the file wasn't set aside.
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(fixture, null, 2));
    // A move on record from then has no `family`: the account says whose home it is.
    expect(state.moves["pi-0123456789ab"]?.family).toBeUndefined();
  });

  it("starts on it with the chains, agents' chains, links, accounts and their markers as they were", async () => {
    const { path, fixture } = await writeDeployState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // The move on record is the only thing start may finish; leave it out here (see the test above).
    const { moves: _moves, ...rest } = fixture;
    await writeFile(path, JSON.stringify({ ...rest, moves: {} }, null, 2));
    const store = new StateStore(path);
    await service(store).start();
    const state = await store.read();
    expect(state.chains).toEqual(withStepModes(fixture.chains));
    expect(state.defaultChain).toBe(fixture.defaultChain);
    expect(state.chainsSeeded).toBe(true);
    expect(state.agentChains).toEqual(fixture.agentChains);
    expect(state.links).toEqual(fixture.links);
    expect(state.bindings).toEqual(fixture.bindings);
    expect(state.defaults).toMatchObject({ claude: "claude-0123456789ab", codex: "codex-main" });
    const byId = Object.fromEntries(state.accounts.map((account) => [account.id, account]));
    expect(state.accounts.map((account) => account.id)).toEqual(fixture.accounts.map((account) => account.id));
    expect(byId["codex-azure1"]).toMatchObject({ provider: "azure", home: join(homes, "codex-azure1") });
    expect(byId["claude-bedrock1"]).toMatchObject({ provider: "bedrock", signedIn: false, apiError: "The security token included in the request is expired" });
    expect(byId["claude-key1"]?.provider).toBeUndefined();
    expect(byId["claude-0123456789ab"]).toMatchObject({ home: join(homes, "claude-0123456789ab"), limitSource: "turn", limitKind: "window" });
    // Every chain step still names an account that's there.
    for (const chain of state.chains) expect(chain.steps.map((step) => stepFamily(state, step))).not.toContain(null);
  });
});

describe("a registry written by the deployment build at bd192c7 (chains with a permission mode per step)", () => {
  async function writeLiveState() {
    const path = join(root, "paseo", "zerosub", "state.json");
    await mkdir(join(root, "paseo", "zerosub"), { recursive: true });
    const fixture = deployBd192c7State({ homes, claudeHomes: join(root, "claude-config"), piHomes: join(root, "pi-config"), oldPiHomes: join(root, "old-pi-config") });
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    await writeFile(path, text);
    return { path, fixture, text };
  }

  it("loads whole: every field as it was, and only v1.13.0's OpenCode records at their defaults", async () => {
    const { path, fixture, text } = await writeLiveState();
    const state = await new StateStore(path).read();
    expect(state).toEqual({ ...fixture, opencodeForks: {}, opencodeHolds: {} });
    // Loaded whole, not salvaged: the file wasn't set aside or rewritten.
    expect(await readFile(path, "utf8")).toBe(text);
    // A Bedrock step saved in Claude's Auto mode, which saving refuses now, still loads as it was.
    expect(state.chains.find((chain) => chain.id === "chain-0a1b2c3d")?.steps[1]).toMatchObject({ accountId: "claude-bedrock1", modeId: "auto" });
  });

  it("starts on it with the chains, step modes, agents' chains, links, markers and Claude folders as they were", async () => {
    const { path, fixture } = await writeLiveState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = new StateStore(path);
    await service(store).start();
    const state = await store.read();
    expect(state.chains).toEqual(fixture.chains);
    expect(state.defaultChain).toBe(fixture.defaultChain);
    expect(state.chainsSeeded).toBe(true);
    expect(state.agentChains).toEqual(fixture.agentChains);
    expect(state.links).toEqual(fixture.links);
    expect(state.bindings).toEqual(fixture.bindings);
    expect(state.claudeHomes).toEqual(fixture.claudeHomes);
    const byId = Object.fromEntries(state.accounts.map((account) => [account.id, account]));
    expect(state.accounts.map((account) => account.id)).toEqual(fixture.accounts.map((account) => account.id));
    expect(byId["codex-azure1"]).toMatchObject({ provider: "azure", home: join(homes, "codex-azure1") });
    expect(byId["claude-bedrock1"]).toMatchObject({ provider: "bedrock" });
    expect(byId["claude-key1"]?.provider).toBeUndefined();
    expect(byId["claude-0123456789ab"]?.home).toBe(join(root, "claude-config", "claude-0123456789ab"));
    expect(state.opencodeForks).toEqual({});
    for (const chain of state.chains) expect(chain.steps.map((step) => stepFamily(state, step))).not.toContain(null);
  });
});
