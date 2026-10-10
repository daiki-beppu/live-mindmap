// 試作（Issue #736）: Foldkit 版の見返しの view。DOM の形と class 名は今の画面（SessionView・MapNode・ReviewControls など）にそろえ、styles.css をそのまま当てる。
// マップは @xyflow を使わず、ノード（絶対配置の div）・エッジ（SVG のベジェ）・ビューポート（transform）を素で描く
import { Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { Slider } from "@foldkit/ui";
import { edgeDots } from "../camera.ts";
import { captionsOf } from "../captions.ts";
import { formatClock } from "../changes.ts";
import { FOLD_DOT_CLASSES, MAP_NODE_BUTTON_CLASS } from "../enterFold.ts";
import { evidenceOf, type Evidence } from "../evidence.ts";
import { KIND_COLOR, markOf } from "../kinds.ts";
import { NODE_WIDTH } from "../layout.ts";
import { chapterNameAt, formatHms, speakingAt, topicNameOf, type Chapter } from "../reviewTimeline.ts";
import { foldToggle, humanSetsOf } from "../viewing.ts";
import { AUDIO_ID, ObserveAudio, ObserveMap, ObserveSeekPointer } from "./effects.ts";
import { icon, sideIcon, type IconName } from "./icons.ts";
import { AUDIO_KEY_LIST, KEY_LIST, rateItemLabel, REVIEW_KEY_LIST } from "./keyList.ts";
import { Message } from "./message.ts";
import type { Context, Model } from "./model.ts";

type H = HtmlBuilder<Message>;

const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
const pct = (f: number) => `${f * 100}%`;

// React Flow の既定のエッジ（ベジェ、curvature 0.25）。端はハンドル（幅 6px）の外側で、ノードの左右の端から 3px 外
const controlOffset = (d: number) => (d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d));
const bezier = (sx: number, sy: number, tx: number, ty: number) => {
  const off = controlOffset(tx - sx);
  return `M${sx},${sy} C${sx + off},${sy} ${tx - off},${ty} ${tx},${ty}`;
};

function mapSurface(m: Model, h: H): Html {
  const { d, shown, dims } = m;
  const paused = m.viewing.mode !== "auto";
  const selectedId = m.viewing.selection?.id ?? null;
  const { opened } = humanSetsOf(m.viewing);
  const edges = d.nodes.flatMap((n) => {
    const s = n.parent === null ? undefined : shown[n.parent];
    const t = shown[n.id];
    const sd = n.parent === null ? undefined : dims[n.parent];
    const td = dims[n.id];
    if (!s || !t || !sd || !td) return [];
    return [h.path([h.Class("fk-edge"), h.D(bezier(s.x + NODE_WIDTH + 3, s.y + sd.height / 2, t.x - 3, t.y + td.height / 2)), h.Stroke(KIND_COLOR[n.kind]), h.StrokeWidth("2"), h.Fill("none")])];
  });
  const nodes = d.nodes.map((n) => {
    const p = shown[n.id] ?? { x: 0, y: 0 };
    const fold = d.view.folds[n.id] ?? null;
    const changed = d.view.blink.has(n.id);
    const toggle = foldToggle(d.tree, n.id) !== null;
    const mark = markOf(n);
    // 位置は画面（screen）の座標で比べる。OnPointerUp は client の座標を渡さないため
    const press = (_type: string, button: number, x: number, y: number) => (button === 0 ? Option.some(Message.PressedNode({ id: n.id, x, y })) : Option.none());
    const release = (x: number, y: number) => Option.some(Message.ReleasedNode({ id: n.id, x, y }));
    const body = h.keyed("div")(
      changed ? `blink-${d.snapshot.round}` : "steady",
      [
        h.Class(cls("map-node", n.kind === "案" && n.planStatus === "却下" && "map-node--rejected", fold && "map-node--folded", n.id === selectedId && "map-node--selected", changed && "map-node--blink", "nopan")),
        h.Style({ "--kind-color": KIND_COLOR[n.kind] }),
      ],
      [
        h.button(
          [h.Type("button"), h.Class(MAP_NODE_BUTTON_CLASS), h.AriaPressed(String(n.id === selectedId)), h.OnPointerDown(press), h.OnPointerUp(release), h.OnClick(Message.ClickedNode({ id: n.id }))],
          [mark ? h.span([h.Class("map-node__mark")], [mark]) : null, h.span([h.Class("map-node__text")], [n.text]), fold?.hint ? h.span([h.Class("map-node__hint")], [fold.hint]) : null],
        ),
        fold
          ? toggle
            ? h.button([h.Type("button"), h.Class(`map-node__count ${FOLD_DOT_CLASSES[0]}`), h.AriaLabel("開く"), h.OnClick(Message.ClickedFoldDot({ id: n.id }))], [String(fold.hidden)])
            : h.span([h.Class("map-node__count")], [String(fold.hidden)])
          : opened.has(n.id) && toggle
            ? h.button([h.Type("button"), h.Class(FOLD_DOT_CLASSES[1]), h.AriaLabel("畳む"), h.OnClick(Message.ClickedFoldDot({ id: n.id }))])
            : null,
      ],
    );
    // 測るまでは見せない（React Flow と同じ）
    return h.keyed("div")(n.id, [h.Class("fk-node"), h.DataAttribute("node-id", n.id), h.Style({ transform: `translate(${p.x}px, ${p.y}px)`, width: `${NODE_WIDTH}px`, visibility: dims[n.id] ? "visible" : "hidden" })], [body]);
  });
  const dots = paused
    ? h.div(
        [h.Class("edge-dots")],
        edgeDots(d.tree.ids.filter((id) => d.view.blink.has(id)), d.target, dims, m.viewport, m.size).map((dot) =>
          h.keyed("button")(dot.id, [
            h.Type("button"),
            h.Class("edge-dot nopan nowheel"),
            h.Style({ left: `${dot.x}px`, top: `${dot.y}px` }),
            h.AriaLabel(`画面の外で変わったノードへ寄る（${dot.ids.length} 件）`),
            h.OnClick(Message.ClickedEdgeDot({ id: dot.id })),
          ]),
        ),
      )
    : null;
  const { x, y, zoom } = m.viewport;
  const panePress = (_type: string, button: number, sx: number, sy: number, _t: number, _cx: number, _cy: number, _id: number, target: EventTarget | null) =>
    button !== 0 || (target instanceof Element && target.closest(".nopan")) ? Option.none() : Option.some(Message.PressedPane({ x: sx, y: sy }));
  return h.div(
    [h.Class(cls("fk-map", m.drag?.kind === "pane" && "fk-map--dragging")), h.OnMount(ObserveMap()), h.OnPointerDown(panePress)],
    [
      h.div(
        [h.Class("fk-viewport"), h.Style({ transform: `translate(${x}px, ${y}px) scale(${zoom})` })],
        [h.svg([h.Class("fk-edges")], edges), h.div([h.Class("fk-nodes")], nodes)],
      ),
      dots,
    ],
  );
}

