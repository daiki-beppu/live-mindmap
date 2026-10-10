import type { DiffUpdateFrame, DiffUpdateState, IntakeFrame, ScreenNoticeFrame, SessionModeFrame, Snapshot, SpeakingFrame, Track } from "../../server/src/core/index.ts";
import type { IntakeStatus } from "./intake.ts";

// /ws から届く frame（Issue #161）の分類と、それによる状態の更新を担う、React を使わない純粋なモジュール。
// useLiveFeed.ts は WebSocket の接続・再接続・購読だけを担う glue で、分類と状態更新はここに置く
// （web のテスト環境に DOM・レンダラが無く、useEffect 内のクロージャには到達できないため。CT-FRAME-DISPATCH）。

export type Speaking = Record<Track, string>;
const NO_SPEAKING: Speaking = { 相手: "", 自分: "" };
// まだ取り込みの状態のフレームを受け取っていない（セッションが無い、または動いている）ときの既定値。
// サーバーは動いている間はフレームを送らないので、この既定値そのものが「動いている」を表す
const DEFAULT_INTAKE: IntakeStatus = "running";

// screenNotice は、共有画面を使っていないことの一文（Issue #280）。出している間だけ文が入る。寿命はサーバーが持つ
export type FeedState = { snapshot: Snapshot | null; speaking: Speaking; intake: IntakeStatus; screenNotice: string | null; diffUpdate: DiffUpdateState | null; local: boolean };

export function createFeedState(): FeedState {
  return { snapshot: null, speaking: NO_SPEAKING, intake: DEFAULT_INTAKE, screenNotice: null, diffUpdate: null, local: false };
}

// 受け取った 1 件の frame で状態を更新する。type を持たないものはスナップショット、"speaking" はトラックごとの
// 「いま話している文字」、"intake" は取り込みの状態（途切れている／止まった／動いている）。
// それ以外の知らない type は無視する（将来の拡張用）。1 種類の frame は、その種類が持つ値だけを変える
// （例えば intake frame はスナップショット・字幕を変えない）。
export function applyFrame(state: FeedState, frame: Snapshot | SpeakingFrame | IntakeFrame | ScreenNoticeFrame | DiffUpdateFrame | SessionModeFrame): FeedState {
  if (!("type" in frame)) return { ...state, snapshot: frame };
  if (frame.type === "speaking") return { ...state, speaking: { ...state.speaking, [frame.track]: frame.text } };
  if (frame.type === "intake") return { ...state, intake: frame.status };
  if (frame.type === "screen-notice") return { ...state, screenNotice: frame.text };
  if (frame.type === "diff-update") return { ...state, diffUpdate: frame.state };
  if (frame.type === "session-mode") return { ...state, local: frame.local };
  return state;
}

// つなぎ直した直後（まだ再接続後の実フレームを 1 件も受け取っていない時点）の状態。
// 字幕だけ空に戻す（切れている間に古いトラックの文字が残っていても、つなぎ直しで仮の文字を捨てる）。
// 取り込みの状態は直前の値（interrupted・stopped 等）をそのまま保つ。サーバーが実際の intake frame を
// 送るまで「動いている」を捏造しない（再接続直後に「再開しました」が誤って出ないようにする。Issue #161 U-A）。
// 共有画面の一文とモード表示は消す。現在値はサーバーからの再送で復元する。
export function applyOpen(state: FeedState): FeedState {
  return { ...state, speaking: NO_SPEAKING, screenNotice: null, local: false };
}

// 接続が閉じた時点の状態。共有画面の一文とモード表示は、終了の通知を受け取れない間に残さない。
// スナップショット・字幕・取り込みの状態は変えない
export function applyClose(state: FeedState): FeedState {
  return { ...state, screenNotice: null, local: false };
}
