import type { Position } from "./layout.ts";

// 見る状態: 自動のカメラに任せているか（auto）、人が動かして止めているか（manual）、全体を見ているか（overview）。
// manual は止めた時点の今の議題を覚える。overview は F を押した時点の今の議題と、F で戻る先（before）を覚える。
export type ViewingState =
  | { mode: "auto" }
  | { mode: "manual"; topic: string | undefined }
  | { mode: "overview"; topic: string | undefined; before: { mode: "auto" } | { mode: "manual"; topic: string | undefined } };

// キーボードで倍率・位置を変えるキー。Shift なしの矢印は、ノードの選択に空けておく
export type ViewKey = "=" | "-" | "0" | "F" | "Shift+ArrowLeft" | "Shift+ArrowRight" | "Shift+ArrowUp" | "Shift+ArrowDown";

export type ViewingEvent =
  | { type: "userMoved" }
  | { type: "reflect" }
  | { type: "escape"; meta: boolean; ctrl: boolean; alt: boolean }
  | { type: "key"; key: ViewKey; meta: boolean; ctrl: boolean; alt: boolean };

// 見えている木: 見せるノード・目標の位置・今の議題
export type VisibleTree = { ids: string[]; targets: Record<string, Position>; currentTopic: string | undefined };

// follow: 今までどおり自動で寄せる / refocus: 今の議題へ寄せ直す / hold: 動かさない
// zoomBy: 画面の中心を保って倍率を掛ける / zoomTo: 画面の中心を保って倍率にする
// pan: 画面の 1/3 ずつ動かす（dx・dy は見えてくる側の向き） / fitAll: 全体を収める / restore: 全体を見る前の倍率・位置へ戻す
export type CameraCommand =
  | { type: "follow" }
  | { type: "refocus" }
  | { type: "hold" }
  | { type: "zoomBy"; factor: number }
  | { type: "zoomTo"; zoom: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "fitAll" }
  | { type: "restore" };

export const INITIAL_VIEWING: ViewingState = { mode: "auto" };

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

// 純粋な関数。時間では自動に戻らない（戻るのは、今の議題が変わる反映と、修飾なしの Esc だけ。全体を見ているときは F でも戻る）。
export function reduceViewing(state: ViewingState, event: ViewingEvent, tree: VisibleTree): { state: ViewingState; camera: CameraCommand } {
  switch (event.type) {
    case "userMoved":
      return { state: { mode: "manual", topic: tree.currentTopic }, camera: HOLD };
    case "reflect":
      if (state.mode === "auto") return { state: AUTO, camera: FOLLOW };
      if (tree.currentTopic !== state.topic) return { state: AUTO, camera: REFOCUS };
      return { state, camera: state.mode === "overview" ? FIT_ALL : HOLD };
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
