import { Schema } from "effect";
import type { Position } from "./layout.ts";

// 見る状態: 自動のカメラに任せているか（auto）、人が動かして止めているか（manual）、全体を見ているか（overview）、最後の反映で変わったところを見ているか（diff）。
// manual・overview・diff は、入った時点の今の議題を覚える。
const AutoCamera = Schema.Struct({ mode: Schema.Literal("auto") });
const ManualCamera = Schema.Struct({ mode: Schema.Literal("manual"), topic: Schema.UndefinedOr(Schema.String) });
const OverviewCamera = Schema.Struct({ mode: Schema.Literal("overview"), topic: Schema.UndefinedOr(Schema.String) });
const DiffCamera = Schema.Struct({ mode: Schema.Literal("diff"), topic: Schema.UndefinedOr(Schema.String) });
type CameraViewing = typeof AutoCamera.Type | typeof ManualCamera.Type | typeof OverviewCamera.Type | typeof DiffCamera.Type;

// カメラの状態に重ねる、独立した出し入れの状態。開いている・隠しているときだけ true を持つ（そうでなければフィールドを置かない）。
// keyList: キー一覧が開いている / sideHidden: 右の列を隠している / captionsHidden: 字幕を隠している
// selection: 選んだノード（byKey: キーで選んだか）。選んでいないときはフィールドを置かない。Esc か、狭い幅のシートの閉じるボタン（deselect）で外れる
// humanOpened・humanFolded: 人が開いた・畳んだ議題・論点（空ならフィールドを置かない。同じ ID が両方に入ることはない）。Esc でだけ全部解け、
// 人が畳んだ議題が今の議題になると、その議題の畳みだけ解ける
// humanUnbundled: 人が「議題 N 件」を解いたときに、そこに入っていた議題の ID（run: の ID は持たない。空ならフィールドを置かない）。Esc でだけ解ける
const overlayFields = {
  keyList: Schema.optionalKey(Schema.mutableKey(Schema.Literal(true))),
  sideHidden: Schema.optionalKey(Schema.mutableKey(Schema.Literal(true))),
  captionsHidden: Schema.optionalKey(Schema.mutableKey(Schema.Literal(true))),
  selection: Schema.optionalKey(Schema.mutableKey(Schema.Struct({ id: Schema.String, byKey: Schema.Boolean }))),
  humanOpened: Schema.optionalKey(Schema.mutableKey(Schema.ReadonlySet(Schema.String))),
  humanFolded: Schema.optionalKey(Schema.mutableKey(Schema.ReadonlySet(Schema.String))),
  humanUnbundled: Schema.optionalKey(Schema.mutableKey(Schema.ReadonlySet(Schema.String))),
};
type Overlay = Schema.Struct.Type<typeof overlayFields>;
export const ViewingState = Schema.Union([
  Schema.Struct({ ...AutoCamera.fields, ...overlayFields }),
  Schema.Struct({ ...ManualCamera.fields, ...overlayFields }),
  Schema.Struct({ ...OverviewCamera.fields, ...overlayFields }),
  Schema.Struct({ ...DiffCamera.fields, ...overlayFields }),
]);
const OVERLAY_KEYS = ["keyList", "sideHidden", "captionsHidden"] as const satisfies readonly (keyof Overlay)[];
const HUMAN_KEYS = ["humanOpened", "humanFolded", "humanUnbundled"] as const satisfies readonly (keyof Overlay)[];

const EMPTY_SET: ReadonlySet<string> = new Set();
// 人が開いた・畳んだ・解いた集合（無ければ空）。畳む見せ方（foldView）に渡す
export function humanSetsOf(state: ViewingState): { opened: ReadonlySet<string>; folded: ReadonlySet<string>; unbundled: ReadonlySet<string> } {
  return { opened: state.humanOpened ?? EMPTY_SET, folded: state.humanFolded ?? EMPTY_SET, unbundled: state.humanUnbundled ?? EMPTY_SET };
}
export type ViewingState = typeof ViewingState.Type;

