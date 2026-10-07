import type { Position } from "./layout.ts";

// 見る状態: 自動のカメラに任せているか（auto）、人が動かして止めているか（manual）、全体を見ているか（overview）。
// manual は止めた時点の今の議題を覚える。overview は F を押した時点の今の議題と、F で戻る先（before）を覚える。
type CameraViewing =
  | { mode: "auto" }
  | { mode: "manual"; topic: string | undefined }
  | { mode: "overview"; topic: string | undefined; before: { mode: "auto" } | { mode: "manual"; topic: string | undefined } };

// カメラの状態に重ねる、独立した出し入れの状態。開いている・隠しているときだけ true を持つ（そうでなければフィールドを置かない）。
// keyList: キー一覧が開いている / sideHidden: 右の列を隠している / captionsHidden: 字幕を隠している
// selection: 選んだノード（byKey: キーで選んだか）。選んでいないときはフィールドを置かない。Esc でだけ外れる
type Overlay = { keyList?: true; sideHidden?: true; captionsHidden?: true; selection?: { id: string; byKey: boolean } };
const OVERLAY_KEYS = ["keyList", "sideHidden", "captionsHidden"] as const satisfies readonly (keyof Overlay)[];
export type ViewingState = CameraViewing & Overlay;

// キーボードで倍率・位置を変えるキー。Shift なしの矢印は、ノードの選択に空けておく
export type ViewKey = "=" | "-" | "0" | "F" | "Shift+ArrowLeft" | "Shift+ArrowRight" | "Shift+ArrowUp" | "Shift+ArrowDown";

export type ViewingEvent =
  | { type: "userMoved" }
  | { type: "reflect" }
  | { type: "edgeDot"; id: string }
  | { type: "keyList"; meta: boolean; ctrl: boolean; alt: boolean }
  // E（右の列）と C（字幕）。key ではなく keyList と同じ形の別の出来事で、カメラの状態は変えない
  | { type: "side"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "captions"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "escape"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "key"; key: ViewKey; meta: boolean; ctrl: boolean; alt: boolean }
  // ノードをクリックで選んだ（カメラの状態は変えない）
  | { type: "select"; id: string }
  // Shift なしの矢印でノードを選ぶ
  | { type: "arrow"; dir: ArrowDir; meta: boolean; ctrl: boolean; alt: boolean }
  // 触らずに 10 秒たった（見返しの manual のときだけ効く）
  | { type: "idle" }
  // 見返しで時刻を動かした（▶・シーク・反映の前後。見返しの manual・overview で効く）
  | { type: "timeMoved" };

export type ArrowDir = "left" | "right" | "up" | "down";

// ライブか見返しか。ライブでは時間でも時刻でも自動に戻らない
export type ViewingScope = "live" | "review";

// 見えている木: 見せるノード・目標の位置・今の議題
// parents: 見せるノードそれぞれの親（ルートは null）
export type VisibleTree = { ids: string[]; targets: Record<string, Position>; parents: Record<string, string | null>; currentTopic: string | undefined };

// shiftIntoView: 倍率は変えず、今の議題が列で切れる分だけ横にずらす（寄せ直しも収め直しもしない）
// follow: 今までどおり自動で寄せる / refocus: 今の議題へ寄せ直す / hold: 動かさない
// zoomBy: 画面の中心を保って倍率を掛ける / zoomTo: 画面の中心を保って倍率にする
// focusNode: 今の倍率のまま、そのノードへ寄る
// revealNode: 人の倍率の範囲に収めてから、そのノードが画面の外なら最小限ずらして入れる（中なら動かさない）
// pan: 画面の 1/3 ずつ動かす（dx・dy は見えてくる側の向き） / fitAll: 全体を収める / restore: 全体を見る前の倍率・位置へ戻す
export type CameraCommand =
  | { type: "follow" }
  | { type: "refocus" }
  | { type: "hold" }
  | { type: "zoomBy"; factor: number }
  | { type: "zoomTo"; zoom: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "fitAll" }
  | { type: "focusNode"; id: string }
  | { type: "revealNode"; id: string }
  | { type: "restore" }
  | { type: "shiftIntoView" };

