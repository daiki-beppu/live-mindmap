// 見返しの操作の行（Issue #825）: シークバー・ボタン・音量・速さのメニュー。名前・class・並び・文言は今の ReviewControls.tsx と同じ（今の CSS をそのまま当てるため）。
// 部品は @foldkit/ui を使う: シークバーと音量は Slider、速さのメニューは Menu、ボタンのツールチップは Tooltip、字幕のボタンの開閉の属性は Disclosure（#820）。
// 自前で描くのは、章・進み・印、章名と時刻のプレビュー、アイコン（icons.ts）、時刻と議題。
// Slider・Menu・Tooltip が属性の束（root・track・thumb・trigger・panel…）に付ける style と id は、そのまま残す。束の後に h.Style を足さない。
// 今の CSS とのぶつかりは controls.css で直す（web/src/styles.css は変えない）
import { Disclosure, Menu, Slider, Tooltip } from "@foldkit/ui";
import { Option } from "effect";
import { childAttributes, type ChildAttribute, type Html, type HtmlBuilder } from "foldkit/html";
import { KIND_COLOR } from "../../kinds.ts";
import { rateItemLabel } from "../../reviewPlayback.ts";
import { chapterNameAt, formatHms, type Chapter } from "../../reviewTimeline.ts";
import "./controls.css";
import type { Context } from "./context.ts";
import { CaptionsOffIcon, CaptionsOnIcon, CheckIcon, PauseIcon, PlayIcon, SideIcon, SpeedIcon, StepIcon, VolumeHighIcon, VolumeLowIcon, VolumeOffIcon } from "./icons.ts";
import type { Model } from "./main.ts";
import { Message, type TooltipKey } from "./message.ts";
import { ObserveSeekPointer } from "./mount.ts";

type H = HtmlBuilder<Message>;

export const SEEK_SLIDER_ID = "review-seek";
export const VOLUME_SLIDER_ID = "review-volume";
export const RATE_MENU_ID = "review-rate-menu";
// 字幕の Disclosure の id（button の id が captions-button になる）
const CAPTIONS_DISCLOSURE_ID = "captions";

export const tooltipId = (key: TooltipKey): string => `review-tip-${key}`;

// 速さのメニューは項目の文字列から速さを引く（Selected の index で rates を引くので、文字列は表示に使わない）
export const RateMenu = Menu.create<string>();

const pct = (fraction: number): string => `${fraction * 100}%`;

// ボタンの音量のアイコン。0 とミュート中は Off、0.5 未満は Low
const volumeIcon = (h: H, muted: boolean, volume: number): Html => (muted || volume === 0 ? VolumeOffIcon(h) : volume < 0.5 ? VolumeLowIcon(h) : VolumeHighIcon(h));

// ---- ツールチップ ----
// 吹き出し（panel）は常に描き、出す・隠すは Tooltip の data-open と CSS で行う。ボタンは aria-describedby で吹き出しを指す
type Placement = "top-start" | "top-end";
type Trigger = ReadonlyArray<ChildAttribute>;

const tip = (h: H, panel: Trigger, text: string): Html => h.span([...panel, h.Class("review-tip")], [text]);

// ツールチップを付けたボタンの部品。toView は、ツールチップの束（trigger・panel）を受けて、ボタンを返す
const withTooltip = (h: H, model: Model, key: TooltipKey, placement: Placement, toView: (render: { trigger: Trigger; panel: Trigger }) => Html): Html =>
  h.submodel({
    slotId: tooltipId(key),
    model: model.tooltips[key],
    view: Tooltip.view,
    viewInputs: { anchor: { placement }, toView: ({ trigger, panel }) => toView({ trigger, panel }) },
    toParentMessage: (message) => Message.GotTooltipMessage({ tooltipId: key, message }),
  });

// 押すだけのボタン（戻る・再生・進む・ミュート・右の列）
const barButton = (h: H, model: Model, key: TooltipKey, placement: Placement, label: string, message: Message, icon: Html, text: string, extra: Parameters<H["button"]>[0] = []): Html =>
  withTooltip(h, model, key, placement, ({ trigger, panel }) =>
    h.button([...trigger, h.Class("review-bar__button"), h.AriaLabel(label), h.OnClick(message), ...extra], [icon, tip(h, panel, text)]),
  );

