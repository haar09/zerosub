/** Paseo's permission tiers for agent modes, most careful first. */
const TIERS = ["planning", "safe", "moderate", "dangerous"] as const;

export interface ModeInfo {
  id: string;
  label?: string;
  colorTier?: string | null;
  /** Paseo's icon for the mode; modes of different providers that work alike share one (e.g. `ShieldCheck` for automatic review). */
  icon?: string | null;
}

function tierOf(mode: ModeInfo | undefined): number {
  return mode?.colorTier ? TIERS.indexOf(mode.colorTier as (typeof TIERS)[number]) : -1;
}

/**
 * The other provider's mode whose Paseo tier is no higher than the source agent's: the same tier if
 * it has one, otherwise the closest more careful one. Within that tier the mode with the source's
 * icon wins (Claude's "Auto mode" and Codex's "Auto-review" both review prompts automatically and
 * share one), else the first listed. `null` when it has nothing that careful, or the source mode is
 * unknown. Tiers order modes; they don't make two providers' policies equivalent.
 */
export function equivalentMode(
  sourceModes: readonly ModeInfo[],
  sourceModeId: string | null | undefined,
  targetModes: readonly ModeInfo[],
): string | null {
  const source = sourceModes.find((mode) => mode.id === sourceModeId);
  const ceiling = tierOf(source);
  if (ceiling < 0) return null;
  let best: { mode: ModeInfo; tier: number } | null = null;
  for (const mode of targetModes) {
    const tier = tierOf(mode);
    if (tier < 0 || tier > ceiling) continue;
    const alike = Boolean(source?.icon) && mode.icon === source?.icon && best?.mode.icon !== source?.icon;
    if (!best || tier > best.tier || (tier === best.tier && alike)) best = { mode, tier };
  }
  return best?.mode.id ?? null;
}

/**
 * Whether `targetModeId`'s Paseo tier is no higher than the source mode's tier, by the same ordering
 * `equivalentMode` picks from. It compares tiers only, not what each provider's own policy allows.
 * An unknown mode on either side is never within.
 */
export function withinMode(
  sourceModes: readonly ModeInfo[],
  sourceModeId: string | null | undefined,
  targetModes: readonly ModeInfo[],
  targetModeId: string | null | undefined,
): boolean {
  const ceiling = tierOf(sourceModes.find((mode) => mode.id === sourceModeId));
  const tier = tierOf(targetModes.find((mode) => mode.id === targetModeId));
  return ceiling >= 0 && tier >= 0 && tier <= ceiling;
}
