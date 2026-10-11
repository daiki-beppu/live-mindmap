// 相手の音声が届いていないことの一文（helper の tap-silent。Issue #863）。ブラウザへ送るフレームと文言。
// Node の実行環境に依存しない（ADR 0003）。タイマーは持たない（消すのは新しい origin かセッションの終わり）。
import { Schema } from "effect";

// ブラウザへ送るフレーム。text が null のときは一文を消す。type で他のフレームと見分ける
export const TapNoticeFrame = Schema.Struct({ type: Schema.Literal("tap-notice"), text: Schema.NullOr(Schema.String) });
export type TapNoticeFrame = typeof TapNoticeFrame["Type"];

// tap-silent を受けたときに出す一文（実機の再現の結果に合わせて後で直す）
export const TAP_NOTICE_TEXT = "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります。cli stop の後、cli start で始め直してください）";
