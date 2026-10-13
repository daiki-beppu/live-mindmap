// 親（会議・見返し）が表示面（MapSurface）を子として組み込む配線のうち、2 つの親で同じものを置く。
// 親ごとに違うのは、表示面を Model のどこから読み、どこへ書き戻し、親の Message に包むか（read・write・toParentMessage）だけ。
// 表示面の OutMessage（ノードが選ばれたこと）は表示面の viewing が持つので、親では受け流す。
// キーは、意味が表示面の見る状態だけで決まるもの（F・=・-・0・Z・Shift+矢印・矢印・Enter・E）の handler をここで作る。親ごとに意味が違うキー（Esc・C・?・再生のキーなど）は親が決める。
import type { Option } from "effect";
import { Update } from "foldkit";
import type { ArrowDir, ViewKey } from "../../viewing.ts";
import * as MapSurface from "./main.ts";
import type { Message as MapSurfaceMessage } from "./message.ts";

export type KeyHandler<Model, Message> = (model: Model, modifiers: MapSurface.KeyModifiers) => Update.Return<Model, Message>;

type SurfaceKeyId =
  | "F" | "=" | "-" | "0" | "Z"
  | "Shift+ArrowLeft" | "Shift+ArrowRight" | "Shift+ArrowUp" | "Shift+ArrowDown"
  | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"
  | "Enter" | "E";

// ⌘・Ctrl・Option と一緒なら何もしない
export const plainKey =
  <Model, Message>(handler: (model: Model) => Update.Return<Model, Message>): KeyHandler<Model, Message> =>
  (model, { metaKey, ctrlKey, altKey }) =>
    !metaKey && !ctrlKey && !altKey ? handler(model) : { model };

const NO_MODIFIERS: MapSurface.KeyModifiers = { metaKey: false, ctrlKey: false, altKey: false };

export const surfaceFolds = <Model, Message>(parent: {
  readonly read: (model: Model) => Option.Option<MapSurface.Model>;
  readonly write: (model: Model, surface: MapSurface.Model) => Model;
  readonly toParentMessage: (message: MapSurfaceMessage) => Message;
}) => {
  const fold = { ...parent, foldOutMessage: () => (model: Model) => ({ model }) };
  const foldViewKey = Update.foldChild({ update: MapSurface.pressViewKey, ...fold });
  const foldArrowKey = Update.foldChild({ update: MapSurface.pressArrowKey, ...fold });
  const foldEnterKey = Update.foldChild({ update: MapSurface.pressEnterKey, ...fold });
  const foldSideKey = Update.foldChild({ update: MapSurface.pressSideKey, ...fold });
  const viewKey = (key: ViewKey): KeyHandler<Model, Message> => (model, modifiers) => foldViewKey(model, { key, ...modifiers });
  const arrowKey = (dir: ArrowDir): KeyHandler<Model, Message> => (model, modifiers) => foldArrowKey(model, { dir, ...modifiers });
  const toggleSide = (model: Model) => foldSideKey(model, NO_MODIFIERS);
  const keyHandlers: Record<SurfaceKeyId, KeyHandler<Model, Message>> = {
    F: viewKey("F"),
    "=": viewKey("="),
    "-": viewKey("-"),
    "0": viewKey("0"),
    Z: viewKey("Z"),
    "Shift+ArrowLeft": viewKey("Shift+ArrowLeft"),
    "Shift+ArrowRight": viewKey("Shift+ArrowRight"),
    "Shift+ArrowUp": viewKey("Shift+ArrowUp"),
    "Shift+ArrowDown": viewKey("Shift+ArrowDown"),
    ArrowLeft: arrowKey("left"),
    ArrowRight: arrowKey("right"),
    ArrowUp: arrowKey("up"),
    ArrowDown: arrowKey("down"),
    Enter: foldEnterKey,
    E: plainKey(toggleSide),
  };
  return {
    foldMapSurface: Update.foldChild({ update: MapSurface.update, ...fold }),
    foldEscapeKey: Update.foldChild({ update: MapSurface.pressEscapeKey, ...fold }),
    toggleSide,
    keyHandlers,
  };
};
