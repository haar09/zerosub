import { describe, expect, it, vi } from "vitest";
import type { AccountView, StateView } from "../shared/model";
import { setAgentChain, setNextAgentAccount } from "../shared/rpc";
import { contributeCommands } from "./commands";

function account(status: AccountView["status"], nextAgentUntil: string | null): AccountView {
  return {
    id: "claude-hello",
    family: "claude",
    label: "hello",
    kind: "managed",
    email: null,
    plan: null,
    organization: null,
    status,
    isDefault: false,
    nextAgentUntil,
    limitedUntil: null,
    usage: null,
    agentCount: 0,
    home: null,
    auth: "subscription",
    api: null,
    apiEditable: false,
    proxy: null,
    proxyEditable: false,
    proxyBlocked: null,
    inheritedProxy: null,
    proxyFile: null,
    proxyFollowers: [],
    launcher: null,
    egress: null,
    externalHome: false,
    moving: null,
    azure: null,
    bedrock: null,
    apiError: null,
  };
}

/** The Command Center entries contributed for these accounts, and the RPCs they send. */
function commandCenter(accounts: AccountView[]) {
  const items: Array<{ title: string; onSelect(): unknown }> = [];
  const client = {
    addCommandCenterItem: (item: (typeof items)[number]) => {
      items.push(item);
      return () => void items.splice(items.indexOf(item), 1);
    },
    addSlashCommand: () => () => undefined,
  };
  const state: StateView = {
    accounts,
    agents: [],
    logins: [],
    providers: {},
    canReopen: false,
    browserSignIn: true,
    showComposerPill: false,
    autoSwitch: true,
    warnings: [],
    piLaunchers: null,
    piHomes: null,
  };
  const rpc = vi.fn(async () => ({ until: null }));
  const store = { current: { state, error: null, updatedAt: 0 }, subscribe: () => () => undefined, rpc, refresh: async () => undefined };
  contributeCommands(client as never, store as never);
  return { items, rpc };
}

describe("next new agent commands", () => {
  it("keep the cancel entry of a waiting pick, whatever has become of its account", async () => {
    for (const status of ["ready", "limited", "signed_out", "disabled"] as const) {
      const { items, rpc } = commandCenter([account(status, "2026-11-13T12:10:00.000Z")]);
      const cancel = items.filter((item) => item.title === "Cancel: next new Claude agent on hello");
      expect(cancel, status).toHaveLength(1);
      await cancel[0]!.onSelect();
      expect(rpc, status).toHaveBeenCalledWith(setNextAgentAccount, { accountId: "claude-hello", enabled: false });
    }
  });

  it("offer a pick only on accounts that can take agents", () => {
    const titles = (status: AccountView["status"]) => commandCenter([account(status, null)]).items.map((item) => item.title);
    expect(titles("ready")).toContain("Next new Claude agent: use hello");
    expect(titles("limited")).toContain("Next new Claude agent: use hello");
    for (const status of ["signed_out", "disabled"] as const) {
      expect(titles(status).filter((title) => title.includes("next new") || title.startsWith("Next new")), status).toEqual([]);
    }
  });
});

describe("/chain", () => {
  async function chainCommand() {
    const commands: Array<{ name: string; onSubmit(context: unknown): Promise<void> }> = [];
    const client = {
      addCommandCenterItem: () => () => undefined,
      addSlashCommand: (command: (typeof commands)[number]) => {
        commands.push(command);
        return () => undefined;
      },
    };
    const state: StateView = {
      accounts: [account("ready", null)],
      agents: [],
      logins: [],
      providers: { claude: "claude" },
      canReopen: false,
      browserSignIn: true,
      showComposerPill: false,
      autoSwitch: true,
      warnings: [],
      piLaunchers: null,
      piHomes: null,
      chains: [
        { id: "work", name: "Work", isDefault: true, auto: false, steps: [] },
        { id: "cheap", name: "Cheap first", isDefault: false, auto: false, steps: [] },
      ],
    };
    const rpc = vi.fn(async () => ({ ok: true, chain: null }));
    const store = { current: { state, error: null, updatedAt: 0 }, subscribe: () => () => undefined, rpc, refresh: async () => undefined };
    contributeCommands(client as never, store as never);
    const command = commands.find((entry) => entry.name === "chain")!;
    const run = (args: string) => command.onSubmit({ args, agent: { id: "agent-1", provider: "claude" }, openSurface: () => undefined });
    return { run, rpc };
  }

  it("sets a chain by name, follows the default, or turns it off", async () => {
    const { run, rpc } = await chainCommand();
    await run("cheap");
    expect(rpc).toHaveBeenLastCalledWith(setAgentChain, { agentId: "agent-1", mode: "chain", chainId: "cheap" });
    await run("default");
    expect(rpc).toHaveBeenLastCalledWith(setAgentChain, { agentId: "agent-1", mode: "default" });
    await run("OFF");
    expect(rpc).toHaveBeenLastCalledWith(setAgentChain, { agentId: "agent-1", mode: "off" });
    await expect(run("nope")).rejects.toThrow(/No chain matches "nope". Chains: Work, Cheap first/);
  });
});
