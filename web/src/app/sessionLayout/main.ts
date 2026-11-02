import { Option, Schema } from "effect";
import { Disclosure } from "@foldkit/ui";
import { Submodel, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { DiffUpdateState, SelfPaused } from "../../../../server/src/core/index.ts";
import { CAPTION_BUBBLE_WIDTH, Captions, DisplayBubble, NO_CAPTIONS } from "../../captions.ts";
import { intakeNoticeText, RESUMED_NOTICE_MS } from "../../intake.ts";
import { FocusSpeakerNameInput, RequestSpeakerName } from "./command.ts";
import { IntakeStatus, Message } from "./message.ts";
import { CAPTION_ID_KEY, SlideCaptions } from "./mount.ts";
import { NAME_INPUT_ID, SPEAKER_NAME_COLORS, speakerNameCell } from "./speakerName.ts";
import { Notice, shownText, type NoticeModel } from "./toast.ts";

const NameEdit = Schema.Struct({ bubble: DisplayBubble, label: Schema.String, draft: Schema.String });
type NameEdit = typeof NameEdit.Type;

export const Model = Schema.Struct({
  captions: Captions,
  captionsHidden: Schema.Boolean,
  intake: Schema.Option(IntakeStatus),
  intakeToast: Notice.Model,
  screenToast: Notice.Model,
  tapToast: Notice.Model,
  discussionToast: Notice.Model,
  viewingToast: Notice.Model,
  diffUpdate: Schema.Option(DiffUpdateState),
  selfPaused: SelfPaused,
  local: Schema.Boolean,
  nameEdit: Schema.Option(NameEdit),
});
export type Model = typeof Model.Type;

export const init = (): Model => ({
  captions: NO_CAPTIONS,
  captionsHidden: false,
  intake: Option.none(),
  intakeToast: Notice.init({ id: "intake-notice" }),
  screenToast: Notice.init({ id: "screen-notice" }),
  tapToast: Notice.init({ id: "tap-notice" }),
  discussionToast: Notice.init({ id: "discussion-notice" }),
  viewingToast: Notice.init({ id: "viewing-notice" }),
  diffUpdate: Option.none(),
  selfPaused: false,
  local: false,
  nameEdit: Option.none(),
});

type Return = Update.Return<Model, Message>;
type NoticeReturn = ReturnType<typeof Notice.dismissAll>;
type NoticeAction = (toast: NoticeModel) => NoticeReturn;

const ignoreOutMessage = () => (model: Model) => ({ model });

const foldIntakeToast = Update.foldChild({
  update: (toast: NoticeModel, action: NoticeAction) => action(toast),
  read: (model: Model) => Option.some(model.intakeToast),
  write: (model, intakeToast) => modifyFields(model, { intakeToast: () => intakeToast }),
  toParentMessage: (message) => Message.GotIntakeToastMessage({ message }),
  foldOutMessage: ignoreOutMessage,
});
const foldScreenToast = Update.foldChild({
  update: (toast: NoticeModel, action: NoticeAction) => action(toast),
  read: (model: Model) => Option.some(model.screenToast),
  write: (model, screenToast) => modifyFields(model, { screenToast: () => screenToast }),
  toParentMessage: (message) => Message.GotScreenToastMessage({ message }),
  foldOutMessage: ignoreOutMessage,
});
const foldTapToast = Update.foldChild({
  update: (toast: NoticeModel, action: NoticeAction) => action(toast),
  read: (model: Model) => Option.some(model.tapToast),
  write: (model, tapToast) => modifyFields(model, { tapToast: () => tapToast }),
  toParentMessage: (message) => Message.GotTapToastMessage({ message }),
  foldOutMessage: ignoreOutMessage,
});
const foldDiscussionToast = Update.foldChild({
  update: (toast: NoticeModel, action: NoticeAction) => action(toast),
  read: (model: Model) => Option.some(model.discussionToast),
  write: (model, discussionToast) => modifyFields(model, { discussionToast: () => discussionToast }),
  toParentMessage: (message) => Message.GotDiscussionToastMessage({ message }),
  foldOutMessage: ignoreOutMessage,
});
const foldViewingToast = Update.foldChild({
  update: (toast: NoticeModel, action: NoticeAction) => action(toast),
  read: (model: Model) => Option.some(model.viewingToast),
  write: (model, viewingToast) => modifyFields(model, { viewingToast: () => viewingToast }),
  toParentMessage: (message) => Message.GotViewingToastMessage({ message }),
  foldOutMessage: ignoreOutMessage,
});

type ToastFold = Update.Fold<Model, Message, NoticeAction>;
type ShowOptions = { readonly duration: number } | { readonly sticky: true };
const hideAll: NoticeAction = (toast) => Notice.dismissAll(toast);
const show = (text: string, options: ShowOptions): NoticeAction => (toast) => Notice.show(toast, { payload: { text }, ...options });

const swapNotice =
  (fold: ToastFold, text: string, options: ShowOptions): Update.Step<Model, Message> =>
  Update.combine([fold(hideAll), fold(show(text, options))]);

const noticeOf = (
  model: Model,
  fold: ToastFold,
  shown: Option.Option<string>,
  next: Option.Option<string>,
  options: ShowOptions,
): Return =>
  Option.match(next, {
    onNone: () => fold(model, hideAll),
    onSome: (text) => (Option.contains(shown, text) ? { model } : swapNotice(fold, text, options)(model)),
  });

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ChangedCaptions: ({ captions }) => ({ model: modifyFields(model, { captions: () => captions }) }),
    CompletedSlideCaptions: () => ({ model }),
    ToggledCaptions: ({ isOpen }) => ({ model: modifyFields(model, { captionsHidden: () => !isOpen }) }),
    ReceivedSelfPause: ({ selfPaused }) => ({ model: modifyFields(model, { selfPaused: () => selfPaused }) }),
    ReceivedDiffUpdate: ({ state }) => ({ model: modifyFields(model, { diffUpdate: () => state }) }),
    ReceivedSessionMode: ({ local }) => ({ model: modifyFields(model, { local: () => local }) }),
    ReceivedIntakeStatus: ({ status }) => {
      if (Option.contains(model.intake, status)) return { model };
      const text = intakeNoticeText({ previous: Option.getOrNull(model.intake), current: status, msSinceChange: 0 });
      const next = modifyFields(model, { intake: () => Option.some(status) });
      return noticeOf(next, foldIntakeToast, Option.none(), Option.fromNullishOr(text), status === "running" ? { duration: RESUMED_NOTICE_MS } : { sticky: true });
    },
    ReceivedScreenNotice: ({ text }) => noticeOf(model, foldScreenToast, shownText(model.screenToast), text, { sticky: true }),
    ReceivedDiscussionNotice: ({ text }) => noticeOf(model, foldDiscussionToast, shownText(model.discussionToast), text, { sticky: true }),
    ReceivedTapNotice: ({ text }) => noticeOf(model, foldTapToast, shownText(model.tapToast), text, { sticky: true }),
    PressedSpeakerName: ({ bubbleId, label }) => {
      const bubble = model.captions.bubbles.find((b) => b.id === bubbleId);
      return bubble === undefined
        ? { model }
        : { model: modifyFields(model, { nameEdit: () => Option.some({ bubble, label, draft: "" }) }), commands: [FocusSpeakerNameInput({ id: NAME_INPUT_ID })] };
    },
    ChangedSpeakerNameDraft: ({ draft }) => ({ model: modifyFields(model, { nameEdit: Option.map((edit: NameEdit) => ({ ...edit, draft })) }) }),
    SubmittedSpeakerName: () =>
      Option.match(model.nameEdit, {
        onNone: () => ({ model }),
        onSome: ({ label, draft }) => {
          const closed = modifyFields(model, { nameEdit: () => Option.none() });
          return draft.trim() === "" ? { model: closed } : { model: closed, commands: [RequestSpeakerName({ label, name: draft })] };
        },
      }),
    CancelledSpeakerName: () => ({ model: modifyFields(model, { nameEdit: () => Option.none() }) }),
    CompletedRequestSpeakerName: () => ({ model }),
    CompletedFocusSpeakerNameInput: () => ({ model }),
    ChangedViewingMode: ({ mode }) =>
      noticeOf(model, foldViewingToast, shownText(model.viewingToast), viewingText(mode), { sticky: true }),
    GotIntakeToastMessage: ({ message }) => foldIntakeToast(model, (toast) => Notice.update(toast, message)),
    GotScreenToastMessage: ({ message }) => foldScreenToast(model, (toast) => Notice.update(toast, message)),
    GotDiscussionToastMessage: ({ message }) => foldDiscussionToast(model, (toast) => Notice.update(toast, message)),
    GotTapToastMessage: ({ message }) => foldTapToast(model, (toast) => Notice.update(toast, message)),
    GotViewingToastMessage: ({ message }) => foldViewingToast(model, (toast) => Notice.update(toast, message)),
  });

