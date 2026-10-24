import { Effect, Schema } from "effect";
import type { ViewingState } from "../viewing.ts";

export const NARROW_QUERY = "(max-width: 768px)";

export const Flags = Schema.Struct({ startsNarrow: Schema.Boolean });
export type Flags = typeof Flags.Type;

export const WIDE: Flags = { startsNarrow: false };

export const readFlags: Effect.Effect<Flags> = Effect.sync(() => Flags.make({ startsNarrow: window.matchMedia(NARROW_QUERY).matches }));

export const startingSurface = <S extends { viewing: ViewingState }>(surface: S, { startsNarrow }: Flags): S =>
  startsNarrow ? { ...surface, viewing: { ...surface.viewing, sideHidden: true } } : surface;
