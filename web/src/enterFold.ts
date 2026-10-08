// ノード本体のボタンの class 名。MapNode が付け、Enter の判定が参照する
export const MAP_NODE_BUTTON_CLASS = "map-node__button";

// 押せる丸（隠れた数の丸・畳む丸）の class 名。MapNode が付け、見返しの Space の判定が参照する
export const FOLD_DOT_CLASSES = ["map-node__count--pressable", "map-node__fold-dot"] as const;

export type Focused = { closest(selector: string): unknown } | null;

// Enter を「選んだノードの開閉」に使うか。
// - ノード本体のボタンの中: 選択があるときだけ（選択が無ければ、ボタンの click で選ぶ）
// - それ以外のボタン・リンクの中: 使わない（そのボタンを従来どおり押せるようにする）
// - それ以外（フォーカスなしを含む）: 使う
export function enterFoldsSelection(focused: Focused, hasSelection: boolean): boolean {
  if (focused === null) return true;
  if (focused.closest(`.${MAP_NODE_BUTTON_CLASS}`)) return hasSelection;
  if (focused.closest("button, a[href]")) return false;
  return true;
}
