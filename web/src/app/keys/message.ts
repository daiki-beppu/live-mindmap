// 「このキーが押された」の Message。キーの Subscription（subscription.ts）が出し、画面の Message の PressedKey と同じ形。
// 起きた事実（どのキーか、修飾キーが押されていたか）だけを持ち、意味（どの倍率・位置になるか）は各画面の update が決める
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { KeyId } from "./table.ts";

export const pressedKeyFields = { key: KeyId, metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean };

export const Message = defineMessageUnion({ PressedKey: pressedKeyFields });
export type Message = typeof Message.Type;
