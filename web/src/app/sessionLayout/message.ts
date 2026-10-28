import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Captions } from "../../captions.ts";
import { DiffUpdateState, SelfPaused } from "../../../../server/src/core/index.ts";
import { Notice } from "./toast.ts";

export const IntakeStatus = Schema.Literals(["running", "interrupted", "stopped", "none"]);

export const Message = defineMessageUnion({
  ChangedCaptions: { captions: Captions },
  CompletedSlideCaptions: {},
  ReceivedIntakeStatus: { status: IntakeStatus },
  ReceivedScreenNotice: { text: Schema.Option(Schema.String) },
  ReceivedDiscussionNotice: { text: Schema.Option(Schema.String) },
  ReceivedTapNotice: { text: Schema.Option(Schema.String) },
  ReceivedSelfPause: { selfPaused: SelfPaused },
  ReceivedDiffUpdate: { state: Schema.Option(DiffUpdateState) },
  ReceivedSessionMode: { local: Schema.Boolean },
  PressedSpeakerName: { bubbleId: Schema.String, label: Schema.String },
  ChangedSpeakerNameDraft: { draft: Schema.String },
  SubmittedSpeakerName: {},
  CancelledSpeakerName: {},
  CompletedRequestSpeakerName: {},
  CompletedFocusSpeakerNameInput: {},
  ChangedViewingMode: { mode: Schema.Literals(["auto", "manual", "overview", "diff"]) },
  ToggledCaptions: { isOpen: Schema.Boolean },
  GotIntakeToastMessage: { message: Notice.Message },
  GotScreenToastMessage: { message: Notice.Message },
  GotDiscussionToastMessage: { message: Notice.Message },
  GotTapToastMessage: { message: Notice.Message },
  GotViewingToastMessage: { message: Notice.Message },
});
export type Message = typeof Message.Type;
