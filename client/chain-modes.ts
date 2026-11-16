import { BEDROCK_UNSUPPORTED_MODE, type ChainMode, type ChainModes, type ChainStep, type ChainView } from "../shared/chains";
import type { StateView } from "../shared/model";

/** What a step's permission picker offers first: no mode of its own (the original agent's, or the closest one that allows no more). */
export const MATCH_ORIGINAL_LABEL = "Match the original (safest equivalent)";

export interface ModeChoice {
  /** null: match the original agent. */
  id: string | null;
  label: string;
  /** Paseo's `dangerous` tier: the agent runs without asking for permission. */
  dangerous: boolean;
  /** The step names a mode its provider doesn't list (any more). */
  missing: boolean;
  /** The step names a mode its account can't run (Claude's Auto mode on AWS Bedrock). */
  unsupported?: boolean;
}

export function isDangerous(mode: Pick<ChainMode, "colorTier"> | undefined): boolean {
  return mode?.colorTier === "dangerous";
}

/** The provider family a step runs on in the editor; null for an account that's gone. */
export function editorStepFamily(step: Pick<ChainStep, "source" | "accountId">, accounts: StateView["accounts"]): "claude" | "codex" | null {
  if (step.source === "claude" || step.source === "codex") return step.source;
  const family = accounts.find((account) => account.id === step.accountId)?.family;
  return family === "claude" || family === "codex" ? family : null;
}

/** Whether a step runs on an AWS Bedrock account, which can't run Claude's Auto mode. */
export function editorStepOnBedrock(step: Pick<ChainStep, "source" | "accountId">, accounts: StateView["accounts"]): boolean {
  if (step.source !== "account") return false;
  const account = accounts.find((entry) => entry.id === step.accountId);
  return Boolean(account && account.family === "claude" && account.bedrock);
}

/**
 * The picker's choices for a step: match the original, then each of its provider's modes (and the
 * step's own one if that's not listed). A Bedrock step isn't offered Claude's Auto mode; one saved
 * with it shows it, marked unsupported.
 */
export function modeChoices(modes: readonly ChainMode[] | null | undefined, modeId: string | null, bedrock = false): ModeChoice[] {
  const choices: ModeChoice[] = [{ id: null, label: MATCH_ORIGINAL_LABEL, dangerous: false, missing: false }];
  for (const mode of modes ?? []) {
    if (bedrock && mode.id === BEDROCK_UNSUPPORTED_MODE) {
      if (modeId === mode.id) choices.push({ id: mode.id, label: mode.label, dangerous: isDangerous(mode), missing: false, unsupported: true });
      continue;
    }
    choices.push({ id: mode.id, label: mode.label, dangerous: isDangerous(mode), missing: false });
  }
  if (modeId && !choices.some((choice) => choice.id === modeId)) {
    choices.push({ id: modeId, label: modeId, dangerous: false, missing: true, ...(bedrock && modeId === BEDROCK_UNSUPPORTED_MODE ? { unsupported: true } : {}) });
  }
  return choices;
}

/** A step with another source; its mode is dropped when that's another provider's (mode IDs are per provider). */
export function withSource(step: ChainStep, source: Pick<ChainStep, "source" | "accountId">, accounts: StateView["accounts"]): ChainStep {
  const same = editorStepFamily(step, accounts) === editorStepFamily(source, accounts);
  return { ...step, ...source, modeId: same ? step.modeId : null };
}

/** The steps the editor starts from: a chain's as saved, or a new chain's single step. */
export function editorSteps(chain: Pick<ChainView, "steps"> | null): ChainStep[] {
  if (!chain) return [{ source: "claude", accountId: null, model: null, thinking: null, modeId: null }];
  return chain.steps.map(({ source, accountId, model, thinking, modeId }) => ({ source, accountId, model, thinking, modeId: modeId ?? null }));
}

/** A step the editor adds at the end. */
export function newStep(): ChainStep {
  return { source: "codex", accountId: null, model: null, thinking: null, modeId: null };
}

/** The label of a step's mode for its family, or its ID when the provider doesn't list it. */
export function stepModeLabel(modes: ChainModes | null | undefined, family: "claude" | "codex" | null, modeId: string): string {
  return (family ? modes?.[family]?.find((mode) => mode.id === modeId)?.label : undefined) ?? modeId;
}
