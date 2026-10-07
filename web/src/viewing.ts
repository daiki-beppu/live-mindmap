import type { Position } from "./layout.ts";

// 見る状態: 自動のカメラに任せているか、人が動かして止めているか。止めた時点の今の議題を覚える。
export type ViewingState = { mode: "auto" } | { mode: "manual"; topic: string | undefined };

export type ViewingEvent =
  | { type: "userMoved" }
  | { type: "reflect" }
  | { type: "escape"; meta: boolean; ctrl: boolean; alt: boolean };

// 見えている木: 見せるノード・目標の位置・今の議題
export type VisibleTree = { ids: string[]; targets: Record<string, Position>; currentTopic: string | undefined };

// follow: 今までどおり自動で寄せる / refocus: 今の議題へ寄せ直す / hold: 動かさない
export type CameraCommand = "follow" | "refocus" | "hold";

export const INITIAL_VIEWING: ViewingState = { mode: "auto" };

const AUTO: ViewingState = { mode: "auto" };

// 純粋な関数。時間では自動に戻らない（戻るのは、今の議題が変わる反映と、修飾なしの Esc だけ）。
export function reduceViewing(state: ViewingState, event: ViewingEvent, tree: VisibleTree): { state: ViewingState; camera: CameraCommand } {
  switch (event.type) {
    case "userMoved":
      return { state: { mode: "manual", topic: tree.currentTopic }, camera: "hold" };
    case "reflect":
      if (state.mode === "auto") return { state: AUTO, camera: "follow" };
      return tree.currentTopic !== state.topic ? { state: AUTO, camera: "refocus" } : { state, camera: "hold" };
    case "escape":
      if (event.meta || event.ctrl || event.alt) return { state, camera: state.mode === "manual" ? "hold" : "follow" };
      return state.mode === "manual" ? { state: AUTO, camera: "refocus" } : { state, camera: "follow" };
  }
}
