// セッションの画面（Issue #820）が受ける Message。外（WebSocket のフレーム・見る状態の Model・C のキー）から届く値と、Toast の子の Message
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Captions } from "../../captions.ts";
import { DiffUpdateState, SelfPaused } from "../../../../server/src/core/index.ts";
import { Notice } from "./toast.ts";

export const IntakeStatus = Schema.Literals(["running", "interrupted", "stopped", "none"]);

export const Message = defineMessageUnion({
  ChangedCaptions: { captions: Captions },
  // 字幕を滑らせる Mount の起動を知らせる。Model は変えない
  CompletedSlideCaptions: {},
  ReceivedIntakeStatus: { status: IntakeStatus },
  ReceivedScreenNotice: { text: Schema.Option(Schema.String) },
  ReceivedTapNotice: { text: Schema.Option(Schema.String) },
  ReceivedSelfPause: { selfPaused: SelfPaused },
  ReceivedDiffUpdate: { state: Schema.Option(DiffUpdateState) },
  ReceivedSessionMode: { local: Schema.Boolean },
  // 名前の欄の入力（Issue #1026）。欄を押した（bubbleId は押した吹き出し、label はサーバーに送る話者のラベル）・入力が変わった・確定した・取り消した（Esc・フォーカスが外れた）
  PressedSpeakerName: { bubbleId: Schema.String, label: Schema.String },
  ChangedSpeakerNameDraft: { draft: Schema.String },
  SubmittedSpeakerName: {},
  CancelledSpeakerName: {},
  // 名前の送信が終わった。Model は変えない（名前は /ws の frame でだけ変わる）
  CompletedRequestSpeakerName: {},
  // 名前の入力へのフォーカスが済んだ。Model は変えない
  CompletedFocusSpeakerNameInput: {},
  ChangedViewingMode: { mode: Schema.Literals(["auto", "manual", "overview", "diff"]) },
  // Disclosure の onToggle が運ぶ「次に開くか」
  ToggledCaptions: { isOpen: Schema.Boolean },
  GotIntakeToastMessage: { message: Notice.Message },
  GotScreenToastMessage: { message: Notice.Message },
  GotTapToastMessage: { message: Notice.Message },
  GotViewingToastMessage: { message: Notice.Message },
});
export type Message = typeof Message.Type;