// キーボードで倍率・位置を変えるキー。Shift なしの矢印は、ノードの選択に空けておく
export type ViewKey = "=" | "-" | "0" | "F" | "Z" | "Shift+ArrowLeft" | "Shift+ArrowRight" | "Shift+ArrowUp" | "Shift+ArrowDown";

export type ViewingEvent =
  | { type: "userMoved" }
  // replaced: 前の見えている木から消えたノード → 選択の移り先（relocations の結果。最初の反映は {}）
  | { type: "reflect"; replaced: Readonly<Record<string, string>> }
  | { type: "edgeDot"; id: string }
  | { type: "keyList"; meta: boolean; ctrl: boolean; alt: boolean }
  // E（右の列）と C（字幕）。key ではなく keyList と同じ形の別の出来事で、カメラの状態は変えない
  | { type: "side"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "captions"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "escape"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "key"; key: ViewKey; meta: boolean; ctrl: boolean; alt: boolean }
  // ノードをクリックで選んだ（カメラの状態は変えない）
  | { type: "select"; id: string }
  // 選びだけを外す（狭い幅の根拠のシートの閉じるボタン）。Esc と違い、人の開閉には触れない
  | { type: "deselect" }
  // Shift なしの矢印でノードを選ぶ
  | { type: "arrow"; dir: ArrowDir; meta: boolean; ctrl: boolean; alt: boolean }
  // Enter: 選んだ議題・論点を開く・畳む
  | { type: "enter"; meta: boolean; ctrl: boolean; alt: boolean }
  // 丸（隠れた数の丸・ホバーで出る小さな丸）を押した: 押したノードを開く・畳む
  | { type: "foldDot"; id: string }
  // 「変わったこと」の項目からノードを指した（マップのクリックの select とは別）。ancestors: 指したノードの祖先（人が畳んでいれば外して見せる）、
  // open: 指したノード自身が畳む条件に当たるか（人が開いた集合に足す）。どちらも畳む見せ方（pointedNode）が求める
  | { type: "pointChange"; id: string; ancestors: readonly string[]; open: boolean }
  // 触らずに 10 秒たった（見返しの manual のときだけ効く）
  | { type: "idle" }
  // 見返しで時刻を動かした（▶・シーク・反映の前後。見返しの manual・overview・diff で効く）
  | { type: "timeMoved" };

export type ArrowDir = "left" | "right" | "up" | "down";

// ライブか見返しか。ライブでは時間でも時刻でも自動に戻らない
export type ViewingScope = "live" | "review";

// 見えている木: 見せるノード・目標の位置・今の議題
// parents: 見せるノードそれぞれの親（ルートは null）
// foldState: 見せる議題・論点（まとめのノードを除く）が畳まれているか開いているか
// runs: 見せるまとめのノード → そこに入っている議題（並び順）
// changed: 最後の反映で変わったノードの寄せ先（畳みで隠れたものは見えている代わりのノード。無ければ空）
export type VisibleTree = {
  ids: string[];
  targets: Record<string, Position>;
  parents: Record<string, string | null>;
  foldState: Record<string, "folded" | "open">;
  runs: Record<string, readonly string[]>;
  changed: readonly string[];
  currentTopic: string | undefined;
};

// 開閉の向き。畳まれているノードは開き（open）、開いているノードは畳む（fold）。今の議題とその祖先、見えていないノード、
// 議題・論点でないノードは null（効かない）。見せるまとめのノードは、解く向き（unbundle）。reducer と丸の表示が同じ判定を使う
export function foldToggle(tree: VisibleTree, id: string): "open" | "fold" | "unbundle" | null {
  if (!tree.ids.includes(id)) return null;
  if (tree.runs[id] !== undefined) return "unbundle";
  const state = tree.foldState[id];
  if (state === undefined) return null;
  if (tree.currentTopic !== undefined) {
    // 今の議題の系列（今の議題とその祖先）には効かない
    for (let cur: string | null | undefined = tree.currentTopic; cur != null; cur = tree.parents[cur]) if (cur === id) return null;
  }
  return state === "folded" ? "open" : "fold";
}