// ---- シークバー ----
// 章が無い、または会議の長さが 0 のときは、区切らずに全幅の 1 本で描く（0 での割り算を避ける）
const seekBar = (context: Context, model: Model, h: H): Html => {
  const duration = context.playback.duration;
  const time = model.playback.time;
  const chapters = context.chapters;
  const whole = chapters.length === 0 || duration <= 0;
  const segments: readonly Chapter[] = whole ? [{ topic: "", name: "", start: 0, end: duration }] : chapters;
  const maybePointer = model.maybeSeekPointer;
  // ポインタが乗っている間は、その位置の時刻。章名と時刻のプレビューに使う
  const previewTime = Option.match(maybePointer, { onNone: () => time, onSome: (fraction) => fraction * duration });
  return h.submodel({
    slotId: SEEK_SLIDER_ID,
    model: model.seekSlider,
    view: Slider.view,
    viewInputs: {
      value: time,
      ariaLabel: "時刻",
      toView: (a) =>
        h.div(
          [
            ...a.root,
            h.Class("review-seek"),
            ...(Option.isSome(maybePointer) ? [h.DataAttribute("pointing", "")] : []),
            h.OnPointerDown(() => Option.some(Message.PressedSliderPointer())),
            h.OnMount(ObserveSeekPointer()),
          ],
          [
            // Slider の track の束は、押せる範囲用の包み要素に付ける（見た目の track は絶対配置で 3px。束の inline の relative で崩れるため）
            h.div(
              [...a.track, h.Class("review-slider-hit")],
              [
                h.div(
                  [h.Class("review-seek__track")],
                  [
                    ...segments.map((c) => {
                      const len = c.end - c.start;
                      const filled = whole ? (duration > 0 ? Math.min(1, time / duration) : 0) : len > 0 ? Math.min(1, Math.max(0, (time - c.start) / len)) : 0;
                      return h.keyed("div")(
                        String(c.start),
                        [h.Class("review-seek__chapter"), h.Style(whole ? { left: "0", width: "100%" } : { left: pct(c.start / duration), width: `calc(${pct(len / duration)} - 2px)` })],
                        [h.div([h.Class("review-seek__progress"), h.Style({ width: pct(filled) })])],
                      );
                    }),
                    ...(duration > 0
                      ? context.marks.map((mark, index) => h.keyed("span")(String(index), [h.Class("review-seek__mark"), h.Style({ left: pct(mark.at / duration), background: KIND_COLOR[mark.kind] })]))
                      : []),
                  ],
                ),
              ],
            ),
            h.div([...a.thumb, h.Class("review-seek__thumb")]),
            h.div(
              [h.Class("review-seek__preview"), h.Style({ left: pct(duration > 0 ? previewTime / duration : 0) })],
              [h.span([h.Class("review-seek__preview-chapter")], [chapterNameAt(chapters, previewTime)]), h.span([h.Class("review-seek__preview-time")], [formatHms(previewTime)])],
            ),
          ],
        ),
    },
    toParentMessage: (message) => Message.GotSeekSliderMessage({ message }),
  });
};

// ---- 音量（録音つきだけ）----
const volumeControl = (model: Model, h: H): Html => {
  const { muted, volume } = model.playback;
  const label = muted ? "ミュートを戻す" : "ミュート";
  const value = muted ? 0 : volume;
  return h.div(
    [h.Class("review-volume")],
    [
      barButton(h, model, "mute", "top-start", label, Message.ClickedMute(), volumeIcon(h, muted, volume), `${label}（M）`),
      h.submodel({
        slotId: VOLUME_SLIDER_ID,
        model: model.volumeSlider,
        view: Slider.view,
        viewInputs: {
          value,
          ariaLabel: "音量",
          toView: (a) =>
            h.div(
              [...a.root, h.Class("review-volume__slider"), h.OnPointerDown(() => Option.some(Message.PressedSliderPointer()))],
              [
                h.div([...a.track, h.Class("review-slider-hit")], [h.div([h.Class("review-volume__track")], [h.div([...a.filledTrack, h.Class("review-volume__fill")])])]),
                h.div([...a.thumb, h.Class("review-volume__thumb")]),
              ],
            ),
        },
        toParentMessage: (message) => Message.GotVolumeSliderMessage({ message }),
      }),
    ],
  );
};