export const receiveIntakeStatus = (model: Model, status: typeof IntakeStatus.Type): Return => update(model, Message.ReceivedIntakeStatus({ status }));
export const receiveScreenNotice = (model: Model, text: Option.Option<string>): Return => update(model, Message.ReceivedScreenNotice({ text }));
export const receiveDiscussionNotice = (model: Model, text: Option.Option<string>): Return => update(model, Message.ReceivedDiscussionNotice({ text }));
export const receiveTapNotice = (model: Model, text: Option.Option<string>): Return => update(model, Message.ReceivedTapNotice({ text }));
export const receiveSelfPause = (model: Model, selfPaused: SelfPaused): Return => update(model, Message.ReceivedSelfPause({ selfPaused }));
export const receiveDiffUpdate = (model: Model, state: Model["diffUpdate"]): Return => update(model, Message.ReceivedDiffUpdate({ state }));
export const receiveSessionMode = (model: Model, local: boolean): Return => update(model, Message.ReceivedSessionMode({ local }));

export const changeViewingMode = (model: Model, mode: "auto" | "manual" | "overview" | "diff"): Return => update(model, Message.ChangedViewingMode({ mode }));

export const sessionLayoutFolds = <ParentModel, ParentMessage>(parent: {
  readonly read: (model: ParentModel) => Option.Option<Model>;
  readonly write: (model: ParentModel, layout: Model) => ParentModel;
  readonly toParentMessage: (message: Message) => ParentMessage;
}) => {
  const fold = { ...parent, foldOutMessage: () => (model: ParentModel) => ({ model }) };
  return {
    foldSessionLayout: Update.foldChild({ update, ...fold }),
    foldViewingMode: Update.foldChild({ update: changeViewingMode, ...fold }),
    foldIntake: Update.foldChild({ update: receiveIntakeStatus, ...fold }),
    foldScreenNotice: Update.foldChild({ update: receiveScreenNotice, ...fold }),
    foldDiscussionNotice: Update.foldChild({ update: receiveDiscussionNotice, ...fold }),
    foldTapNotice: Update.foldChild({ update: receiveTapNotice, ...fold }),
    foldSelfPause: Update.foldChild({ update: receiveSelfPause, ...fold }),
    foldDiffUpdate: Update.foldChild({ update: receiveDiffUpdate, ...fold }),
    foldSessionMode: Update.foldChild({ update: receiveSessionMode, ...fold }),
  };
};

