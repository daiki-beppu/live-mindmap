// 共有画面を使っていないことの一文（screen-off の許可なし。Issue #280）。ブラウザへ送るフレームと文言と寿命。
// Node の実行環境に依存しない（ADR 0003）。タイマーは持たない（寿命は配線側が使う）。

// ブラウザへ送るフレーム。text が null のときは一文を消す。type で他のフレームと見分ける
export type ScreenNoticeFrame = { type: "screen-notice"; text: string | null };

// 許可なしを受けたときに出す一文（実機の確認 #282 の結果に合わせて後で直す）
export const SCREEN_NOTICE_TEXT = "共有画面は使っていません（画面収録の許可がありません。システム設定で、起動したターミナルに許可を与え、ターミナルを開き直す）";

// 届いてから一文を出す長さ（ミリ秒）。その後は消し、後からつないだブラウザにも再び出さない
export const SCREEN_NOTICE_MS = 10_000;
