// セッションの画面（Issue #820）が受ける Message。外（WebSocket のフレーム・見る状態の Model・C のキー）から届く値と、Toast の子の Message
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { DiffUpdateState } from "../../../../server/src/core/index.ts";
import { Notice } from "./toast.ts";

export const IntakeStatus = Schema.Literals(["running", "interrupted", "stopped", "none"]);

export const Message = defineMessageUnion({
  ChangedSpeaking: { speaking: Schema.Struct({ 相手: Schema.String, 自分: Schema.String }) },
  ReceivedIntakeStatus: { status: IntakeStatus },
  ReceivedScreenNotice: { text: Schema.Option(Schema.String) },
  ReceivedTapNotice: { text: Schema.Option(Schema.String) },
  ReceivedSelfPause: { paused: Schema.Boolean },
  ReceivedDiffUpdate: { state: Schema.Option(DiffUpdateState) },
  ReceivedSessionMode: { local: Schema.Boolean },
  ChangedViewingMode: { mode: Schema.Literals(["auto", "manual", "overview"]) },
  // Disclosure の onToggle が運ぶ「次に開くか」
  ToggledCaptions: { isOpen: Schema.Boolean },
  GotIntakeToastMessage: { message: Notice.Message },
  GotScreenToastMessage: { message: Notice.Message },
  GotTapToastMessage: { message: Notice.Message },
  GotViewingToastMessage: { message: Notice.Message },
});
export type Message = typeof Message.Type;