const MANUAL_TEXT = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
const OVERVIEW_TEXT = "全体を見ています・F で変わったところへ・Esc で戻る・? でキー一覧";
const DIFF_TEXT = "変わったところを見ています・Esc で戻る・? でキー一覧";
const viewingText = (mode: "auto" | "manual" | "overview" | "diff"): Option.Option<string> =>
  mode === "manual" ? Option.some(MANUAL_TEXT) : mode === "overview" ? Option.some(OVERVIEW_TEXT) : mode === "diff" ? Option.some(DIFF_TEXT) : Option.none();

type H = HtmlBuilder<Message>;
type Slots = { readonly map: Html; readonly keyList?: Html | null; readonly side: Html | null };

const noticeView = (h: H, className: string, toast: NoticeModel): Html | null =>
  Option.match(shownText(toast), { onNone: () => null, onSome: (text) => h.div([h.Class(className), h.AriaLive("polite")], [text]) });

const bubbleTextView = (h: H, bubble: DisplayBubble): ReadonlyArray<Html | string> => {
  const settled = bubble.text.slice(0, bubble.settledLength);
  const pending = bubble.text.slice(bubble.settledLength);
  return pending === ""
    ? [settled]
    : [settled, h.span([h.Class("captions__pending")], [pending, h.span([h.Class("captions__cursor")], [])])];
};

const bubbleRowView = (h: H, bubble: DisplayBubble, nameEdit: Model["nameEdit"]): Html =>
  h.keyed("div")(
    bubble.id,
    [
      h.Class(`captions__row ${bubble.side === "right" ? "captions__row--right" : ""}`),
      h.DataAttribute(CAPTION_ID_KEY, bubble.id),
    ],
    [
      speakerNameCell(h, bubble, nameEdit),
      h.p(
        [h.Class(`captions__bubble ${bubble.side === "right" ? "captions__bubble--right" : ""}`), h.Style({ "--speaker-name-color": SPEAKER_NAME_COLORS[bubble.colorIndex] ?? SPEAKER_NAME_COLORS[0] })],
        bubbleTextView(h, bubble),
      ),
    ],
  );

