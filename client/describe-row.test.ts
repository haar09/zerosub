import { describe, expect, it } from "vitest";
import type { SwitchRow } from "../shared/timeline";
import { describeRow } from "./describe-row";

const base: SwitchRow = {
  family: "claude",
  from: "marketing",
  to: "hello",
  reason: "exhausted",
  resetsAt: null,
  continued: true,
  continuedIn: { agentId: "fork", title: "Fix the build (continued on ChatGPT)" },
  toFamily: "codex",
  toProvider: null,
  outcome: "continued",
  detail: null,
  at: "2026-11-15T12:00:00.000Z",
};

describe("chain notes", () => {
  it("say what ran out and which step the chain moved to", () => {
    const chain = { name: "Work", step: 2, steps: 4, label: "ChatGPT subscription", model: "gpt-5.5", from: "Claude subscriptions at their limit" };
    expect(describeRow({ ...base, chain })).toBe(
      "Claude subscriptions at their limit → chain “Work” step 2/4: ChatGPT subscription (gpt-5.5). The work continues on ChatGPT in a new agent: “Fix the build (continued on ChatGPT)”.",
    );
    const inPlace = { ...base, reason: "limit" as const, toFamily: null, continuedIn: null, outcome: "switched" as const, continued: true, to: "bed" };
    expect(describeRow({ ...inPlace, chain: { ...chain, step: 3, label: "bed (AWS Bedrock)", model: null } })).toBe(
      "Claude subscriptions at their limit → chain “Work” step 3/4: bed (AWS Bedrock). Carrying on.",
    );
  });

  it("say when an agent goes back to an earlier step", () => {
    const row = { ...base, reason: "room" as const, from: "bed", to: "marketing", toFamily: null, continuedIn: null, outcome: "switched" as const };
    expect(describeRow({ ...row, chain: { name: "Work", step: 1, steps: 2, label: "Claude subscription", model: null, from: null } })).toBe(
      "marketing has room again → back to chain “Work” step 1/2: Claude subscription.",
    );
  });

  it("leave notes without a chain as they were", () => {
    expect(describeRow(base)).toMatch(/^Every Claude account is at its limit, so the work continues on ChatGPT in a new agent/);
  });
});
