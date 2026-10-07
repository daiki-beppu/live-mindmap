import type { Position } from "./layout.ts";

// 見る状態: 自動のカメラに任せているか（auto）、人が動かして止めているか（manual）、全体を見ているか（overview）。
// manual は止めた時点の今の議題を覚える。overview は F を押した時点の今の議題と、F で戻る先（before）を覚える。
type CameraViewing =
  | { mode: "auto" }
  | { mode: "manual"; topic: string | undefined }
  | { mode: "overview"; topic: string | undefined; before: { mode: "auto" } | { mode: "manual"; topic: string | undefined } };

// キー一覧が開いているときだけ keyList: true を持つ（閉じているときはフィールドを置かない）
export type ViewingState = CameraViewing & { keyList?: true };

// キーボードで倍率・位置を変えるキー。Shift なしの矢印は、ノードの選択に空けておく
export type ViewKey = "=" | "-" | "0" | "F" | "Shift+ArrowLeft" | "Shift+ArrowRight" | "Shift+ArrowUp" | "Shift+ArrowDown";

export type ViewingEvent =
  | { type: "userMoved" }
  | { type: "reflect" }
  | { type: "edgeDot"; id: string }
  | { type: "keyList"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "escape"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "key"; key: ViewKey; meta: boolean; ctrl: boolean; alt: boolean }
  // 触らずに 10 秒たった（見返しの manual のときだけ効く）
  | { type: "idle" }
  // 見返しで時刻を動かした（▶・シーク・反映の前後。見返しの manual・overview で効く）
  | { type: "timeMoved" };

// ライブか見返しか。ライブでは時間でも時刻でも自動に戻らない
export type ViewingScope = "live" | "review";

// 見えている木: 見せるノード・目標の位置・今の議題
export type VisibleTree = { ids: string[]; targets: Record<string, Position>; currentTopic: string | undefined };

// follow: 今までどおり自動で寄せる / refocus: 今の議題へ寄せ直す / hold: 動かさない
// zoomBy: 画面の中心を保って倍率を掛ける / zoomTo: 画面の中心を保って倍率にする
// focusNode: 今の倍率のまま、そのノードへ寄る
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
  | { type: "restore" };

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

function withoutKeyList(state: ViewingState): CameraViewing {
  const { keyList: _keyList, ...rest } = state;
  return rest;
}

// キー一覧の開閉はカメラの状態と独立。? と、開いている間の修飾なしの Esc だけが開閉を変える。
// それ以外の出来事は、開閉を外した状態で reduceCamera に渡し、結果に開閉を戻す
export function reduceViewing(
  state: ViewingState,
  event: ViewingEvent,
  tree: VisibleTree,
  scope: ViewingScope = "live",
): { state: ViewingState; camera: CameraCommand } {
  const modified = (e: { meta: boolean; ctrl: boolean; alt: boolean }) => e.meta || e.ctrl || e.alt;
  if (event.type === "keyList") {
    if (modified(event)) return { state, camera: idle(state) };
    return { state: state.keyList ? withoutKeyList(state) : { ...state, keyList: true }, camera: idle(state) };
  }
  if (event.type === "escape" && !modified(event) && state.keyList) return { state: withoutKeyList(state), camera: idle(state) };
  const out = reduceCamera(withoutKeyList(state), event, tree, scope);
  return state.keyList ? { state: { ...out.state, keyList: true }, camera: out.camera } : out;
}

// 純粋な関数。ライブでは時間でも時刻でも自動に戻らない（戻るのは、今の議題が変わる反映と、修飾なしの Esc だけ。全体を見ているときは F でも戻る）。
// 見返し（scope が "review"）では、さらに、止めているとき触らずに 10 秒たつと戻り、止めているか全体を見ているとき時刻を動かすと戻る。
function reduceCamera(
  state: CameraViewing,
  event: Exclude<ViewingEvent, { type: "keyList" }>,
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