function evidencePanel(h: H, selectedId: string | null, evidence: Evidence | null): Html {
  const body = (): Html[] => {
    if (selectedId === null) return [h.p([h.Class("evidence__empty")], ["ノードを選ぶと、根拠の発言が出ます"])];
    if (evidence === null) return [h.p([h.Class("evidence__empty")], ["選んだノードは今のマップにありません"])];
    const { node, remarks } = evidence;
    const status = node.kind === "論点" ? node.pointStatus : node.kind === "案" ? node.planStatus : undefined;
    return [
      h.p([h.Class("evidence__meta")], [h.span([h.Class("evidence__kind")], [node.kind]), status ? h.span([h.Class("evidence__status")], [status]) : null]),
      h.p([h.Class("evidence__text")], [node.text]),
      remarks.length === 0
        ? h.p([h.Class("evidence__empty")], ["根拠の発言はありません"])
        : h.ul(
            [],
            remarks.map((r) =>
              h.keyed("li")(r.id, [h.Class("evidence__remark")], [
                h.span([h.Class("evidence__time")], [`${formatClock(r.start)}〜${formatClock(r.end)}`]),
                h.span([h.Class("evidence__track")], [r.track]),
                h.span([h.Class("evidence__remark-text")], [r.text]),
              ]),
            ),
          ),
    ];
  };
  return h.section([h.Class("evidence"), h.AriaLabelledBy("evidence-heading")], [h.h2([h.Id("evidence-heading")], ["根拠"]), ...body()]);
}

