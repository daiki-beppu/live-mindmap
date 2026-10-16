// 起動時に画面の外から受ける値（Foldkit の Flags）。見返しと会議中で共通に使う。
// startsNarrow: 開いた時点で幅が狭い（スマホ・縦向きの iPad）か。狭ければ右の列と字幕を隠して始める（Issue #1236 の一部）。
// 決めるのは開いたときだけで、後から幅が変わっても隠す・出すは変えない（人の操作を上書きしない）
import { Effect, Schema } from "effect";
import type { ViewingState } from "../viewing.ts";

// 狭い幅の境目。styles.css の `@media (max-width: 768px)` と同じ値にする
export const NARROW_QUERY = "(max-width: 768px)";

export const Flags = Schema.Struct({ startsNarrow: Schema.Boolean });
export type Flags = typeof Flags.Type;

// 広い幅で開いたときの Flags（テストと、Flags を渡さない呼び出しの既定）
export const WIDE: Flags = { startsNarrow: false };

// 開いた時点の幅を window から読む（Runtime.run の flags に渡す）
export const readFlags: Effect.Effect<Flags> = Effect.sync(() => Flags.make({ startsNarrow: window.matchMedia(NARROW_QUERY).matches }));

// 表示面の最初の状態。狭い幅で開いたら、見る状態の sideHidden を立てて右の列を隠して始める
export const startingSurface = <S extends { viewing: ViewingState }>(surface: S, { startsNarrow }: Flags): S =>
  startsNarrow ? { ...surface, viewing: { ...surface.viewing, sideHidden: true } } : surface;
