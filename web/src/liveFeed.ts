import type { CaptionsFrame, DiffUpdateFrame, DiffUpdateState, IntakeFrame, ScreenNoticeFrame, SelfPauseFrame, SelfPaused, SessionModeFrame, Snapshot, SpeakerNames, SpeakerNamesFrame, TapNoticeFrame } from "../../server/src/core/index.ts";
import { advanceCaptions, createCaptionState, receiveCaptions, type CaptionState } from "./captions.ts";
import type { IntakeStatus } from "./intake.ts";

// /ws から届く frame（Issue #161）の分類と、それによる状態の更新を担う、純粋なモジュール。
// WebSocket の接続・再接続・購読は app/liveFeed/subscription.ts が担い、分類と状態更新はここに置く
// （web のテスト環境に DOM・レンダラが無く、useEffect 内のクロージャには到達できないため。CT-FRAME-DISPATCH）。

// まだ取り込みの状態のフレームを受け取っていない（セッションが無い、または動いている）ときの既定値。
// サーバーは動いている間はフレームを送らないので、この既定値そのものが「動いている」を表す
const DEFAULT_INTAKE: IntakeStatus = "running";

// tapNotice は、相手の音声が届いていないことの一文（Issue #863）。サーバーが新しい origin かセッションの終わりで消すフレームを送るまで入る
// selfPaused は、自分を休止中であること（Issue #1069）と、その理由（Issue #1071。休止中は手動か自動、休止していなければ false）。サーバーが休止の間だけ保持して送り直し、再開かセッションの終わりで false を送る
// speakerNames は、話者の名前の表（ラベル → 名前。Issue #1026）。サーバーの speaker-names フレームの全体で置き換える。字幕とノードの表示名は、ここから毎回導く
// screenNotice は、共有画面を使っていないことの一文（Issue #280）。出している間だけ文が入る。寿命はサーバーが持つ
export type FeedState = { snapshot: Snapshot | null; captions: CaptionState; intake: IntakeStatus; screenNotice: string | null; tapNotice: string | null; diffUpdate: DiffUpdateState | null; selfPaused: SelfPaused; local: boolean; speakerNames: SpeakerNames };

export function createFeedState(): FeedState {
  return { snapshot: null, captions: createCaptionState(), intake: DEFAULT_INTAKE, screenNotice: null, tapNotice: null, diffUpdate: null, selfPaused: false, local: false, speakerNames: {} };
}

// 受け取った 1 件の frame で状態を更新する。type を持たないものはスナップショット、"captions" は話者つきの吹き出しの並び
// （now は frame を受けた時刻（ミリ秒）。待ちの上限と 3 秒の規則はこの時刻から数える）、"intake" は取り込みの状態（途切れている／止まった／動いている）。
// それ以外の知らない type は無視する（将来の拡張用）。1 種類の frame は、その種類が持つ値だけを変える
// （例えば intake frame はスナップショット・字幕を変えない）。
export function applyFrame(state: FeedState, frame: Snapshot | CaptionsFrame | IntakeFrame | ScreenNoticeFrame | TapNoticeFrame | SelfPauseFrame | DiffUpdateFrame | SessionModeFrame | SpeakerNamesFrame, now: number): FeedState {
  if (!("type" in frame)) return { ...state, snapshot: frame };
  if (frame.type === "captions") return { ...state, captions: receiveCaptions(state.captions, frame.bubbles, now) };
  if (frame.type === "intake") return { ...state, intake: frame.status };
  if (frame.type === "screen-notice") return { ...state, screenNotice: frame.text };
  if (frame.type === "tap-notice") return { ...state, tapNotice: frame.text };
  if (frame.type === "self-pause") return { ...state, selfPaused: frame.paused ? frame.reason : false };
  if (frame.type === "diff-update") return { ...state, diffUpdate: frame.state };
  if (frame.type === "session-mode") return { ...state, local: frame.local };
  if (frame.type === "speaker-names") return { ...state, speakerNames: Object.fromEntries(frame.names.map(({ label, name }) => [label, name])) };
  return state;
}

// 字幕の期限（待ちの上限か 3 秒の規則）が来た。時刻 at（ミリ秒）で、出すと決められる文字を決める
export function applyCaptionDeadline(state: FeedState, at: number): FeedState {
  return { ...state, captions: advanceCaptions(state.captions, at) };
}

// つなぎ直した直後（まだ再接続後の実フレームを 1 件も受け取っていない時点）の状態。
// 字幕だけ空に戻す（切れている間に古いトラックの文字が残っていても、つなぎ直しで仮の文字を捨てる）。
// 取り込みの状態は直前の値（interrupted・stopped 等）をそのまま保つ。サーバーが実際の intake frame を
// 送るまで「動いている」を捏造しない（再接続直後に「再開しました」が誤って出ないようにする。Issue #161 U-A）。
// 共有画面の一文・休止の一言とモード表示、話者の名前の表は消す。現在値はサーバーからの再送で復元する。
export function applyOpen(state: FeedState): FeedState {
  return { ...state, captions: createCaptionState(), screenNotice: null, tapNotice: null, selfPaused: false, local: false, speakerNames: {} };
}

// 接続が閉じた時点の状態。共有画面の一文・休止の一言とモード表示は、終了の通知を受け取れない間に残さない。
// スナップショット・字幕・取り込みの状態は変えない
export function applyClose(state: FeedState): FeedState {
  return { ...state, screenNotice: null, tapNotice: null, selfPaused: false, local: false };
}
