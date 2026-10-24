export const SCREEN_GAP_SECONDS = 10;

export type ScreenKey = { readonly start: number; readonly image: string | null };

export const byStart = <T extends { readonly start: number }>(list: readonly T[]): T[] => [...list].sort((a, b) => a.start - b.start);

export function selectScreens<T extends { readonly start: number; readonly image: string | null }>(
  sorted: readonly T[], carried: string | undefined, anchor: number | undefined, cutoff: number,
): T[] {
  const chosen: T[] = [];
  let a = anchor;
  for (const h of sorted) {
    if (h.image === null) {
      chosen.push(h);
    } else if (a === undefined || h.start >= a + SCREEN_GAP_SECONDS || (h.image === carried && cutoff >= a + SCREEN_GAP_SECONDS)) {
      chosen.push(h);
      a = h.start;
    }
  }
  return chosen;
}

export function carriedOf(sorted: readonly ScreenKey[], attachedFiles: ReadonlySet<string>): string | undefined {
  const latest = sorted.at(-1);
  return latest?.image != null && !attachedFiles.has(latest.image) ? latest.image : undefined;
}

export function anchorAfter(attached: readonly ScreenKey[], previous: number | undefined): number | undefined {
  return attached.findLast((h) => h.image !== null)?.start ?? previous;
}
