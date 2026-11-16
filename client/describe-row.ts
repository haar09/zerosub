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
      return `A ${FAMILY_LABEL[row.family]} subscription account has room again, so this agent leaves ${from}, a paid API.`;
    default:
      return null;
  }
}

/** The work went on in a new agent on the other provider (Claude ↔ ChatGPT), or on OpenCode. */
export function isFork(row: SwitchRow): boolean {
  return row.toProvider !== null || (row.toFamily !== null && row.toFamily !== row.family);
}

export function describeRow(row: SwitchRow): string {
  if (row.chain) return describeChainRow(row, row.chain);
  if (isFork(row) && row.continuedIn) {
    const title = row.continuedIn.title;
    const detail = row.detail ? ` ${row.detail}` : "";
    if (row.delivery === "up-to-date") {
      return `The work is already up to date in “${title}” on ${row.to}; ZeroSub sent nothing new.${detail}`;
    }
    if (row.delivery === "found") {
      return `ZeroSub found the existing OpenCode continuation “${title}” but couldn't tell what it has received. Nothing was sent; open that chat to check it against the latest instructions.${detail}`;
    }
    if (row.delivery === "uncertain") {
      return `ZeroSub couldn't confirm its last handoff to “${title}”. Nothing more was sent; open that chat before retrying.${detail}`;
    }
    const reset = formatResetIn(row.resetsAt);
    const lead =
      row.reason === "exhausted"
        ? `Every ${FAMILY_LABEL[row.family]} account is at its limit${reset ? ` (${row.from ?? "this one"} resets ${reset})` : ""}, so the work`
        : "The work";
    const destination = row.toProvider ? row.to : (row.toFamily ? FAMILY_LABEL[row.toFamily] : row.to);
    // A fork to the other provider moved to an account; an OpenCode fork has none to name.
    return `${lead} continues on ${destination} in a new agent: “${title}”${row.toProvider ? "." : ` (${row.to}).`}${detail}`;
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
      if (row.continuedIn && row.detail) {
        return `${lead}${row.detail} This task continues in “${row.continuedIn.title}” on ${row.to}.`;
      }
      return row.continuedIn
        ? `${lead}ChatGPT conversations can't change accounts, so this task continues in “${row.continuedIn.title}” on ${row.to}.`
        : `${lead}Continuing on ${row.to}.`;
    case "stayed":
      return `${lead}This conversation stays on ${row.from ?? "its account"}.${row.detail ? ` ${row.detail}` : ""}`;
    case "pending":
      return `${lead}Moves to ${row.to} when its session next starts.${row.detail ? ` ${row.detail}` : ""}`;
    default: {
      const from =
        row.from && row.reason !== "limit" && row.reason !== "signed_out" && row.reason !== "disabled" && row.reason !== "room" ? `from ${row.from} ` : "";
      const place = row.sameConversation ? " in this conversation" : "";
      return `${lead}Switched ${from}to ${row.to}${place}${row.continued ? " and carried on" : ""}.${row.detail ? ` ${row.detail}` : ""}`;
    }
  }
}

/** A move the agent's fallback chain made (this fork): "Claude subscriptions at their limit → chain “Work” step 2: …". */
function describeChainRow(row: SwitchRow, chain: NonNullable<SwitchRow["chain"]>): string {
  const reset = formatResetIn(row.resetsAt);
  const detail = row.detail ? ` ${row.detail}` : "";
  const extras = [chain.model, chain.mode].filter(Boolean).join(", ");
  const step = `chain “${chain.name}” step ${chain.step}/${chain.steps}: ${chain.label}${extras ? ` (${extras})` : ""}`;
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