function sessionView(ctx: Context, m: Model, h: H): Html {
  const { viewing, d } = m;
  const selectedId = viewing.selection?.id ?? null;
  const { opened, folded, unbundled } = humanSetsOf(viewing);
  const captions = captionsOf(speakingAt(ctx.timeline, m.playback.time));
  const keyRows = [...KEY_LIST.filter((r) => r.group === "キー"), ...REVIEW_KEY_LIST, ...(ctx.audio ? AUDIO_KEY_LIST : []), ...KEY_LIST.filter((r) => r.group !== "キー")];
  const notice = viewing.mode === "overview" ? "全体を見ています・F か Esc で戻る・? でキー一覧" : viewing.mode === "manual" ? "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧" : null;
  return h.div(
    [h.Class("layout")],
    [
      h.div(
        [h.Class("map")],
        [
          mapSurface(m, h),
          notice ? h.p([h.Class("viewing-notice")], [notice]) : null,
          viewing.keyList
            ? h.div([h.Class("key-list")], keyRows.map((row) => h.keyed("p")(`${row.group}:${row.keys}`, [h.Class("key-list__row")], [h.span([h.Class("key-list__keys")], [row.keys]), ` ${row.action}`])))
            : null,
        ],
      ),
      !viewing.captionsHidden && captions.length > 0
        ? h.div(
            [h.Class("captions"), h.AriaLive("polite")],
            captions.map((c) =>
              h.keyed("div")(c.track, [h.Class("captions__block")], [
                h.span([h.Class("captions__track")], [c.track]),
                h.div([h.Class("captions__lines")], c.lines.map((line) => h.p([h.Class("captions__line")], [line]))),
              ]),
            ),
          )
        : null,
      viewing.sideHidden
        ? null
        : h.div(
            [h.Class("side")],
            [
              evidencePanel(h, selectedId, selectedId === null ? null : evidenceOf(d.snapshot, selectedId, opened, folded, unbundled)),
              h.aside([h.Class("changes"), h.AriaLabelledBy("changes-heading")], [
                h.h2([h.Id("changes-heading")], ["変わったこと"]),
                h.ul(
                  [],
                  [...d.snapshot.changes].reverse().map((c) =>
                    h.keyed("li")(`${c.round}-${c.node}-${c.change}`, [h.Class("changes__item")], [
                      h.button([h.Type("button"), h.Class("changes__button"), h.OnClick(Message.ClickedChange({ id: c.node }))], [
                        h.time([h.Class("changes__time")], [formatClock(c.at)]),
                        h.span([h.Class("changes__type")], [c.change]),
                        h.span([h.Class("changes__kind")], [c.kind]),
                        h.span([h.Class("changes__text")], [c.text]),
                      ]),
                    ]),
                  ),
                ),
              ]),
            ],
          ),
    ],
  );
}

const tip = (h: H, text: string) => h.span([h.Class("review-tip"), h.AriaHidden(true)], [text]);
const barButton = (h: H, label: string, message: Message, iconHtml: Html, tipText: string, extra: Parameters<H["button"]>[0] = []) =>
  h.button([h.Type("button"), h.Class("review-bar__button"), h.AriaLabel(label), h.OnClick(message), ...extra], [iconHtml, tip(h, tipText)]);

function seekBar(ctx: Context, m: Model, h: H): Html {
  const { duration } = ctx.timeline;
  const time = m.playback.time;
  const chapters = ctx.chapters;
  const whole = chapters.length === 0 || duration <= 0;
  const segments: readonly Chapter[] = whole ? [{ topic: "", name: "", start: 0, end: duration }] : chapters;
  const pointing = m.seekPointer !== null;
  const previewValue = m.seekPointer ?? time;
  return h.submodel({
    slotId: m.seekSlider.id,
    model: m.seekSlider,
    view: Slider.view,
    viewInputs: {
      value: time,
      ariaLabel: "時刻",
      toView: (a) =>
        h.div(
          [...a.root, h.Class("review-seek"), ...(pointing ? [h.DataAttribute("pointing", "")] : []), h.OnMount(ObserveSeekPointer({ max: duration }))],
          [
            h.div(
              [...a.track, h.Class("fk-slider-hit")],
              [
                h.div(
                  [h.Class("review-seek__track")],
                  [
                    ...segments.map((c) => {
                      const len = c.end - c.start;
                      const filled = whole ? (duration > 0 ? Math.min(1, time / duration) : 0) : len > 0 ? Math.min(1, Math.max(0, (time - c.start) / len)) : 0;
                      return h.keyed("div")(String(c.start), [h.Class("review-seek__chapter"), h.Style(whole ? { left: "0", width: "100%" } : { left: pct(c.start / duration), width: `calc(${pct(len / duration)} - 2px)` })], [
                        h.div([h.Class("review-seek__progress"), h.Style({ width: pct(filled) })]),
                      ]);
                    }),
                    ...(duration > 0 ? ctx.marks.map((mk) => h.span([h.Class("review-seek__mark"), h.Style({ left: pct(mk.at / duration), background: KIND_COLOR[mk.kind] })])) : []),
                  ],
                ),
              ],
            ),
            h.div([...a.thumb, h.Class("review-seek__thumb")]),
            h.div([h.Class("review-seek__preview"), h.Style({ position: "absolute", left: pct(duration > 0 ? previewValue / duration : 0), transform: "translateX(-50%)" })], [
              h.span([h.Class("review-seek__preview-chapter")], [chapterNameAt(chapters, previewValue)]),
              h.span([h.Class("review-seek__preview-time")], [formatHms(previewValue)]),
            ]),
          ],
        ),
    },
    toParentMessage: (message) => Message.GotSeekSlider({ message }),
  });
}