export const INITIAL_VIEWING: ViewingState = { mode: "auto" };

// カメラへの指示と、その通し番号。番号が変わるたびに、マップは指示を受け取り直す
export type CameraOrder = { command: CameraCommand; seq: number };

// 次の指示を決める。まだ描画されていない refocus（current.seq が shownSeq と異なる）は、
// 同じ更新内で続く follow で上書きしない（上書きするとマップに refocus が届かない）。それ以外は常に新しい番号の指示にする
export function nextCameraOrder(current: CameraOrder, command: CameraCommand, shownSeq: number): CameraOrder {
  if (command.type === "follow" && current.command.type === "refocus" && current.seq !== shownSeq) return current;
  return { command, seq: current.seq + 1 };
}

const ZOOM_STEP = 1.25;

const AUTO: ViewingState = { mode: "auto" };
const FOLLOW: CameraCommand = { type: "follow" };
const REFOCUS: CameraCommand = { type: "refocus" };
const HOLD: CameraCommand = { type: "hold" };
const FIT_ALL: CameraCommand = { type: "fitAll" };
const SHIFT_INTO_VIEW: CameraCommand = { type: "shiftIntoView" };

function commandOf(key: Exclude<ViewKey, "F">): CameraCommand {
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

// 重ねる状態をすべて外した、カメラの状態だけ
function cameraPart(state: ViewingState): CameraViewing {
  const { keyList: _k, sideHidden: _s, captionsHidden: _c, selection: _sel, ...rest } = state;
  return rest;
}

// camera に、from に存在していた重ねる状態だけを戻す（undefined のフィールドは置かない）
function withOverlayOf(from: ViewingState, camera: CameraViewing): ViewingState {
  const out: ViewingState = { ...camera };
  for (const key of OVERLAY_KEYS) if (from[key]) out[key] = true;
  if (from.selection) out.selection = from.selection;
  return out;
}

// 見せるノードの中で、矢印の移り先を決める。目標の位置で測る。端や行き先が無いときは同じノードのまま。
// 始点が無い・見せるノードに無いときは、向きに動かず今の議題（無ければルート）を選ぶ
function nextSelection(tree: VisibleTree, from: string | undefined, dir: ArrowDir): string | undefined {
  const shown = new Set(tree.ids);
  if (from === undefined || !shown.has(from)) {
    if (tree.currentTopic !== undefined && shown.has(tree.currentTopic)) return tree.currentTopic;
    return tree.ids.find((id) => {
      const parent = tree.parents[id];
      return parent == null || !shown.has(parent);
    });
  }
  const y = (id: string) => tree.targets[id]?.y ?? 0;
  const parentOf = (id: string) => {
    const parent = tree.parents[id];
    return parent != null && shown.has(parent) ? parent : null;
  };
  switch (dir) {
    case "left":
      return parentOf(from) ?? from;
    case "right": {
      let best = from;
      let bestGap = Infinity;
      for (const id of tree.ids) {
        if (parentOf(id) !== from) continue;
        const gap = Math.abs(y(id) - y(from));
        if (gap < bestGap) {
          best = id;
          bestGap = gap;
        }
      }
      return best;
    }
    case "up":
    case "down": {
      const depthOf = (id: string) => {
        let depth = 0;
        for (let p = parentOf(id); p !== null; p = parentOf(p)) depth++;
        return depth;
      };
      const depth = depthOf(from);
      const row = tree.ids.filter((id) => depthOf(id) === depth).sort((a, b) => y(a) - y(b));
      const at = row.indexOf(from);
      return row[dir === "up" ? Math.max(0, at - 1) : Math.min(row.length - 1, at + 1)];
    }
  }
}

// 重ねる状態の出し入れ: 該当するフラグを反転する（隠した状態から戻すときはフィールドごと外す）
function toggled(state: ViewingState, key: "sideHidden" | "captionsHidden"): ViewingState {
  return state[key] ? without(state, key) : { ...state, [key]: true };
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
  const modified = (e: { meta: boolean; ctrl: boolean; alt: boolean }) => e.meta || e.ctrl || e.alt;
  if (event.type === "keyList") {
    if (modified(event)) return { state, camera: idle(state) };
    return { state: state.keyList ? without(state, "keyList") : { ...state, keyList: true }, camera: idle(state) };
  }
  if (event.type === "side") {
    if (modified(event)) return { state, camera: idle(state) };
    return { state: toggled(state, "sideHidden"), camera: SHIFT_INTO_VIEW };
  }
  if (event.type === "captions") {
    if (modified(event)) return { state, camera: idle(state) };
    return { state: toggled(state, "captionsHidden"), camera: idle(state) };
  }
  if (event.type === "escape" && !modified(event) && state.keyList) return { state: without(state, "keyList"), camera: idle(state) };
  if (event.type === "select") return { state: { ...state, selection: { id: event.id, byKey: false } }, camera: idle(state) };
  if (event.type === "arrow") {
    if (modified(event)) return { state, camera: idle(state) };
    const id = nextSelection(tree, state.selection?.id, event.dir);
    if (id === undefined) return { state, camera: idle(state) };
    const moved = withOverlayOf(state, { mode: "manual", topic: tree.currentTopic });
    return { state: { ...moved, selection: { id, byKey: true } }, camera: { type: "revealNode", id } };
  }
  const out = reduceCamera(cameraPart(state), event, tree, scope);
  const next = withOverlayOf(state, out.state);
  // 選択を外すのは、キー一覧が閉じているときの修飾なしの Esc だけ（自動のときも外す）
  return { state: event.type === "escape" && !modified(event) ? without(next, "selection") : next, camera: out.camera };
}

// 純粋な関数。ライブでは時間でも時刻でも自動に戻らない（戻るのは、今の議題が変わる反映と、修飾なしの Esc だけ。全体を見ているときは F でも戻る）。
// 見返し（scope が "review"）では、さらに、止めているとき触らずに 10 秒たつと戻り、止めているか全体を見ているとき時刻を動かすと戻る。
function reduceCamera(
  state: CameraViewing,
  event: Exclude<ViewingEvent, { type: "keyList" | "side" | "captions" | "select" | "arrow" }>,
  tree: VisibleTree,
  scope: ViewingScope,
): { state: CameraViewing; camera: CameraCommand } {
  switch (event.type) {
    case "idle":
      if (scope === "review" && state.mode === "manual") return { state: AUTO, camera: REFOCUS };
      return { state, camera: state.mode === "auto" ? FOLLOW : HOLD };
    case "timeMoved":
      if (scope === "review" && state.mode !== "auto") return { state: AUTO, camera: REFOCUS };
      return { state, camera: state.mode === "auto" ? FOLLOW : HOLD };
    case "userMoved":
      return { state: { mode: "manual", topic: tree.currentTopic }, camera: HOLD };
    case "reflect":
      if (state.mode === "auto") return { state: AUTO, camera: FOLLOW };
      if (tree.currentTopic !== state.topic) return { state: AUTO, camera: REFOCUS };
      return { state, camera: state.mode === "overview" ? FIT_ALL : HOLD };
    case "edgeDot":
      // 点を描いてから押すまでにノードが消えていたら、何もしない
      if (!tree.ids.includes(event.id)) return { state, camera: state.mode === "auto" ? FOLLOW : HOLD };
      return { state: { mode: "manual", topic: tree.currentTopic }, camera: { type: "focusNode", id: event.id } };
    case "escape":
      if (event.meta || event.ctrl || event.alt) return { state, camera: state.mode === "auto" ? FOLLOW : HOLD };
      return state.mode === "auto" ? { state, camera: FOLLOW } : { state: AUTO, camera: REFOCUS };
    case "key": {
      if (event.meta || event.ctrl || event.alt) return { state, camera: state.mode === "auto" ? FOLLOW : HOLD };
      if (event.key !== "F") return { state: { mode: "manual", topic: tree.currentTopic }, camera: commandOf(event.key) };
      if (state.mode !== "overview") return { state: { mode: "overview", topic: tree.currentTopic, before: state }, camera: FIT_ALL };
      return state.before.mode === "auto" ? { state: AUTO, camera: REFOCUS } : { state: state.before, camera: { type: "restore" } };
    }
  }
}