// 描く吹き出しの行。入力中の欄が字幕から外れても、押した時点の行を先頭に足して入力を残す（先頭に置くと、keyed の差分で行が動かず input とフォーカスが保たれる）
function bubbleRowsOf(model: Model): ReadonlyArray<DisplayBubble> {
  const { bubbles } = model.captions;
  return Option.match(model.nameEdit, {
    onNone: () => bubbles,
    onSome: ({ bubble }) => (bubbles.some((b) => b.id === bubble.id) ? bubbles : [bubble, ...bubbles]),
  });
}

function captionsView(h: H, model: Model): Html | null {
  const bubbles = bubbleRowsOf(model);
  if (bubbles.length === 0) return null;
  return Disclosure.view(
    {
      id: "captions",
      isOpen: !model.captionsHidden,
      onToggle: (isOpen) => Message.ToggledCaptions({ isOpen }),
      toView: ({ panel }) =>
        model.captionsHidden
          ? null
          : h.div(
              [
                h.Class("captions"),
                h.AriaLive("polite"),
                h.Style({ "--caption-bubble-ratio": String(CAPTION_BUBBLE_WIDTH) }),
                h.OnMount(SlideCaptions()),
                ...panel,
              ],
              bubbles.map((bubble) => bubbleRowView(h, bubble, model.nameEdit)),
            ),
    },
    h,
  );
}

function localModeViews(h: H, model: Model): ReadonlyArray<Html> {
  if (!model.local) return [];
  const status = Option.map(model.diffUpdate, (state) => state.status);
  const suffix = Option.match(status, {
    onNone: () => "",
    onSome: (s) => (s === "restarting" ? "・マップの更新を再開しています" : s === "stopped" ? "・マップの更新が止まっています" : ""),
  });
  const data = Option.match(status, { onNone: () => [], onSome: (s) => [h.DataAttribute("status", s)] });
  return [
    h.div([h.Class("local-mode-line"), ...data, h.AriaHidden(true)], []),
    h.div([h.Class("local-mode-notice"), ...data, h.Role("status")], [`ローカルモード・Apple Intelligence${suffix}`]),
  ];
}

const SELF_PAUSE_TEXT = { 手動: "自分を休止中（M で再開）", 自動: "自分を休止中（会議アプリがマイクを使っていない）" } as const;
const selfPauseView = (h: H, model: Model): Html | null =>
  model.selfPaused ? h.div([h.Class("self-pause-notice"), h.AriaLive("polite")], [SELF_PAUSE_TEXT[model.selfPaused]]) : null;

const diffUpdateView = (h: H, model: Model): Html | null =>
  Option.match(model.diffUpdate, {
    onNone: () => null,
    onSome: (state) =>
      state.status === "paused"
        ? h.div([h.Class("diff-update-notice"), h.Role("status")], [`マップの更新が止まっています（${state.reason}）`])
        : null,
  });

export const view = (model: Model, h: H, slots: Slots): Html =>
  h.div(
    [h.Class(model.local ? "layout layout--local" : "layout")],
    [
      ...localModeViews(h, model),
      h.div([h.Class("map")], [slots.map, noticeViewP(h, model.viewingToast), slots.keyList ?? null]),
      captionsView(h, model),
      noticeView(h, "intake-notice", model.intakeToast),
      noticeView(h, "screen-notice", model.screenToast),
      noticeView(h, "tap-notice", model.tapToast),
      selfPauseView(h, model),
      diffUpdateView(h, model),
      slots.side,
    ],
  );

function noticeViewP(h: H, toast: NoticeModel): Html | null {
  return Option.match(shownText(toast), { onNone: () => null, onSome: (text) => h.p([h.Class("viewing-notice")], [text]) });
}

type SlotViews = { readonly map: (notice: Html | null) => Html; readonly keyList: () => Html | null; readonly side: () => Html | null };
export const submodelView = Submodel.defineView<Model, Message, SlotViews>((model, slots, h) =>
  view(model, h, { map: slots.map(noticeView(h, "discussion-notice", model.discussionToast)), keyList: slots.keyList(), side: slots.side() }),
);
