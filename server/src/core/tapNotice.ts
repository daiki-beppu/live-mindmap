import { Schema } from "effect";

export const TapNoticeFrame = Schema.Struct({ type: Schema.Literal("tap-notice"), text: Schema.NullOr(Schema.String) });
export type TapNoticeFrame = typeof TapNoticeFrame["Type"];

export const TAP_NOTICE_TEXT = "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります。cli stop の後、cli start で始め直してください）";
