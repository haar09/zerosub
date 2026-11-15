import { z } from "zod";

/**
 * Fallback chains (this fork): an ordered list of steps an agent walks through as each runs out.
 * `claude` and `codex` are a provider's subscription pool (the usual rotation between its accounts
 * applies within the step); `account` is one paid API account (AWS Bedrock under Claude, Azure
 * OpenAI under ChatGPT).
 */
export const ChainSourceSchema = z.enum(["claude", "codex", "account"]);
export type ChainSource = z.infer<typeof ChainSourceSchema>;

export const ChainStepSchema = z.object({
  source: ChainSourceSchema,
  /** For `account`: the Bedrock or Azure account. */
  accountId: z.string().nullable().default(null),
  /** The model an agent created for this step starts on; empty uses the provider's default. */
  model: z.string().trim().max(200).nullable().default(null),
  /** The thinking option an agent created for this step starts with; empty uses the provider's default. */
  thinking: z.string().trim().max(100).nullable().default(null),
});
export type ChainStep = z.infer<typeof ChainStepSchema>;

export const MAX_CHAIN_STEPS = 12;

export const ChainSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(40),
  steps: z.array(ChainStepSchema).max(MAX_CHAIN_STEPS),
  /**
   * Seeded by ZeroSub and never edited: its steps follow the accounts there are (each new Bedrock or
   * Azure account is added at the end). Saving it in the editor makes it the user's own.
   */
  auto: z.boolean().default(false),
  /**
   * Offered as a provider in Paseo's provider picker and Agent profiles (see server/chain-providers.ts).
   * Absent means yes.
   */
  picker: z.boolean().optional(),
});
export type Chain = z.infer<typeof ChainSchema>;

/** A step as the app shows it. */
export const ChainStepViewSchema = ChainStepSchema.extend({
  label: z.string(),
  /** The provider family the step runs on, or null when its account is gone. */
  family: z.enum(["claude", "codex"]).nullable(),
  /** `broken`: its account was removed (or is no longer a Bedrock/Azure account); routing skips it. */
  status: z.enum(["ready", "exhausted", "broken"]),
});
export type ChainStepView = z.infer<typeof ChainStepViewSchema>;

export const ChainViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  auto: z.boolean(),
  steps: z.array(ChainStepViewSchema),
  /** Offered in Paseo's provider picker and Agent profiles; absent (an older server) means yes. */
  picker: z.boolean().optional(),
  /** The provider it's offered as, e.g. `⛓ Work`; null when it isn't (hidden, or no step to start on). */
  provider: z.object({ id: z.string(), label: z.string() }).nullable().optional(),
});
export type ChainView = z.infer<typeof ChainViewSchema>;

/** Where an agent is in its chain, for its account button. `step` counts from 0. */
export const AgentChainViewSchema = z.object({
  chainId: z.string(),
  name: z.string(),
  step: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  label: z.string(),
  /** Picked by hand: the agent stays at this step (no return to an earlier one) until it runs out. */
  manual: z.boolean().default(false),
});
export type AgentChainView = z.infer<typeof AgentChainViewSchema>;

/** A conversation that continues in another agent, or continues one. */
export const AgentLinkSchema = z.object({ agentId: z.string(), title: z.string(), workspaceId: z.string().nullable().default(null) });
export type AgentLink = z.infer<typeof AgentLinkSchema>;
export const AgentLinksSchema = z.object({ next: AgentLinkSchema.nullable().default(null), previous: AgentLinkSchema.nullable().default(null) });
export type AgentLinks = z.infer<typeof AgentLinksSchema>;

export const POOL_LABEL: Record<"claude" | "codex", string> = { claude: "Claude subscription", codex: "ChatGPT subscription" };

/** "Chain: Work · step 2/4". */
export function chainSummary(chain: Pick<AgentChainView, "name" | "step" | "steps">): string {
  return `Chain: ${chain.name} · step ${chain.step + 1}/${chain.steps}`;
}

/** The chain `query` names: exactly (ignoring case), else the one it's the start of, else the one containing it. */
export function findChain<T extends { name: string }>(chains: readonly T[], query: string): T | undefined {
  const needle = query.trim().toLowerCase();
  const exact = chains.find((chain) => chain.name.toLowerCase() === needle);
  if (exact) return exact;
  const prefix = chains.filter((chain) => chain.name.toLowerCase().startsWith(needle));
  if (prefix.length === 1) return prefix[0];
  const partial = chains.filter((chain) => chain.name.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0] : undefined;
}