function volumeControl(m: Model, h: H): Html {
  const { muted, volume } = m.playback;
  const label = muted ? "ミュートを戻す" : "ミュート";
  const name: IconName = muted || volume === 0 ? "volumeOff" : volume < 0.5 ? "volumeLow" : "volumeHigh";
  const value = muted ? 0 : volume;
  return h.div([h.Class("review-volume")], [
    barButton(h, label, Message.ClickedMute(), icon(h, name), `${label}（M）`),
    h.submodel({
      slotId: m.volumeSlider.id,
      model: m.volumeSlider,
      view: Slider.view,
      viewInputs: {
        value,
        ariaLabel: "音量",
        toView: (a) =>
          h.div([...a.root, h.Class("review-volume__slider"), h.Style({ "--media-slider-fill": pct(value) })], [
            h.div([...a.track, h.Class("fk-slider-hit")], [h.div([h.Class("review-volume__track")], [h.div([h.Class("review-volume__fill")])])]),
            h.div([...a.thumb, h.Class("review-volume__thumb")]),
          ]),
      },
      toParentMessage: (message) => Message.GotVolumeSlider({ message }),
    }),
  ]);
}

function controls(ctx: Context, m: Model, h: H): Html {
  const { playing, rate, time } = m.playback;
  const { duration } = ctx.timeline;
  const rates = ctx.playback.rates;
  const captionsHidden = m.viewing.captionsHidden === true;
  const sideHidden = m.viewing.sideHidden === true;
  // Space で押されたことになるのは keyup の既定の動き。keydown の登録が 1 回だけ切り替えるので、keyup では止める
  return h.div([h.Class("review-controls"), h.OnKeyUpPreventDefault((key) => (key === " " ? Option.some(Message.IgnoredKey()) : Option.none()))], [
    seekBar(ctx, m, h),
    h.div([h.Class("review-bar")], [
      barButton(h, "反映 1 つ戻る", Message.ClickedPrev(), icon(h, "stepPrev"), "反映 1 つ戻る（,）"),
      barButton(h, playing ? "止める" : "再生", Message.ClickedToggle(), icon(h, playing ? "pause" : "play"), playing ? "止める（Space・K）" : "再生（Space・K）"),
      barButton(h, "反映 1 つ進む", Message.ClickedNext(), icon(h, "stepNext"), "反映 1 つ進む（.）"),
      ctx.audio ? volumeControl(m, h) : null,
      h.span([h.Class("review-bar__time")], [`${formatHms(time)} / ${formatHms(duration)}`]),
      h.span([h.Class("review-bar__topic")], [topicNameOf(m.d.snapshot)]),
      h.div([h.Class("review-bar__end")], [
        barButton(h, "字幕", Message.ClickedCaptions(), icon(h, captionsHidden ? "captionsOff" : "captionsOn"), "字幕（C）", [h.AriaPressed(String(!captionsHidden))]),
        rates.length > 1
          ? h.div([h.Class("review-rate")], [
              h.button(
                [h.Type("button"), h.Class("review-bar__button review-rate__button"), h.AriaLabel("再生の速さ"), h.AriaHasPopup("menu"), h.AriaExpanded(m.rateMenuOpen), h.OnClick(Message.ToggledRateMenu())],
                [icon(h, "speed"), h.span([], [`${rate}×`]), tip(h, "速さ（< >）")],
              ),
              m.rateMenuOpen
                ? h.div(
                    [h.Class("review-rate__menu"), h.Role("menu"), h.AriaLabel("再生の速さ")],
                    rates.map((r) =>
                      h.keyed("button")(String(r), [h.Type("button"), h.Role("menuitemradio"), h.AriaChecked(r === rate), h.Class("review-rate__item"), h.OnClick(Message.ChoseRate({ rate: r }))], [
                        h.span([h.Class("review-rate__check")], [r === rate ? icon(h, "check") : null]),
                        rateItemLabel(r, duration, ctx.audio),
                      ]),
                    ),
                  )
                : null,
            ])
          : null,
        barButton(h, "右の列", Message.ClickedSide(), sideIcon(h, sideHidden), "右の列（E）", [h.AriaPressed(String(!sideHidden))]),
      ]),
    ]),
  ]);
}

export const makeView =
  (ctx: Context, audioUrl: string | undefined) =>
  (m: Model, h: H): Document => ({
    title: "live-mindmap",
    body: h.div([h.Class("review fk")], [
      h.div([h.Class("review__session")], [sessionView(ctx, m, h)]),
      controls(ctx, m, h),
      audioUrl ? h.audio([h.Id(AUDIO_ID), h.Src(audioUrl), h.Preload("auto"), h.OnMount(ObserveAudio())]) : null,
    ]),
  });
