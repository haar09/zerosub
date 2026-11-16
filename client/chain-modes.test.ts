import { describe, expect, it } from "vitest";
import type { ChainView } from "../shared/chains";
import { saveChain } from "../shared/rpc";
import type { StateView } from "../shared/model";
import { MATCH_ORIGINAL_LABEL, editorStepFamily, editorStepOnBedrock, editorSteps, modeChoices, newStep, stepModeLabel, withSource } from "./chain-modes";

const CODEX = [
  { id: "auto", label: "Default Permissions", colorTier: "moderate" },
  { id: "auto-review", label: "Auto-review", colorTier: "moderate" },
  { id: "full-access", label: "Full Access", colorTier: "dangerous" },
];
const accounts = [
  { id: "codex-azure", family: "codex", azure: { endpoint: "x" }, bedrock: null },
  { id: "claude-bedrock", family: "claude", azure: null, bedrock: { region: "eu-central-1" } },
  { id: "claude-key", family: "claude", azure: null, bedrock: null },
] as unknown as StateView["accounts"];
const CLAUDE = [
  { id: "plan", label: "Plan Mode", colorTier: "planning" },
  { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
  { id: "auto", label: "Auto mode", colorTier: "moderate" },
  { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
];

describe("a chain step's permission picker", () => {
  it("offers matching the original first, then each mode, marking the dangerous ones", () => {
    expect(modeChoices(CODEX, null)).toEqual([
      { id: null, label: MATCH_ORIGINAL_LABEL, dangerous: false, missing: false },
      { id: "auto", label: "Default Permissions", dangerous: false, missing: false },
      { id: "auto-review", label: "Auto-review", dangerous: false, missing: false },
      { id: "full-access", label: "Full Access", dangerous: true, missing: false },
    ]);
  });

  it("keeps a saved mode the provider no longer lists, marked as missing", () => {
    expect(modeChoices(CODEX, "yolo").at(-1)).toEqual({ id: "yolo", label: "yolo", dangerous: false, missing: true });
    expect(modeChoices(null, "auto")).toEqual([
      { id: null, label: MATCH_ORIGINAL_LABEL, dangerous: false, missing: false },
      { id: "auto", label: "auto", dangerous: false, missing: true },
    ]);
  });

  it("drops the mode when the step moves to the other provider, and keeps it within one", () => {
    const step = { ...newStep(), modeId: "full-access" };
    expect(withSource(step, { source: "account", accountId: "codex-azure" }, accounts)).toMatchObject({ source: "account", accountId: "codex-azure", modeId: "full-access" });
    expect(withSource(step, { source: "claude", accountId: null }, accounts)).toMatchObject({ source: "claude", modeId: null });
    expect(editorStepFamily({ source: "account", accountId: "claude-bedrock" }, accounts)).toBe("claude");
    expect(editorStepFamily({ source: "account", accountId: "gone" }, accounts)).toBeNull();
  });

  it("doesn't offer Claude's Auto mode on a Bedrock step, and marks one saved with it as unsupported", () => {
    expect(editorStepOnBedrock({ source: "account", accountId: "claude-bedrock" }, accounts)).toBe(true);
    expect(editorStepOnBedrock({ source: "account", accountId: "claude-key" }, accounts)).toBe(false);
    expect(editorStepOnBedrock({ source: "claude", accountId: null }, accounts)).toBe(false);
    expect(modeChoices(CLAUDE, null, true).map((choice) => choice.id)).toEqual([null, "plan", "acceptEdits", "bypassPermissions"]);
    expect(modeChoices(CLAUDE, null).map((choice) => choice.id)).toContain("auto");
    expect(modeChoices(CLAUDE, "auto", true).find((choice) => choice.id === "auto")).toEqual({ id: "auto", label: "Auto mode", dangerous: false, missing: false, unsupported: true });
    expect(modeChoices(null, "auto", true).at(-1)).toMatchObject({ id: "auto", missing: true, unsupported: true });
  });

  it("names a step's mode by its label", () => {
    expect(stepModeLabel({ claude: null, codex: CODEX }, "codex", "full-access")).toBe("Full Access");
    expect(stepModeLabel(null, "codex", "full-access")).toBe("full-access");
  });
});

describe("the chain editor's steps", () => {
  it("start a new chain with one step that matches the original's mode", () => {
    expect(editorSteps(null)).toEqual([{ source: "claude", accountId: null, model: null, thinking: null, modeId: null }]);
    expect(newStep().modeId).toBeNull();
  });

  it("carry each step's mode into the save request, and a view from an older server as none", () => {
    const view = {
      steps: [
        { source: "claude", accountId: null, model: null, thinking: null, modeId: null, label: "Claude subscription", family: "claude", status: "ready" },
        { source: "codex", accountId: null, model: "gpt-6.1-sol", thinking: null, modeId: "full-access", label: "ChatGPT subscription", family: "codex", status: "ready" },
        { source: "codex", accountId: null, model: null, thinking: "high", label: "ChatGPT subscription", family: "codex", status: "ready" },
      ],
    } as unknown as Pick<ChainView, "steps">;
    const steps = editorSteps(view);
    expect(steps.map((step) => step.modeId)).toEqual([null, "full-access", null]);
    const input = saveChain.input.parse({ name: "Work", steps });
    expect(input.steps[1]).toEqual({ source: "codex", accountId: null, model: "gpt-6.1-sol", thinking: null, modeId: "full-access" });
    // A request from an older client, without modes, saves steps without one.
    expect(saveChain.input.parse({ name: "Work", steps: [{ source: "codex" }] }).steps[0]?.modeId).toBeNull();
  });
});
