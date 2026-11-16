import { describe, expect, it } from "vitest";
import { equivalentMode, withinMode } from "./modes";

// As Paseo 0.9.1 lists them.
const CLAUDE = [
  { id: "plan", colorTier: "planning", icon: "ShieldEllipsis" },
  { id: "default", colorTier: "safe", icon: "Shield" },
  { id: "acceptEdits", colorTier: "moderate", icon: "ShieldPlus" },
  { id: "auto", colorTier: "moderate", icon: "ShieldCheck" },
  { id: "bypassPermissions", colorTier: "dangerous", icon: "ShieldOff" },
];
const CODEX = [
  { id: "auto", colorTier: "moderate", icon: "Shield" },
  { id: "auto-review", colorTier: "moderate", icon: "ShieldCheck" },
  { id: "full-access", colorTier: "dangerous", icon: "ShieldOff" },
];
const bare = (modes: typeof CLAUDE) => modes.map(({ icon: _icon, ...mode }) => mode);

describe("equivalentMode", () => {
  it("keeps the same permission tier across providers", () => {
    expect(equivalentMode(CLAUDE, "bypassPermissions", CODEX)).toBe("full-access");
    expect(equivalentMode(CLAUDE, "acceptEdits", CODEX)).toBe("auto");
    expect(equivalentMode(CODEX, "full-access", CLAUDE)).toBe("bypassPermissions");
    expect(equivalentMode(CODEX, "auto", CLAUDE)).toBe("acceptEdits");
  });

  it("prefers the mode that works alike within a tier: Claude's Auto mode and Codex's Auto-review", () => {
    expect(equivalentMode(CLAUDE, "auto", CODEX)).toBe("auto-review");
    expect(equivalentMode(CODEX, "auto-review", CLAUDE)).toBe("auto");
    // Without icons (an older daemon), the first listed of the tier, as before.
    expect(equivalentMode(bare(CLAUDE), "auto", bare(CODEX))).toBe("auto");
    expect(equivalentMode(bare(CODEX), "auto-review", bare(CLAUDE))).toBe("acceptEdits");
  });

  it("never picks a more permissive mode than the original had", () => {
    expect(equivalentMode(CLAUDE, "plan", CODEX)).toBeNull();
    expect(equivalentMode(CLAUDE, "default", CODEX)).toBeNull();
  });

  it("falls back to a more careful tier when the same one is missing", () => {
    expect(equivalentMode(CODEX, "full-access", CLAUDE.filter((mode) => mode.colorTier !== "dangerous"))).toBe("acceptEdits");
  });

  it("refuses to guess an unknown mode", () => {
    expect(equivalentMode(CLAUDE, null, CODEX)).toBeNull();
    expect(equivalentMode(CLAUDE, "mystery", CODEX)).toBeNull();
    expect(equivalentMode([{ id: "x" }], "x", CODEX)).toBeNull();
  });
});

describe("withinMode", () => {
  it("accepts the same or a more careful tier and refuses a broader or unknown one", () => {
    expect(withinMode(CLAUDE, "bypassPermissions", CODEX, "full-access")).toBe(true);
    expect(withinMode(CLAUDE, "bypassPermissions", CODEX, "auto")).toBe(true);
    expect(withinMode(CLAUDE, "plan", CODEX, "auto")).toBe(false);
    expect(withinMode(CLAUDE, "acceptEdits", CODEX, "full-access")).toBe(false);
    expect(withinMode(CLAUDE, "bypassPermissions", CODEX, "mystery")).toBe(false);
    expect(withinMode(CLAUDE, "mystery", CODEX, "auto")).toBe(false);
  });
});
