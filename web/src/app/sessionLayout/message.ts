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
  ChangedViewingMode: { mode: Schema.Literals(["auto", "manual", "overview", "diff"]) },
  // Disclosure の onToggle が運ぶ「次に開くか」
  ToggledCaptions: { isOpen: Schema.Boolean },
  GotIntakeToastMessage: { message: Notice.Message },
  GotScreenToastMessage: { message: Notice.Message },
  GotTapToastMessage: { message: Notice.Message },
  GotViewingToastMessage: { message: Notice.Message },
});
export type Message = typeof Message.Type;
