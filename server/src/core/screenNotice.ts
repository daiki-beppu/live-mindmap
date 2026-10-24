import { Schema } from "effect";

export const ScreenNoticeFrame = Schema.Struct({ type: Schema.Literal("screen-notice"), text: Schema.NullOr(Schema.String) });
export type ScreenNoticeFrame = typeof ScreenNoticeFrame["Type"];

export const SCREEN_NOTICE_TEXT = "共有画面は使っていません（画面収録の許可がありません。システム設定で、起動したターミナルに許可を与え、ターミナルを開き直す）";

export const SCREEN_NOTICE_MS = 10_000;