// ---- 字幕 ----
// 字幕の Disclosure の button の属性（id=captions-button・aria-expanded・click で ToggledCaptions）を、ツールチップの束の後に付ける。
// ツールチップの束の id はボタンでなく包み要素に付け、吹き出しの位置はその包み要素を基準にする（ボタンの id は Disclosure のものにするため）
const captionsButton = (model: Model, h: H): Html => {
  const isOpen = !model.captionsHidden;
  return withTooltip(h, model, "captions", "top-end", ({ trigger, panel }) =>
    h.span(
      [h.Class("review-bar__anchor"), h.Id(Tooltip.triggerId(tooltipId("captions")))],
      [
        Disclosure.view(
          {
            id: CAPTIONS_DISCLOSURE_ID,
            isOpen,
            onToggle: (next) => Message.ToggledCaptions({ isOpen: next }),
            toView: ({ button }) =>
              h.button(
                [...trigger, ...button, h.Class("review-bar__button"), h.AriaLabel("字幕"), h.AriaPressed(String(isOpen))],
                [isOpen ? CaptionsOnIcon(h) : CaptionsOffIcon(h), tip(h, panel, "字幕（C）")],
              ),
          },
          h,
        ),
      ],
    ),
  );
};

// ---- 速さ ----
// ボタンは Menu の button。ツールチップの束の後に Menu 自身の id を戻す（Menu の吹き出し・メニューの位置が、この id でボタンを探すため）。
// 吹き出し（OnMount を持つ）は h.submodel の viewInputs に入れられないので、Menu の隣に置く。ツールチップの位置の基準は、両方を包む要素に付けた束の id。
// メニューの項目は倍率の文字列で、Selected の index で速さを引く
const rateControl = (context: Context, model: Model, h: H): Html => {
  const { rate } = model.playback;
  const duration = context.playback.duration;
  const timesOnly = Option.isSome(context.maybeAudioUrl);
  return withTooltip(h, model, "rate", "top-end", ({ trigger, panel }) =>
    h.span(
      [h.Class("review-bar__anchor"), h.Id(Tooltip.triggerId(tooltipId("rate")))],
      [
        h.submodel({
          slotId: RATE_MENU_ID,
          model: model.rateMenu,
          view: RateMenu.view,
          viewInputs: {
            items: context.playback.rates.map(String),
            itemToConfig: (item) => {
              const itemRate = Number(item);
              return {
                className: "review-rate__item",
                content: h.span([h.Class("review-contents")], [h.span([h.Class("review-rate__check")], itemRate === rate ? [CheckIcon(h)] : []), rateItemLabel(itemRate, duration, timesOnly)]),
              };
            },
            ariaLabel: "再生の速さ",
            className: "review-rate",
            buttonClassName: "review-bar__button review-rate__button",
            buttonAttributes: [...trigger, ...childAttributes([h.Id(Menu.buttonId(RATE_MENU_ID))])],
            buttonContent: h.span([h.Class("review-contents")], [SpeedIcon(h), h.span([], [`${rate}×`])]),
            itemsClassName: "review-rate__menu",
            backdropClassName: "review-rate__backdrop",
            anchor: { placement: "top-end" },
          },
          toParentMessage: (message) => Message.GotRateMenuMessage({ message }),
        }),
        tip(h, panel, "速さ（< >）"),
      ],
    ),
  );
};

export const controlsView = (context: Context, model: Model, topicName: string, h: H): Html => {
  const { time, playing } = model.playback;
  const duration = context.playback.duration;
  const rates = context.playback.rates;
  const playLabel = playing ? "止める" : "再生";
  return h.div(
    [h.Class("review-controls")],
    [
      seekBar(context, model, h),
      h.div(
        [h.Class("review-bar")],
        [
          barButton(h, model, "prev", "top-start", "反映 1 つ戻る", Message.ClickedPrev(), StepIcon(h, "prev"), "反映 1 つ戻る（,）"),
          barButton(h, model, "toggle", "top-start", playLabel, Message.ClickedToggle(), playing ? PauseIcon(h) : PlayIcon(h), `${playLabel}（Space・K）`),
          barButton(h, model, "next", "top-start", "反映 1 つ進む", Message.ClickedNext(), StepIcon(h, "next"), "反映 1 つ進む（.）"),
          ...(Option.isSome(context.maybeAudioUrl) ? [volumeControl(model, h)] : []),
          h.span([h.Class("review-bar__time")], [`${formatHms(time)} / ${formatHms(duration)}`]),
          h.span([h.Class("review-bar__topic")], [topicName]),
          h.div(
            [h.Class("review-bar__end")],
            [
              captionsButton(model, h),
              ...(rates.length > 1 ? [rateControl(context, model, h)] : []),
              barButton(h, model, "side", "top-end", "右の列", Message.ClickedSide(), SideIcon(h, model.sideHidden), "右の列（E）", [h.AriaPressed(String(!model.sideHidden))]),
            ],
          ),
        ],
      ),
    ],
  );
};
