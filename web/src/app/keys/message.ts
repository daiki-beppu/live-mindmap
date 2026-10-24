import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { KeyId } from "./table.ts";

export const pressedKeyFields = { key: KeyId, metaKey: Schema.Boolean, ctrlKey: Schema.Boolean, altKey: Schema.Boolean };

export const Message = defineMessageUnion({ PressedKey: pressedKeyFields });
export type Message = typeof Message.Type;