// shiftIntoView: 倍率は変えず、今の議題が列で切れる分だけ横にずらす（寄せ直しも収め直しもしない）
// follow: 今までどおり自動で寄せる / refocus: 今の議題へ寄せ直す / hold: 動かさない
// zoomBy: 画面の中心を保って倍率を掛ける / zoomTo: 画面の中心を保って倍率にする
// keepNode: 倍率は変えず、そのノードが画面上の同じ位置に映り続けるように合わせる（人の開閉の後）
// focusNode: 今の倍率のまま、そのノードへ寄る
// revealNode: 人の倍率の範囲に収めてから、そのノードが画面の外なら最小限ずらして入れる（中なら動かさない）
// fitSubtree: そのノードと、見せるノードのうちその子孫が収まるまで寄る
// pan: 画面の 1/3 ずつ動かす（dx・dy は見えてくる側の向き） / fitAll: 全体を収める / fitChanged: 最後の反映で変わったノード全部が収まるまで寄る
export const CameraCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("follow") }),
  Schema.Struct({ type: Schema.Literal("refocus") }),
  Schema.Struct({ type: Schema.Literal("hold") }),
  Schema.Struct({ type: Schema.Literal("zoomBy"), factor: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("zoomTo"), zoom: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("pan"), dx: Schema.Finite, dy: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("fitAll") }),
  Schema.Struct({ type: Schema.Literal("focusNode"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("keepNode"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("revealNode"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("fitSubtree"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("fitChanged") }),
  Schema.Struct({ type: Schema.Literal("shiftIntoView") }),
]);
export type CameraCommand = typeof CameraCommand.Type;

export const INITIAL_VIEWING: ViewingState = { mode: "auto" };

const ZOOM_STEP = 1.25;

const AUTO: ViewingState = { mode: "auto" };
const FOLLOW: CameraCommand = { type: "follow" };
const REFOCUS: CameraCommand = { type: "refocus" };
const HOLD: CameraCommand = { type: "hold" };
const FIT_ALL: CameraCommand = { type: "fitAll" };
const FIT_CHANGED: CameraCommand = { type: "fitChanged" };
const SHIFT_INTO_VIEW: CameraCommand = { type: "shiftIntoView" };

function commandOf(key: Exclude<ViewKey, "F" | "Z">): CameraCommand {
  switch (key) {
    case "=":
      return { type: "zoomBy", factor: ZOOM_STEP };
    case "-":
      return { type: "zoomBy", factor: 1 / ZOOM_STEP };
    case "0":
      return { type: "zoomTo", zoom: 1 };
    case "Shift+ArrowLeft":
      return { type: "pan", dx: -1, dy: 0 };
    case "Shift+ArrowRight":
      return { type: "pan", dx: 1, dy: 0 };
    case "Shift+ArrowUp":
      return { type: "pan", dx: 0, dy: -1 };
    case "Shift+ArrowDown":
      return { type: "pan", dx: 0, dy: 1 };
  }
}

function idle(state: ViewingState): CameraCommand {
  return state.mode === "auto" ? FOLLOW : HOLD;
}

function without(state: ViewingState, key: (typeof OVERLAY_KEYS)[number] | "selection"): ViewingState {
  const { [key]: _removed, ...rest } = state;
  return rest;
}

// 人が開いた・畳んだ・解いた集合をすべて外す
function withoutHuman(state: ViewingState): ViewingState {
  const { humanOpened: _o, humanFolded: _f, humanUnbundled: _u, ...rest } = state;
  return rest;
}

// 重ねる状態をすべて外した、カメラの状態だけ
function cameraPart(state: ViewingState): CameraViewing {
  const { keyList: _k, sideHidden: _s, captionsHidden: _c, selection: _sel, humanOpened: _o, humanFolded: _f, humanUnbundled: _u, ...rest } = state;
  return rest;
}

// 人が畳んだ集合から id を外す（空になればフィールドごと外す）
function releaseFolded(state: ViewingState, id: string | undefined): ViewingState {
  if (id === undefined || !state.humanFolded?.has(id)) return state;
  const rest = new Set(state.humanFolded);
  rest.delete(id);
  const { humanFolded: _f, ...others } = state;
  return rest.size === 0 ? others : { ...others, humanFolded: rest };
}

// 人が開いた・畳んだ集合に id を入れ、もう一方の集合から外す（空になればフィールドごと外す）
function withHuman(state: ViewingState, id: string, to: "humanOpened" | "humanFolded"): ViewingState {
  const from = to === "humanOpened" ? "humanFolded" : "humanOpened";
  const { [from]: removed, ...others } = state;
  const left = new Set(removed);
  left.delete(id);
  return { ...others, ...(left.size > 0 ? { [from]: left } : {}), [to]: new Set([...(state[to] ?? []), id]) };
}

// camera に、from に存在していた重ねる状態だけを戻す（undefined のフィールドは置かない）
function withOverlayOf(from: ViewingState, camera: CameraViewing): ViewingState {
  const out: ViewingState = { ...camera };
  for (const key of OVERLAY_KEYS) if (from[key]) out[key] = true;
  if (from.selection) out.selection = from.selection;
  for (const key of HUMAN_KEYS) if (from[key]) out[key] = from[key];
  return out;
}

function isDescendant(tree: VisibleTree, id: string, ancestor: string): boolean {
  for (let cur = tree.parents[id]; cur != null; cur = tree.parents[cur]) if (cur === ancestor) return true;
  return false;
}

type Modifiers = { meta: boolean; ctrl: boolean; alt: boolean };

function modified(e: Modifiers): boolean {
  return e.meta || e.ctrl || e.alt;
}

function parentOf(tree: VisibleTree, shown: ReadonlySet<string>, id: string): string | null {
  const parent = tree.parents[id];
  return parent != null && shown.has(parent) ? parent : null;
}

function targetY(tree: VisibleTree, id: string): number {
  return tree.targets[id]?.y ?? 0;
}

function depthOf(tree: VisibleTree, shown: ReadonlySet<string>, id: string): number {
  let depth = 0;
  for (let p = parentOf(tree, shown, id); p !== null; p = parentOf(tree, shown, p)) depth++;
  return depth;
}

function initialSelection(tree: VisibleTree, shown: ReadonlySet<string>): string | undefined {
  if (tree.currentTopic !== undefined && shown.has(tree.currentTopic)) return tree.currentTopic;
  return tree.ids.find((id) => {
    const parent = tree.parents[id];
    return parent == null || !shown.has(parent);
  });
}

// 子のうち y の差が最も小さいもの。差が同じなら最初の子。子が無ければ from のまま
function nearestChild(tree: VisibleTree, shown: ReadonlySet<string>, from: string): string {
  let best = from;
  let bestGap = Infinity;
  for (const id of tree.ids) {
    if (parentOf(tree, shown, id) !== from) continue;
    const gap = Math.abs(targetY(tree, id) - targetY(tree, from));
    if (gap < bestGap) {
      best = id;
      bestGap = gap;
    }
  }
  return best;
}

function rowNeighbor(tree: VisibleTree, shown: ReadonlySet<string>, from: string, dir: "up" | "down"): string | undefined {
  const depth = depthOf(tree, shown, from);
  const row = tree.ids.filter((id) => depthOf(tree, shown, id) === depth).sort((a, b) => targetY(tree, a) - targetY(tree, b));
  const at = row.indexOf(from);
  return row[dir === "up" ? Math.max(0, at - 1) : Math.min(row.length - 1, at + 1)];
}

// 見せるノードの中で、矢印の移り先を決める。目標の位置で測る。端や行き先が無いときは同じノードのまま。
// 始点が無い・見せるノードに無いときは、向きに動かず今の議題（無ければルート）を選ぶ
function nextSelection(tree: VisibleTree, from: string | undefined, dir: ArrowDir): string | undefined {
  const shown = new Set(tree.ids);
  if (from === undefined || !shown.has(from)) return initialSelection(tree, shown);
  switch (dir) {
    case "left":
      return parentOf(tree, shown, from) ?? from;
    case "right":
      return nearestChild(tree, shown, from);
    case "up":
    case "down":
      return rowNeighbor(tree, shown, from, dir);
  }
}

// 重ねる状態の出し入れ: 該当するフラグを反転する（隠した状態から戻すときはフィールドごと外す）
function toggled(state: ViewingState, key: "sideHidden" | "captionsHidden"): ViewingState {
  return state[key] ? without(state, key) : { ...state, [key]: true };
}

type Reduced = { state: ViewingState; camera: CameraCommand };

function reduceOverlay(state: ViewingState, event: Extract<ViewingEvent, { type: "keyList" | "side" | "captions" }>): Reduced {
  if (modified(event)) return { state, camera: idle(state) };
  switch (event.type) {
    case "keyList":
      return { state: state.keyList ? without(state, "keyList") : { ...state, keyList: true }, camera: idle(state) };
    case "side":
      return { state: toggled(state, "sideHidden"), camera: SHIFT_INTO_VIEW };
    case "captions":
      return { state: toggled(state, "captionsHidden"), camera: idle(state) };
  }
}

function reduceArrow(state: ViewingState, event: Extract<ViewingEvent, { type: "arrow" }>, tree: VisibleTree): Reduced {
  if (modified(event)) return { state, camera: idle(state) };
  const id = nextSelection(tree, state.selection?.id, event.dir);
  if (id === undefined) return { state, camera: idle(state) };
  const moved = withOverlayOf(state, { mode: "manual", topic: tree.currentTopic });
  return { state: { ...moved, selection: { id, byKey: true } }, camera: { type: "revealNode", id } };
}

function foldTargetOf(state: ViewingState, event: Extract<ViewingEvent, { type: "enter" | "foldDot" }>): string | undefined {
  if (event.type === "foldDot") return event.id;
  return modified(event) ? undefined : state.selection?.id;
}

// 「議題 N 件」を解く: 入っていた議題の ID を解いた集合に足し（中身は畳んだまま）、選択を最初の議題へ移す
function unbundleRun(state: ViewingState, tree: VisibleTree, id: string, camera: CameraCommand): Reduced {
  const members = tree.runs[id]!;
  return {
    state: { ...state, humanUnbundled: new Set([...(state.humanUnbundled ?? []), ...members]), selection: { id: members[0]!, byKey: state.selection?.byKey ?? false } },
    camera,
  };
}

function toggleHumanFold(state: ViewingState, tree: VisibleTree, id: string, toggle: "open" | "fold", camera: CameraCommand): Reduced {
  const next = withHuman(state, id, toggle === "open" ? "humanOpened" : "humanFolded");
  // 選択が畳むノードの子孫にあるときは、隠れる選択をそのノードへ移す
  const selected = state.selection;
  if (toggle === "fold" && selected !== undefined && selected.id !== id && isDescendant(tree, selected.id, id)) {
    return { state: { ...next, selection: { ...selected, id } }, camera };
  }
  return { state: next, camera };
}

function reduceFoldToggle(state: ViewingState, event: Extract<ViewingEvent, { type: "enter" | "foldDot" }>, tree: VisibleTree): Reduced {
  const id = foldTargetOf(state, event);
  const toggle = id === undefined ? null : foldToggle(tree, id);
  if (id === undefined || toggle === null) return { state, camera: idle(state) };
  // 開閉はカメラのモードを変えない。自動は今の議題へ寄り直し、止めているか全体を見ているときは、そのノードの画面上の位置を保つ
  const camera: CameraCommand = state.mode === "auto" ? REFOCUS : { type: "keepNode", id };
  if (toggle === "unbundle") return unbundleRun(state, tree, id, camera);
  return toggleHumanFold(state, tree, id, toggle, camera);
}

function reducePointChange(state: ViewingState, event: Extract<ViewingEvent, { type: "pointChange" }>, tree: VisibleTree): Reduced {
  // 祖先の人の畳みを外し、畳む条件に当たる指したノードは人が開いた集合に足す。カメラは人の状態になり、そのノードへ寄る
  let next = state;
  for (const a of event.ancestors) next = releaseFolded(next, a);
  if (event.open) next = withHuman(next, event.id, "humanOpened");
  const moved = withOverlayOf(next, { mode: "manual", topic: tree.currentTopic });
  return { state: { ...moved, selection: { id: event.id, byKey: false } }, camera: { type: "focusNode", id: event.id } };
}

function reduceFitSubtree(state: ViewingState, event: Extract<ViewingEvent, { type: "key" }>, tree: VisibleTree): Reduced {
  const id = state.selection?.id;
  if (modified(event) || id === undefined || !tree.ids.includes(id)) return { state, camera: idle(state) };
  const moved = withOverlayOf(state, { mode: "manual", topic: tree.currentTopic });
  return { state: moved, camera: { type: "fitSubtree", id } };
}

// 選んだノードが統合・削除・時刻の戻しで消えたら、選択の id だけを移り先へ替える
function relocateSelection(state: ViewingState, replaced: Readonly<Record<string, string>>): ViewingState {
  const to = state.selection ? replaced[state.selection.id] : undefined;
  return state.selection && to !== undefined ? { ...state, selection: { ...state.selection, id: to } } : state;
}

function reduceViaCamera(state: ViewingState, event: CameraEvent, tree: VisibleTree, scope: ViewingScope): Reduced {
  const out = reduceCamera(cameraPart(state), event, tree, scope);
  const withSets = withOverlayOf(state, out.state);
  // 人が畳んだ議題に変化が当たって今の議題になったら、その議題の人の畳みは解ける
  if (event.type === "reflect") return { state: relocateSelection(releaseFolded(withSets, tree.currentTopic), event.replaced), camera: out.camera };
  // 選択と人の開閉を外すのは、キー一覧が閉じているときの修飾なしの Esc だけ（自動のときも外す）
  if (event.type === "escape" && !modified(event)) return { state: withoutHuman(without(withSets, "selection")), camera: out.camera };
  return { state: withSets, camera: out.camera };
}

// キー一覧の開閉・右の列と字幕の出し入れはカメラの状態と独立。? と、開いている間の修飾なしの Esc がキー一覧を、
// 修飾なしの E・C が列・字幕を変える。それ以外の出来事は、重ねる状態を外した状態で reduceCamera に渡し、結果に元の重ねる状態を戻す。
// E は列の幅だけマップが変わるので、どのモードでも shiftIntoView を出す（follow・refocus・fitAll は出さない）
export function reduceViewing(
  state: ViewingState,
  event: ViewingEvent,
  tree: VisibleTree,
  scope: ViewingScope = "live",
): { state: ViewingState; camera: CameraCommand } {
  switch (event.type) {
    case "keyList":
    case "side":
    case "captions":
      return reduceOverlay(state, event);
    case "select":
      return { state: { ...state, selection: { id: event.id, byKey: false } }, camera: idle(state) };
    case "deselect":
      return { state: without(state, "selection"), camera: idle(state) };
    case "arrow":
      return reduceArrow(state, event, tree);
    case "enter":
    case "foldDot":
      return reduceFoldToggle(state, event, tree);
    case "pointChange":
      return reducePointChange(state, event, tree);
    case "key":
      return event.key === "Z" ? reduceFitSubtree(state, event, tree) : reduceViaCamera(state, { ...event, key: event.key }, tree, scope);
    case "escape":
      if (!modified(event) && state.keyList) return { state: without(state, "keyList"), camera: idle(state) };
      return reduceViaCamera(state, event, tree, scope);
    case "userMoved":
    case "reflect":
    case "edgeDot":
    case "idle":
    case "timeMoved":
      return reduceViaCamera(state, event, tree, scope);
  }
}

// reduceCamera が受ける出来事。Z（選んだノードへ寄る）、Enter・丸（開閉）、「変わったこと」から指す操作は重ねる状態に依るので、reduceViewing が先に処理して渡さない
type CameraEvent =
  | Exclude<ViewingEvent, { type: "keyList" | "side" | "captions" | "select" | "deselect" | "arrow" | "enter" | "foldDot" | "pointChange" | "key" }>
  | { type: "key"; key: Exclude<ViewKey, "Z">; meta: boolean; ctrl: boolean; alt: boolean };

function reduceCameraEdgeDot(state: CameraViewing, event: Extract<CameraEvent, { type: "edgeDot" }>, tree: VisibleTree): { state: CameraViewing; camera: CameraCommand } {
  // 点を描いてから押すまでにノードが消えていたら、何もしない
  if (!tree.ids.includes(event.id)) return { state, camera: idle(state) };
  return { state: { mode: "manual", topic: tree.currentTopic }, camera: { type: "focusNode", id: event.id } };
}

function reduceCameraReflect(state: CameraViewing, tree: VisibleTree): { state: CameraViewing; camera: CameraCommand } {
  if (state.mode === "auto") return { state: AUTO, camera: FOLLOW };
  if (tree.currentTopic !== state.topic) return { state: AUTO, camera: REFOCUS };
  if (state.mode === "overview") return { state, camera: FIT_ALL };
  return { state, camera: state.mode === "diff" && tree.changed.length > 0 ? FIT_CHANGED : HOLD };
}

// F: 全体を見る。全体を見ているときにもう一度押すと、最後の反映で変わったところを見る（変わったノードが無ければ自動に戻る）。差分を見ているときは全体を見る
function toggleOverview(state: CameraViewing, tree: VisibleTree): { state: CameraViewing; camera: CameraCommand } {
  if (state.mode !== "overview") return { state: { mode: "overview", topic: tree.currentTopic }, camera: FIT_ALL };
  if (tree.changed.length === 0) return { state: AUTO, camera: REFOCUS };
  return { state: { mode: "diff", topic: tree.currentTopic }, camera: FIT_CHANGED };
}

function reduceCameraKey(state: CameraViewing, event: Extract<CameraEvent, { type: "key" }>, tree: VisibleTree): { state: CameraViewing; camera: CameraCommand } {
  if (modified(event)) return { state, camera: idle(state) };
  if (event.key !== "F") return { state: { mode: "manual", topic: tree.currentTopic }, camera: commandOf(event.key) };
  return toggleOverview(state, tree);
}

// 純粋な関数。ライブでは時間でも時刻でも自動に戻らない（戻るのは、今の議題が変わる反映と、修飾なしの Esc だけ。全体を見ているときに変わったノードが無ければ F でも戻る）。
// 見返し（scope が "review"）では、さらに、止めているとき触らずに 10 秒たつと戻り、止めているか全体・差分を見ているとき時刻を動かすと戻る。
function reduceCamera(
  state: CameraViewing,
  event: CameraEvent,
  tree: VisibleTree,
  scope: ViewingScope,
): { state: CameraViewing; camera: CameraCommand } {
  switch (event.type) {
    case "idle":
      if (scope === "review" && state.mode === "manual") return { state: AUTO, camera: REFOCUS };
      return { state, camera: idle(state) };
    case "timeMoved":
      if (scope === "review" && state.mode !== "auto") return { state: AUTO, camera: REFOCUS };
      return { state, camera: idle(state) };
    case "userMoved":
      return { state: { mode: "manual", topic: tree.currentTopic }, camera: HOLD };
    case "reflect":
      return reduceCameraReflect(state, tree);
    case "edgeDot":
      return reduceCameraEdgeDot(state, event, tree);
    case "escape":
      if (modified(event)) return { state, camera: idle(state) };
      return state.mode === "auto" ? { state, camera: FOLLOW } : { state: AUTO, camera: REFOCUS };
    case "key":
      return reduceCameraKey(state, event, tree);
  }
}
