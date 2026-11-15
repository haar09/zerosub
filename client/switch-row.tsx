import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { SwitchRow } from "../shared/timeline";
import { AgentLinkText } from "./agent-link";
import { describeRow, isFork } from "./describe-row";

export { describeRow } from "./describe-row";

/**
 * Inline note in an agent's timeline when ZeroSub moved it to another account. When the work went on
 * in another agent, it links there.
 */
export function switchRowView(client: PluginClientContext) {
  return function SwitchRowView(props: PluginTimelineItemProps<SwitchRow>) {
    return <SwitchRowBody client={client} props={props} />;
  };
}

function SwitchRowBody({ client, props }: { client: PluginClientContext; props: PluginTimelineItemProps<SwitchRow> }) {
  const { item, theme } = props;
  const row = item.data;
  const forked = isFork(row);
  const warning =
    !forked && (row.reason === "limit" || row.reason === "signed_out" || row.reason === "exhausted" || row.outcome === "stayed");
  const icon = forked
    ? "GitFork"
    : row.reason === "exhausted" || row.outcome === "stayed"
      ? "CircleAlert"
      : row.outcome === "reset"
          ? "TimerReset"
          : "ArrowRightLeft";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        alignSelf: "flex-start",
        maxWidth: "100%",
      }}
    >
      <Icon name={icon} size={14} color={warning ? theme.colors.statusWarning : theme.colors.foregroundMuted} />
      <View style={{ flexShrink: 1, gap: 4 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{describeRow(row)}</Text>
        {row.continuedIn ? (
          <AgentLinkText
            client={client}
            props={props}
            agentId={props.agentId}
            target={{ agentId: row.continuedIn.agentId, title: row.continuedIn.title, workspaceId: row.continuedIn.workspaceId ?? null }}
            direction="to"
          />
        ) : null}
      </View>
    </View>
  );
}
