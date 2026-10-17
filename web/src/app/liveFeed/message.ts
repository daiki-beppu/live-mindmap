// ライブの受信（Issue #828）が受ける Message。Subscription が「つながった」「frame を受けた」「切れた」の事実をそのまま届ける。
// 状態の更新の規則は update が持つ（web/src/liveFeed.ts の applyOpen / applyFrame / applyClose）
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { CaptionsFrame, DiffUpdateFrame, IntakeFrame, ScreenNoticeFrame, SelfPauseFrame, SessionModeFrame, Snapshot, SpeakerNamesFrame, TapNoticeFrame } from "../../../../server/src/core/index.ts";

// スナップショットは type を持たない。core の Snapshot は type の不在を制約しておらず、Union の sentinel にもならないので、
// 未知の type や不正な payload の frame が（decode が type を落として）スナップショットとして通ってしまう。受信境界でだけ type キーを拒む
const SnapshotFrame = Schema.Struct({ ...Snapshot.fields, type: Schema.optionalKey(Schema.Never) });

// /ws から届く frame。スナップショットは type を持たず、残りは type で見分ける
export const LiveFrame = Schema.Union([SnapshotFrame, CaptionsFrame, IntakeFrame, ScreenNoticeFrame, TapNoticeFrame, SelfPauseFrame, DiffUpdateFrame, SessionModeFrame, SpeakerNamesFrame]);
export type LiveFrame = typeof LiveFrame.Type;

export const Message = defineMessageUnion({
  ConnectedLiveFeed: {},
  // receivedAt は frame を受けた時刻（ミリ秒）。Subscription が Clock から付ける
  ReceivedLiveFrame: { frame: LiveFrame, receivedAt: Schema.Finite },
  // 字幕の期限（待ちの上限か 3 秒の規則）が来た。at は来た時刻（ミリ秒）
  ReachedCaptionDeadline: { at: Schema.Finite },
  DisconnectedLiveFeed: {},
});
export type Message = typeof Message.Type;
