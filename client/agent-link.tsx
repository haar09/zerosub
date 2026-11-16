import { useAgent, type PluginAgentPanelProps, type PluginClientContext, type PluginHostProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { AgentLink } from "../shared/chains";
import type { LinkRow } from "../shared/timeline";
import { useStore, type ZeroSubStore } from "./store";
import { Button, Card, useText } from "./ui";

/** The agent panel that opens a linked agent when the timeline can't (see `openLinked`). */
export { LINKS_PANEL_ID } from "./panel-ids";
import { LINKS_PANEL_ID } from "./panel-ids";

type Navigation = { openAgent?(input: { agentId: string; serverId?: string }): void };

/** The host's navigation, where it gives one: surfaces and panels get it; newer hosts may give it to timeline rows too. */
function navigationOf(props: PluginHostProps): Navigation | undefined {
  return (props as { navigation?: Navigation }).navigation;
}

/**
 * Opens a linked agent: straight away where the host hands this view its navigation, otherwise
 * through ZeroSub's "Linked agents" panel beside the current agent, whose button opens it (Paseo
 * 0.9's timeline rows can't navigate by themselves).
 */
export function openLinked(client: PluginClientContext, props: PluginHostProps, current: { agentId: string; workspaceId: string | null }, target: AgentLink): void {
  const navigation = navigationOf(props);
  if (navigation?.openAgent) {
    navigation.openAgent({ agentId: target.agentId, serverId: props.host.id });
    return;
  }
  const workspaceId = current.workspaceId ?? target.workspaceId;
  if (workspaceId) client.openPanel(LINKS_PANEL_ID, { workspaceId, agentId: current.agentId });
}

/** "Continued in → title" or "← Continued from title", as a link. */
export function AgentLinkText({
  client,
  props,
  agentId,
  target,
  direction,
}: {
  client: PluginClientContext;
  props: PluginHostProps;
  agentId: string;
  target: AgentLink;
  direction: "to" | "from";
}) {
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const label = direction === "to" ? `Continued in → ${target.title}` : `← Continued from ${target.title}`;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={direction === "to" ? `Open ${target.title}, where this conversation continues` : `Open ${target.title}, where this conversation came from`}
      onPress={() => openLinked(client, props, { agentId, workspaceId: workspaceId ?? null }, target)}
      hitSlop={4}
    >
      {({ pressed }) => (
        <Text style={{ color: props.theme.colors.accent, fontSize: 13, fontWeight: "600", textDecorationLine: "underline", opacity: pressed ? 0.7 : 1 }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** The note at the top of an agent that carries on another's conversation. */
export function linkRowView(client: PluginClientContext) {
  return function LinkRowView(props: PluginTimelineItemProps<LinkRow>) {
    const row = props.item.data;
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 6,
          paddingHorizontal: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: props.theme.colors.border,
          backgroundColor: props.theme.colors.surface1,
          alignSelf: "flex-start",
          maxWidth: "100%",
        }}
      >
        <Icon name="Link" size={14} color={props.theme.colors.foregroundMuted} />
        <AgentLinkText client={client} props={props} agentId={props.agentId} target={row} direction={row.direction} />
      </View>
    );
  };
}

/** The "Linked agents" panel: where this agent's conversation went on, and where it came from. */
export function linksPanel(store: ZeroSubStore) {
  return function LinksPanel(props: PluginAgentPanelProps) {
    const { state } = useStore(store);
    const text = useText(props.theme);
    const links = state?.agents.find((route) => route.agentId === props.agentId)?.links;
    const openAgent = props.navigation?.openAgent;
    const entry = (target: AgentLink | null | undefined, direction: "to" | "from") =>
      target ? (
        <Card theme={props.theme} key={direction}>
          <Text style={text.small}>{direction === "to" ? "This conversation continues in" : "This conversation continues"}</Text>
          <Text style={text.strong}>{direction === "to" ? `→ ${target.title}` : `← from ${target.title}`}</Text>
          {openAgent ? (
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={props.theme}
                tone="primary"
                icon="ExternalLink"
                label="Open"
                tooltip={`Open “${target.title}”`}
                tooltipAlign="start"
                onPress={() => openAgent({ agentId: target.agentId, serverId: props.host.id })}
              />
            </View>
          ) : (
            <Text style={text.small}>Open it from the agent list; this version of Paseo doesn't let plugins open agents.</Text>
          )}
        </Card>
      ) : null;
    return (
      <View style={{ flex: 1, padding: 16, gap: 12, backgroundColor: props.theme.colors.surface0 }}>
        <Text style={text.heading}>Linked agents</Text>
        {entry(links?.next, "to")}
        {entry(links?.previous, "from")}
        {!links?.next && !links?.previous ? <Text style={text.muted}>This agent doesn't continue another, and isn't continued elsewhere.</Text> : null}
      </View>
    );
  };
}
