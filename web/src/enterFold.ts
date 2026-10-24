export const MAP_NODE_BUTTON_CLASS = "map-node__button";

export const FOLD_DOT_CLASSES = ["map-node__count--pressable", "map-node__fold-dot"] as const;

export type Focused = { closest(selector: string): unknown } | null;

export function enterFoldsSelection(focused: Focused, hasSelection: boolean): boolean {
  if (focused === null) return true;
  if (focused.closest(`.${MAP_NODE_BUTTON_CLASS}`)) return hasSelection;
  if (focused.closest("button, a[href]")) return false;
  return true;
}
