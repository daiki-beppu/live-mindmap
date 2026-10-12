// セッションの画面の部品（Issue #820）: 字幕・取り込みの途切れ・共有画面・見る状態の知らせ。見返しと会議中で共通に使う。
// 知らせは Toast（headless）で持ち、消えるまでの時間は Toast の duration で持つ。位置・要素・文言は React 版（SessionView、Issue #829 で削除）から変えない
import { Option, Schema } from "effect";
import { Disclosure } from "@foldkit/ui";
import { Submodel, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { DiffUpdateState } from "../../../../server/src/core/index.ts";
import { captionsOf } from "../../captions.ts";
import { intakeNoticeText, RESUMED_NOTICE_MS } from "../../intake.ts";
import { IntakeStatus, Message } from "./message.ts";
import { Notice, shownText, type NoticeModel } from "./toast.ts";

export const Model = Schema.Struct({
  speaking: Schema.Struct({ 相手: Schema.String, 自分: Schema.String }),
  // 字幕を隠しているか。Disclosure は状態を持たないので、開閉の状態はここの 1 か所だけ
  captionsHidden: Schema.Boolean,
  intake: Schema.Option(IntakeStatus),
  intakeToast: Notice.Model,
  screenToast: Notice.Model,
  tapToast: Notice.Model,
  viewingToast: Notice.Model,
  diffUpdate: Schema.Option(DiffUpdateState),
  local: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const init = (): Model => ({
  speaking: { 相手: "", 自分: "" },
  captionsHidden: false,
  intake: Option.none(),
  intakeToast: Notice.init({ id: "intake-notice" }),
  screenToast: Notice.init({ id: "screen-notice" }),
  tapToast: Notice.init({ id: "tap-notice" }),
  viewingToast: Notice.init({ id: "viewing-notice" }),
  diffUpdate: Option.none(),
  local: false,
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

// 出ている文を入れ替える。前の entry は先に消し始め（描かれなくなる）、新しい文を足す
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
    ChangedSpeaking: ({ speaking }) => ({ model: modifyFields(model, { speaking: () => speaking }) }),
    ToggledCaptions: ({ isOpen }) => ({ model: modifyFields(model, { captionsHidden: () => !isOpen }) }),
    ReceivedDiffUpdate: ({ state }) => ({ model: modifyFields(model, { diffUpdate: () => state }) }),
    ReceivedSessionMode: ({ local }) => ({ model: modifyFields(model, { local: () => local }) }),
    // 変わらない状態は何もしない。変わったら intakeNoticeText が文を決める（届いた時点が変わった時点なので経過時間は 0）
    ReceivedIntakeStatus: ({ status }) => {
      if (Option.contains(model.intake, status)) return { model };
      const text = intakeNoticeText({ previous: Option.getOrNull(model.intake), current: status, msSinceChange: 0 });
      const next = modifyFields(model, { intake: () => Option.some(status) });
      // 「再開しました」だけが Toast の duration で消える。途切れ・止まったは状態が変わるまで残る
      return noticeOf(next, foldIntakeToast, Option.none(), Option.fromNullishOr(text), status === "running" ? { duration: RESUMED_NOTICE_MS } : { sticky: true });
    },
    ReceivedScreenNotice: ({ text }) => noticeOf(model, foldScreenToast, shownText(model.screenToast), text, { sticky: true }),
    ReceivedTapNotice: ({ text }) => noticeOf(model, foldTapToast, shownText(model.tapToast), text, { sticky: true }),
    ChangedViewingMode: ({ mode }) =>
      noticeOf(model, foldViewingToast, shownText(model.viewingToast), viewingText(mode), { sticky: true }),
    GotIntakeToastMessage: ({ message }) => foldIntakeToast(model, (toast) => Notice.update(toast, message)),
    GotScreenToastMessage: ({ message }) => foldScreenToast(model, (toast) => Notice.update(toast, message)),
    GotTapToastMessage: ({ message }) => foldTapToast(model, (toast) => Notice.update(toast, message)),
    GotViewingToastMessage: ({ message }) => foldViewingToast(model, (toast) => Notice.update(toast, message)),
  });

// 親（会議中）が、WebSocket の frame から届いた事実を伝える入口（子の Message を親が組み立てずに済む）
export const receiveIntakeStatus = (model: Model, status: typeof IntakeStatus.Type): Return => update(model, Message.ReceivedIntakeStatus({ status }));
export const receiveScreenNotice = (model: Model, text: Option.Option<string>): Return => update(model, Message.ReceivedScreenNotice({ text }));
export const receiveTapNotice = (model: Model, text: Option.Option<string>): Return => update(model, Message.ReceivedTapNotice({ text }));
export const receiveDiffUpdate = (model: Model, state: Model["diffUpdate"]): Return => update(model, Message.ReceivedDiffUpdate({ state }));
export const receiveSessionMode = (model: Model, local: boolean): Return => update(model, Message.ReceivedSessionMode({ local }));

// 親（見返し）が、見る状態の mode が変わったことを伝える入口（子の Message を親が組み立てずに済む）
export const changeViewingMode = (model: Model, mode: "auto" | "manual" | "overview"): Return => update(model, Message.ChangedViewingMode({ mode }));

const MANUAL_TEXT = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
const OVERVIEW_TEXT = "全体を見ています・F か Esc で戻る・? でキー一覧";
const viewingText = (mode: "auto" | "manual" | "overview"): Option.Option<string> =>
  mode === "manual" ? Option.some(MANUAL_TEXT) : mode === "overview" ? Option.some(OVERVIEW_TEXT) : Option.none();

type H = HtmlBuilder<Message>;
// keyList は、キーの一覧（見返しだけ。閉じていれば null）。省略すれば何も描かない
type Slots = { readonly map: Html; readonly keyList?: Html | null; readonly side: Html | null };

const noticeView = (h: H, className: string, toast: NoticeModel): Html | null =>
  Option.match(shownText(toast), { onNone: () => null, onSome: (text) => h.div([h.Class(className), h.AriaLive("polite")], [text]) });

function captionsView(h: H, model: Model): Html | null {
  const captions = captionsOf(model.speaking);
  if (captions.length === 0) return null;
  return Disclosure.view(
    {
      id: "captions",
      isOpen: !model.captionsHidden,
      onToggle: (isOpen) => Message.ToggledCaptions({ isOpen }),
      // 隠しているときは .captions ごと描かない（animatePanel は使わない）
      toView: ({ panel }) =>
        model.captionsHidden
          ? null
          : h.div(
              [h.Class("captions"), h.AriaLive("polite"), ...panel],
              captions.map((c) =>
                h.keyed("div")(
                  c.track,
                  [h.Class("captions__block")],
                  [h.span([h.Class("captions__track")], [c.track]), h.div([h.Class("captions__lines")], c.lines.map((line) => h.p([h.Class("captions__line")], [line])))],
                ),
              ),
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

const diffUpdateView = (h: H, model: Model): Html | null =>
  Option.exists(model.diffUpdate, (state) => state.status === "paused" && state.reason === "ChatGPT の利用上限")
    ? h.div([h.Class("diff-update-notice"), h.Role("status")], ["マップの更新が止まっています（ChatGPT の利用上限）"])
    : null;

// `.map`・キーの一覧・`.side` は別の部品が持つので、差し込み口で受け取る（`.side` は包まずそのまま置く。右の列を隠しているときは null）。並びは SessionView の .layout の直下と同じ。
// キーの一覧は `.map` の中の最後に置く（表示面 → 見る状態の知らせ → キーの一覧）
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
      diffUpdateView(h, model),
      slots.side,
    ],
  );

function noticeViewP(h: H, toast: NoticeModel): Html | null {
  return Option.match(shownText(toast), { onNone: () => null, onSome: (text) => h.p([h.Class("viewing-notice")], [text]) });
}

// 親が h.submodel で組み込むための view。差し込み口は、親の builder で作る Html を返す関数（親の境界で実行される）で受ける
type SlotViews = { readonly map: () => Html; readonly keyList: () => Html | null; readonly side: () => Html | null };
export const submodelView = Submodel.defineView<Model, Message, SlotViews>((model, slots, h) =>
  view(model, h, { map: slots.map(), keyList: slots.keyList(), side: slots.side() }),
);
