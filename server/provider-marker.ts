import { isAzureHome } from "./azure";
import { isBedrockHome } from "./bedrock";
import type { StoredState } from "./state";

/**
 * Registries written by the old fork (branch `chains`, before Azure and Bedrock accounts carried an
 * explicit `provider` marker) have Azure OpenAI and AWS Bedrock accounts as plain `auth: "api"`
 * accounts. Routing and the app now go by the marker, so without it an Azure account would be an
 * unknown Codex API account and a Bedrock account a Claude API-key one (#65), never a paid fallback.
 *
 * The home tells them apart: only an Azure account's home has `azure.json`, only a Bedrock account's
 * `bedrock.json` (neither is ever linked in from the CLI's own home). A Codex API account whose home
 * has `azure.json` is marked `azure`; a Claude API account whose home has `bedrock.json`, `bedrock`.
 * Every other API account (a Claude API key, Pi's) stays as it is. Idempotent: a marked account is
 * left alone. Returns the labels of the accounts it marked, for the log.
 */
export function markApiProviders(
  draft: StoredState,
  homes: { azure(home: string | null): boolean; bedrock(home: string | null): boolean } = { azure: isAzureHome, bedrock: isBedrockHome },
): string[] {
  const marked: string[] = [];
  for (const account of draft.accounts) {
    if (account.auth !== "api" || account.provider !== undefined || !account.home) continue;
    if (account.family === "codex" && homes.azure(account.home)) {
      account.provider = "azure";
      marked.push(`${account.label} (Azure OpenAI)`);
    } else if (account.family === "claude" && homes.bedrock(account.home)) {
      account.provider = "bedrock";
      marked.push(`${account.label} (AWS Bedrock)`);
    }
  }
  return marked;
}
