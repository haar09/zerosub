import { formatResetIn } from "../shared/format";
import { FAMILY_LABEL } from "../shared/model";
import type { SwitchRow } from "../shared/timeline";

function cause(row: SwitchRow): string | null {
  const reset = formatResetIn(row.resetsAt);
  const from = row.from ?? "The previous account";
  switch (row.reason) {
    case "limit":
      return `${from} hit its usage limit${reset ? ` (resets ${reset})` : ""}.`;
    case "signed_out":
      return `${from} is signed out — sign it in again from Accounts.`;
    case "removed":
      return `${from} was removed.`;
    case "disabled":
      return `${from} was disabled for now.`;
    case "enabled":
      return `${row.to} is enabled again.`;
    case "default":
      return "The default account changed.";
    case "room":
      return `${row.to} has room again, so this agent leaves ${from} (a paid API).`;
    default:
      return null;
  }
}

/** The work went on in a new agent on the other provider (Claude ↔ ChatGPT). */
export function isFork(row: SwitchRow): boolean {
  return row.toFamily !== null && row.toFamily !== row.family;
}

export function describeRow(row: SwitchRow): string {
  if (row.chain) return describeChainRow(row, row.chain);
  if (isFork(row) && row.toFamily && row.continuedIn) {
    const reset = formatResetIn(row.resetsAt);
    const lead =
      row.reason === "exhausted"
        ? `Every ${FAMILY_LABEL[row.family]} account is at its limit${reset ? ` (${row.from ?? "this one"} resets ${reset})` : ""}, so the work`
        : "The work";
    return `${lead} continues on ${FAMILY_LABEL[row.toFamily]} in a new agent: “${row.continuedIn.title}” (${row.to}).${row.detail ? ` ${row.detail}` : ""}`;
  }
  if (row.reason === "exhausted") {
    const reset = formatResetIn(row.resetsAt);
    return `Every ${FAMILY_LABEL[row.family]} account is at its limit${
      reset ? `; ${row.from ?? "this one"} resets ${reset}` : ""
    }. Add another account, use a banked reset from the account button, or wait.${row.detail ? ` ${row.detail}` : ""}`;
  }
  if (row.outcome === "reset") {
    return `${row.from ?? "This account"} hit its usage limit, so a banked reset was used. ${row.detail ?? "Limits reset."}${
      row.continued ? " Carrying on." : ""
    }`;
  }
  const why = cause(row);
  const lead = why ? `${why} ` : "";
  switch (row.outcome) {
    case "continued":
      return row.continuedIn
        ? `${lead}ChatGPT conversations can't change accounts, so this task continues in “${row.continuedIn.title}” on ${row.to}.${row.detail ? ` ${row.detail}` : ""}`
        : `${lead}Continuing on ${row.to}.`;
    case "stayed":
      return `${lead}This conversation stays on ${row.from ?? "its account"}.${row.detail ? ` ${row.detail}` : ""}`;
    case "pending":
      return `${lead}Moves to ${row.to} when its session next starts.${row.detail ? ` ${row.detail}` : ""}`;
    default: {
      const from =
        row.from && row.reason !== "limit" && row.reason !== "signed_out" && row.reason !== "disabled" ? `from ${row.from} ` : "";
      return `${lead}Switched ${from}to ${row.to}${row.continued ? " and carried on" : ""}.`;
    }
  }
}

/** A move the agent's fallback chain made (this fork): "Claude subscriptions at their limit → chain “Work” step 2: …". */
function describeChainRow(row: SwitchRow, chain: NonNullable<SwitchRow["chain"]>): string {
  const reset = formatResetIn(row.resetsAt);
  const detail = row.detail ? ` ${row.detail}` : "";
  const step = `chain “${chain.name}” step ${chain.step}/${chain.steps}: ${chain.label}${chain.model ? ` (${chain.model})` : ""}`;
  if (row.outcome === "stayed") {
    return `${chain.from ?? `${row.from ?? "This account"} is out`}.${detail}${reset ? ` The earliest frees up ${reset}.` : ""}`;
  }
  if (row.reason === "room") return `${row.to} has room again → back to ${step}.`;
  const lead = `${chain.from ?? cause(row) ?? "This step is out"} → ${step}.`;
  switch (row.outcome) {
    case "continued":
      if (!row.continuedIn) return `${lead}${detail}`;
      return isFork(row) && row.toFamily
        ? `${lead} The work continues on ${FAMILY_LABEL[row.toFamily]} in a new agent: “${row.continuedIn.title}”.${detail}`
        : `${lead} ChatGPT conversations can't change accounts, so this task continues in “${row.continuedIn.title}”.${detail}`;
    case "pending":
      return `${lead} Moves when its session next starts.${detail}`;
    default:
      return `${lead}${row.continued ? " Carrying on." : ""}${detail}`;
  }
}
