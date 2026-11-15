import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AccountsSurface } from "./client/accounts-surface";
import { contributeCommands } from "./client/commands";
import { contributePills } from "./client/pills";
import { PreferencesScreen } from "./client/settings-screen";
import { createZeroSubStore } from "./client/store";
import { LINKS_PANEL_ID, linkRowView, linksPanel } from "./client/agent-link";
import { switchRowView } from "./client/switch-row";
import { LINK_ROW_KIND, LINK_ROW_VERSION, LinkRowSchema, SWITCH_ROW_KIND, SWITCH_ROW_VERSION, SwitchRowSchema } from "./shared/timeline";

export default function contribute(client: PluginClientContext) {
  const store = createZeroSubStore(client);
  store.start();

  client.addSurface("accounts", (props) => <AccountsSurface {...props} store={store} />);
  client.addSidebarItem({ id: "accounts", title: "Accounts (ZeroSub)", icon: "Users", surface: "accounts" });
  client.addSettingsScreen({
    id: "preferences",
    title: "ZeroSub preferences",
    icon: "SlidersHorizontal",
    Component: (props) => (
      <PreferencesScreen {...props} onOpenAccounts={() => client.openSurface("accounts")} />
    ),
  });
  client.addTimelineRenderer({
    kind: SWITCH_ROW_KIND,
    version: SWITCH_ROW_VERSION,
    schema: SwitchRowSchema,
    Component: switchRowView(client),
  });
  client.addTimelineRenderer({
    kind: LINK_ROW_KIND,
    version: LINK_ROW_VERSION,
    schema: LinkRowSchema,
    Component: linkRowView(client),
  });
  // Opens an agent a timeline link points to, where the timeline itself can't (see `openLinked`).
  const stopPanel = client.addWorkspacePanel({
    id: LINKS_PANEL_ID,
    title: "Linked agents (ZeroSub)",
    icon: "Link",
    context: "agent",
    locations: ["workspace"],
    Component: linksPanel(store),
  });

  const stopCommands = contributeCommands(client, store);
  const stopPills = contributePills(client, store);

  return () => {
    stopPanel();
    stopPills();
    stopCommands();
    store.stop();
  };
}
