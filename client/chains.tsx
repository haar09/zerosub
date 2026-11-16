import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { MAX_CHAIN_STEPS, POOL_LABEL, type ChainStep, type ChainView } from "../shared/chains";
import type { StateView } from "../shared/model";
import { deleteChain, saveChain, setDefaultChain } from "../shared/rpc";
import { useInputStyle } from "./pi-accounts";
import { describe, type ZeroSubStore } from "./store";
import { Badge, Button, Card, IconButton, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/** A step's source as the editor offers it: a provider's subscriptions, or one Bedrock, Claude API-key or Azure account. */
interface SourceOption {
  key: string;
  label: string;
  step: Pick<ChainStep, "source" | "accountId">;
}

function sourceOptions(state: StateView): SourceOption[] {
  const options: SourceOption[] = [
    { key: "claude", label: POOL_LABEL.claude, step: { source: "claude", accountId: null } },
    { key: "codex", label: POOL_LABEL.codex, step: { source: "codex", accountId: null } },
  ];
  const paid = (entry: StateView["accounts"][number]) =>
    entry.bedrock !== null || entry.azure !== null || (entry.family === "claude" && entry.auth === "api");
  for (const account of state.accounts.filter(paid)) {
    options.push({
      key: account.id,
      label: `${account.label} (${account.bedrock ? "AWS Bedrock" : account.azure ? "Azure OpenAI" : "Claude API key"})`,
      step: { source: "account", accountId: account.id },
    });
  }
  return options;
}

const keyOf = (step: Pick<ChainStep, "source" | "accountId">) => (step.source === "account" ? (step.accountId ?? "") : step.source);

/** One line per step: "2. ChatGPT subscription · gpt-5.5 · thinking high". */
export function stepLine(step: ChainView["steps"][number], index: number): string {
  const extras = [step.model, step.thinking ? `thinking ${step.thinking}` : null].filter(Boolean).join(" · ");
  return `${index + 1}. ${step.label}${extras ? ` · ${extras}` : ""}`;
}

/** Whether, and as what, the chain is offered in Paseo's model picker and Agent profiles; null from an older server. */
export function pickerLine(chain: ChainView): string | null {
  if (chain.provider) return `In the model picker and Agent profiles: “${chain.provider.label}”`;
  if (chain.picker === false) return "Not in the model picker or Agent profiles";
  if (chain.provider === null) return "Not in the model picker: no step it can start on";
  return null;
}

/** The "Chains" section of the Accounts screen: fallback chains, the default one, and their editor. */
export function ChainsSection({ theme, state, store, compact }: { theme: Theme; state: StateView; store: ZeroSubStore; compact: boolean }) {
  const text = useText(theme);
  const [editing, setEditing] = useState<ChainView | "new" | null>(null);
  const chains = state.chains;
  if (!chains) return null;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={text.heading} accessibilityRole="header">
          Chains
        </Text>
        <Button
          theme={theme}
          icon="Plus"
          label={compact ? "New" : "New chain"}
          accessibilityLabel="New fallback chain"
          tooltip="Make a fallback chain: the order agents move through as each step runs out"
          tooltipAlign="end"
          onPress={() => setEditing("new")}
        />
      </View>
      <Text style={text.small}>
        A chain is the order an agent falls back through when a step runs out: a provider's subscriptions (rotating between its accounts as
        usual), then another provider (the chat forks into a new agent there), then a paid API account (Bedrock, a Claude API key, Azure). New agents follow the
        default chain from its first step; switch one with the account button or /chain. An agent on a chain uses it instead of "fork to the
        other provider" and "Use paid API accounts when every subscription is out".
      </Text>
      <Text style={text.small}>
        Each chain is also a provider in Paseo's model picker and Agent profiles, as “⛓ name”: an agent started on it follows that chain,
        whatever the default. It lists the models of the chain's first provider; the one you pick is used for the first step.
      </Text>
      {state.chainProvidersError ? (
        <Text style={text.danger}>
          Couldn't add the chains to Paseo's model picker and Agent profiles ({state.chainProvidersError}). Agents can still follow a chain
          by /chain or the account button.
        </Text>
      ) : null}
      {chains.length === 0 ? <Text style={text.muted}>No chains. Agents switch accounts as without chains.</Text> : null}
      {chains.map((chain) => (
        <ChainCard key={chain.id} theme={theme} chain={chain} store={store} onEdit={() => setEditing(chain)} />
      ))}
      {editing ? (
        <ChainEditor theme={theme} state={state} store={store} chain={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </View>
  );
}

function ChainCard({ theme, chain, store, onEdit }: { theme: Theme; chain: ChainView; store: ZeroSubStore; onEdit(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const [busy, setBusy] = useState<"default" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const run = useCallback(
    async (what: "default" | "delete", action: () => Promise<unknown>, done: string) => {
      setBusy(what);
      try {
        await action();
        toast.show(done, { variant: "success" });
      } catch (error) {
        toast.error(describe(error));
      } finally {
        setBusy(null);
        setConfirmDelete(false);
      }
    },
    [toast],
  );
  return (
    <Card theme={theme}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={[text.strong, { flexShrink: 1 }]}>{chain.name}</Text>
        {chain.isDefault ? <Badge theme={theme} label="Default" tone="accent" /> : null}
        {chain.auto ? <Badge theme={theme} label="Follows your accounts" /> : null}
      </View>
      {pickerLine(chain) ? <Text style={text.muted}>{pickerLine(chain)}</Text> : null}
      <View style={{ gap: 4 }}>
        {chain.steps.map((step, index) => (
          <Text key={`${index}-${keyOf(step)}`} style={step.status === "broken" ? text.danger : text.body}>
            {stepLine(step, index)}
            {step.status === "broken" ? " — account removed, skipped" : step.status === "exhausted" ? " — out for now" : ""}
          </Text>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} size="small" icon="Pencil" label="Edit" tooltip="Change its name and steps" tooltipAlign="start" onPress={onEdit} />
        <Button
          theme={theme}
          size="small"
          icon={chain.isDefault ? "StarOff" : "Star"}
          label={chain.isDefault ? "No default" : "Make default"}
          tooltip={chain.isDefault ? "New agents get no chain" : "New agents follow this chain"}
          tooltipAlign="start"
          busy={busy === "default"}
          onPress={() =>
            void run(
              "default",
              () => store.rpc(setDefaultChain, { id: chain.isDefault ? null : chain.id }),
              chain.isDefault ? "New agents get no chain" : `New agents follow “${chain.name}”`,
            )
          }
        />
        <Button
          theme={theme}
          size="small"
          tone="danger"
          icon="Trash2"
          label={confirmDelete ? "Really delete?" : "Delete"}
          tooltip="Agents that follow it then have no chain"
          tooltipAlign="start"
          busy={busy === "delete"}
          onPress={() => (confirmDelete ? void run("delete", () => store.rpc(deleteChain, { id: chain.id }), `Deleted “${chain.name}”`) : setConfirmDelete(true))}
        />
      </View>
    </Card>
  );
}

function ChainEditor({ theme, state, store, chain, onClose }: { theme: Theme; state: StateView; store: ZeroSubStore; chain: ChainView | null; onClose(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const inputStyle = useInputStyle(theme);
  const options = sourceOptions(state);
  const [name, setName] = useState(chain?.name ?? "");
  const [steps, setSteps] = useState<ChainStep[]>(() =>
    chain ? chain.steps.map(({ source, accountId, model, thinking }) => ({ source, accountId, model, thinking })) : [{ source: "claude", accountId: null, model: null, thinking: null }],
  );
  const [picker, setPicker] = useState(chain?.picker !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (index: number, patch: Partial<ChainStep>) => setSteps(steps.map((step, at) => (at === index ? { ...step, ...patch } : step)));
  const move = (index: number, by: number) => {
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    setSteps(next);
  };
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await store.rpc(saveChain, { ...(chain ? { id: chain.id } : {}), name: name.trim(), steps, picker });
      toast.show(chain ? "Saved" : `Added “${name.trim()}”`, { variant: "success" });
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={chain ? `Edit “${chain.name}”` : "New chain"} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <View style={{ gap: 12 }}>
          <View style={{ gap: 6 }}>
            <Text style={text.strong}>Name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={40}
              placeholder="e.g. Work"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoFocus={!chain}
              style={inputStyle}
              accessibilityLabel="Chain name"
            />
          </View>
          {steps.map((step, index) => {
            const known = options.some((option) => option.key === keyOf(step));
            return (
              <View key={index} style={{ gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                  <Text style={text.strong}>Step {index + 1}</Text>
                  <View style={{ flexDirection: "row" }}>
                    <IconButton theme={theme} icon="ArrowUp" label="Move up" disabled={index === 0} onPress={() => move(index, -1)} />
                    <IconButton theme={theme} icon="ArrowDown" label="Move down" disabled={index === steps.length - 1} onPress={() => move(index, 1)} />
                    <IconButton theme={theme} icon="Trash2" tone="danger" label="Remove step" disabled={steps.length === 1} onPress={() => setSteps(steps.filter((_, at) => at !== index))} />
                  </View>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {options.map((option) => (
                    <Button
                      key={option.key}
                      theme={theme}
                      size="small"
                      tone={option.key === keyOf(step) ? "primary" : "secondary"}
                      label={option.label}
                      onPress={() => change(index, option.step)}
                    />
                  ))}
                </View>
                {!known ? <Text style={text.danger}>Its account was removed: pick another source, or remove the step.</Text> : null}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <TextInput
                    value={step.model ?? ""}
                    onChangeText={(value) => change(index, { model: value || null })}
                    maxLength={200}
                    placeholder="Model (default)"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[inputStyle, { flexGrow: 2, flexBasis: 160, minWidth: 0 }]}
                    accessibilityLabel={`Model for step ${index + 1}`}
                  />
                  <TextInput
                    value={step.thinking ?? ""}
                    onChangeText={(value) => change(index, { thinking: value || null })}
                    maxLength={100}
                    placeholder="Thinking (default)"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[inputStyle, { flexGrow: 1, flexBasis: 120, minWidth: 0 }]}
                    accessibilityLabel={`Thinking level for step ${index + 1}`}
                  />
                </View>
              </View>
            );
          })}
          <View style={{ flexDirection: "row" }}>
            <Button
              theme={theme}
              size="small"
              icon="Plus"
              label="Add step"
              tooltip="Add a step at the end"
              tooltipAlign="start"
              disabled={steps.length >= MAX_CHAIN_STEPS}
              onPress={() => setSteps([...steps, { source: "codex", accountId: null, model: null, thinking: null }])}
            />
          </View>
          <Text style={text.small}>
            Model and thinking apply when the chain starts a new agent for the step (a fork to the other provider); empty uses that provider's
            default. An agent moved in place keeps its model.
          </Text>
          <SettingsCard>
            <SettingsSwitch
              label="Show in model picker and Agent profiles"
              hint={
                picker
                  ? `Pick “⛓ ${name.trim() || "this chain"}” as the provider in an Agent profile or the model picker: agents started on it follow this chain.`
                  : "Agents follow it only by /chain, the account button, or as the default chain."
              }
              value={picker}
              onValueChange={setPicker}
            />
          </SettingsCard>
          {error ? <Text style={text.danger}>{error}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip="Close without saving" tooltipAlign="end" onPress={onClose} />
            <Button
              theme={theme}
              tone="primary"
              label={chain ? "Save" : "Add chain"}
              tooltip="Save this chain"
              tooltipAlign="end"
              busy={saving}
              disabled={!name.trim() || steps.length === 0}
              onPress={() => void submit()}
            />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
