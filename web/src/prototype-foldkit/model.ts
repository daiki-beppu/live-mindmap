// 試作（Issue #736）: Foldkit 版の見返しの Model。React 版で ref と effect に散っていた値（反映の round・全体を見る前の位置・
// 位置を保つ基準・列のずらしの保留・補間の途中）を、ここに 1 つの値として持つ。配置・畳み・カメラの計算は既存の純粋関数を使う
import { Schema } from "effect";
import { Slider } from "@foldkit/ui";
import type { Snapshot, SnapshotNode } from "../../../server/src/core/index.ts";
import type { ScrollAxisLock, Viewport } from "../camera.ts";
import { foldView, type FoldView } from "../folding.ts";
import { layout, type Position } from "../layout.ts";
import type { PreviousView } from "../relocation.ts";
import { AUDIO_RATE, AUDIO_RATES, initialPlayback, PLAYBACK_RATES, type PlaybackContext, type PlaybackState } from "../reviewPlayback.ts";
import { buildReviewTimeline, reviewChapters, reviewMarks, snapshotAt, type Chapter, type Mark, type ReviewTimeline } from "../reviewTimeline.ts";
import { humanSetsOf, INITIAL_VIEWING, type ViewingState, type VisibleTree } from "../viewing.ts";

export type Positions = Record<string, Position>;
export type Dims = Record<string, { width: number; height: number }>;
export type Size = { width: number; height: number };

// 起動時に決まり、Model に入れない入力（ログから作った時間軸など）。update と view が引数で受ける
export type Context = {
  timeline: ReviewTimeline;
  chapters: readonly Chapter[];
  marks: readonly Mark[];
  audio: boolean;
  playback: PlaybackContext;
  isMac: boolean;
};

export function makeContext(events: readonly unknown[], audio: boolean, isMac: boolean): Context {
  const timeline = buildReviewTimeline(events);
  return {
    timeline,
    chapters: reviewChapters(timeline),
    marks: reviewMarks(timeline),
    audio,
    playback: { duration: timeline.duration, reflectionTimes: timeline.reflectionTimes, rates: audio ? AUDIO_RATES : PLAYBACK_RATES },
    isMac,
  };
}

// スナップショットと見る状態と実寸から導く値。入力が変わったときだけ作り直す（React 版の useMemo の連なり）
export type Derived = {
  snapshot: Snapshot;
  view: FoldView;
  nodes: SnapshotNode[];
  target: Positions;
  tree: VisibleTree;
};

export function derive(snapshot: Snapshot, viewing: ViewingState, dims: Dims): Derived {
  const { opened, folded, unbundled } = humanSetsOf(viewing);
  const view = foldView(snapshot, opened, viewing.selection?.id ?? null, folded, unbundled);
  const nodes = view.nodes;
  const target = layout(nodes, Object.fromEntries(Object.entries(dims).map(([id, d]) => [id, d.height])));
  const tree: VisibleTree = {
    ids: nodes.map((n) => n.id),
    targets: target,
    parents: Object.fromEntries(nodes.map((n) => [n.id, n.parent])),
    foldState: Object.fromEntries(nodes.filter((n) => (n.kind === "議題" || n.kind === "論点") && !view.summaries.has(n.id)).map((n) => [n.id, n.id in view.folds ? "folded" : "open"])),
    runs: view.runs,
    currentTopic: snapshot.currentTopic,
  };
  return { snapshot, view, nodes, target, tree };
}

export type Drag = { kind: "pane"; x: number; y: number } | { kind: "node"; id: string; x0: number; y0: number; dragged: boolean };

export type Model = {
  playback: PlaybackState;
  viewing: ViewingState;
  // 見返しの 10 秒の計り直しの番号。E・C・選択以外の出来事で進める
  idleSeq: number;
  d: Derived;
  dims: Dims;
  size: Size;
  viewport: Viewport;
  // 表示している位置（補間の途中を含む）と、補間の出発点・目標・経過
  shown: Positions;
  anim: { from: Positions; to: Positions; elapsed: number } | null;
  placedRound: number | null;
  beforeOverview: Viewport | null;
  keepAnchor: { id: string; point: { x: number; y: number } } | null;
  pendingShift: boolean;
  axisLock: ScrollAxisLock | null;
  drag: Drag | null;
  // 最後にノードを押したときの、ドラッグになったか（click で使い切る）
  lastPress: { id: string; dragged: boolean } | null;
  previous: PreviousView;
  rateMenuOpen: boolean;
  seekPointer: number | null;
  seekSlider: Slider.Model;
  volumeSlider: Slider.Model;
};

// Foldkit は Model を Schema で受ける（開発時の Model の保存と DevTools 用）。スナップショットや Set を持つので、形は検めずに通す
export const ModelSchema = Schema.declare((u: unknown): u is Model => typeof u === "object" && u !== null);

export const SEEK_ID = "fk-seek";
export const VOLUME_ID = "fk-volume";

export function initModel(ctx: Context): Model {
  const playback = initialPlayback(ctx.timeline.duration, ctx.audio ? AUDIO_RATE : undefined);
  const snapshot = snapshotAt(ctx.timeline, playback.time);
  const d = derive(snapshot, INITIAL_VIEWING, {});
  return {
    playback,
    viewing: INITIAL_VIEWING,
    idleSeq: 0,
    d,
    dims: {},
    size: { width: 0, height: 0 },
    viewport: { x: 0, y: 0, zoom: 1 },
    shown: d.target,
    anim: null,
    placedRound: null,
    beforeOverview: null,
    keepAnchor: null,
    pendingShift: false,
    axisLock: null,
    drag: null,
    lastPress: null,
    previous: { tree: d.tree, snapshot, selectedId: null },
    rateMenuOpen: false,
    seekPointer: null,
    seekSlider: Slider.init({ id: SEEK_ID, min: 0, max: ctx.timeline.duration, step: 1 }),
    volumeSlider: Slider.init({ id: VOLUME_ID, min: 0, max: 1, step: 0.05 }),
  };
}
