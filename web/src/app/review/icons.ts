// 見返しの操作の行のアイコン（Issue #825）: インライン SVG。
// video.js のアイコン 9 種は、@videojs/react 10.0.1 の default アイコンの SVG を写したもの（座標・属性は原本のまま。描き直していない）。
// 出どころとライセンス（Apache-2.0）は icons.NOTICE.md にあり、見返しの HTML のライセンスの表示に残る。React の部品（@videojs/react）は import しない。
// StepIcon・SideIcon は自前のアイコン
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "./message.ts";

type H = HtmlBuilder<Message>;

// 18×18 の video.js のアイコンのルート。ルートの属性は 9 種で共通（fill だけが違う）
const root = (h: H, fill: "currentColor" | "none", children: ReadonlyArray<Html>): Html =>
  h.svg([h.Xmlns("http://www.w3.org/2000/svg"), h.Width("18"), h.Height("18"), h.Fill(fill), h.AriaHidden(true), h.ViewBox("0 0 18 18")], children);

const path = (h: H, d: string): Html => h.path([h.D(d)]);

const VOLUME_BODY =
  "M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752";
const VOLUME_WAVE =
  "m10.568.59a.91.91 0 0 1 0-1.316.91.91 0 0 1 1.316 0c1.203 1.203 1.47 2.216 1.522 3.208q.012.255.011.51c0 1.16-.358 2.733-1.533 3.803a.7.7 0 0 1-.298.156c-.382.106-.873-.011-1.018-.156a.91.91 0 0 1 0-1.316c.57-.57.995-1.551.995-2.487 0-.944-.26-1.667-.995-2.402";

export const PlayIcon = (h: H): Html =>
  root(h, "currentColor", [
    path(h, "m14.051 10.723-7.985 4.964a1.98 1.98 0 0 1-2.758-.638A2.06 2.06 0 0 1 3 13.964V4.036C3 2.91 3.895 2 5 2c.377 0 .747.109 1.066.313l7.985 4.964a2.057 2.057 0 0 1 .627 2.808c-.16.257-.373.475-.627.637"),
  ]);

export const PauseIcon = (h: H): Html =>
  root(h, "currentColor", [
    h.rect([h.Width("5"), h.Height("14"), h.X("2"), h.Y("2"), h.Rx("1.75")]),
    h.rect([h.Width("5"), h.Height("14"), h.X("11"), h.Y("2"), h.Rx("1.75")]),
  ]);

export const CheckIcon = (h: H): Html =>
  root(h, "none", [h.path([h.Stroke("currentColor"), h.StrokeLinecap("round"), h.StrokeLinejoin("round"), h.StrokeWidth("2"), h.D("M4 10.455 6.5 13 14 5")])]);

export const SpeedIcon = (h: H): Html =>
  root(h, "currentColor", [
    path(
      h,
      "M9 18q-.213 0-.424-.012h.85Q9.214 18 9 18M9 2a8 8 0 0 1 8 8c0 1.975-.719 3.78-1.905 5.175a.75.75 0 0 1-1.204.018l-1.509-1.971a.75.75 0 0 1 .596-1.206h1.674a6 6 0 1 0-11.304 0h1.68a.75.75 0 0 1 .596 1.206l-1.507 1.971a.75.75 0 0 1-1.133.07l-.003.004A8 8 0 0 1 9 2",
    ),
    h.rect([h.Width("6"), h.Height("2"), h.X("6"), h.Y("14"), h.FillOpacity(".5"), h.Rx("1")]),
    path(h, "M8.3 6.318c.246-.64 1.154-.64 1.4 0L10.732 9h-.002a2 2 0 1 1-3.46 0h-.001z"),
    h.g(
      [h.FillOpacity(".5")],
      [
        h.circle([h.Cx("5"), h.Cy("10.25"), h.R(".75")]),
        h.circle([h.Cx("13"), h.Cy("10.25"), h.R(".75")]),
        h.circle([h.Cx("6"), h.Cy("7.25"), h.R(".75")]),
        h.circle([h.Cx("12"), h.Cy("7.25"), h.R(".75")]),
      ],
    ),
  ]);

export const VolumeHighIcon = (h: H): Html =>
  root(h, "currentColor", [
    path(h, "M15.6 3.3c-.4-.4-1-.4-1.4 0s-.4 1 0 1.4C15.4 5.9 16 7.4 16 9s-.6 3.1-1.8 4.3c-.4.4-.4 1 0 1.4.2.2.5.3.7.3.3 0 .5-.1.7-.3C17.1 13.2 18 11.2 18 9s-.9-4.2-2.4-5.7"),
    path(h, `${VOLUME_BODY}${VOLUME_WAVE}`),
  ]);

export const VolumeLowIcon = (h: H): Html => root(h, "currentColor", [path(h, `${VOLUME_BODY}${VOLUME_WAVE}`)]);

export const VolumeOffIcon = (h: H): Html =>
  root(h, "currentColor", [
    path(h, `${VOLUME_BODY}M14.5 7.586l-1.768-1.768a1 1 0 1 0-1.414 1.414L13.085 9l-1.767 1.768a1 1 0 0 0 1.414 1.414l1.768-1.768 1.768 1.768a1 1 0 0 0 1.414-1.414L15.914 9l1.768-1.768a1 1 0 0 0-1.414-1.414z`),
  ]);

export const CaptionsOnIcon = (h: H): Html =>
  root(h, "currentColor", [
    path(
      h,
      "M15 2a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zM4 11a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2zm8 0a1 1 0 1 0 0 2h2a1 1 0 1 0 0-2zM4 8a1 1 0 0 0 0 2h1a1 1 0 0 0 0-2zm4 0a1 1 0 0 0 0 2h3a1 1 0 1 0 0-2zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2",
    ),
  ]);

const captionsLine = (h: H, width: string, x: string, y: string): Html =>
  h.rect([h.Width(width), h.Height("2"), h.X(x), h.Y(y), h.Fill("currentColor"), h.FillOpacity(".5"), h.Rx("1")]);

export const CaptionsOffIcon = (h: H): Html =>
  root(h, "none", [
    h.rect([h.Width("16"), h.Height("12"), h.X("1"), h.Y("3"), h.Stroke("currentColor"), h.StrokeWidth("2"), h.Rx("3")]),
    captionsLine(h, "3", "3", "8"),
    captionsLine(h, "2", "13", "8"),
    captionsLine(h, "4", "11", "11"),
    captionsLine(h, "5", "7", "8"),
    captionsLine(h, "7", "3", "11"),
  ]);

// 戻る・進む
export const StepIcon = (h: H, direction: "prev" | "next"): Html =>
  h.svg(
    [h.ViewBox("0 0 16 16"), h.Width("16"), h.Height("16"), h.AriaHidden(true), h.Fill("currentColor")],
    [direction === "prev" ? h.path([h.D("M3 3h2v10H3zM13 3v10L6 8z")]) : h.path([h.D("M11 3h2v10h-2zM3 3l7 5-7 5z")])],
  );

// 右の列（変わったこと・根拠）のアイコン。隠しているときは右の列を塗らない（今の SideIcon と同じ形）
export const SideIcon = (h: H, hidden: boolean): Html =>
  h.svg(
    [h.ViewBox("0 0 16 16"), h.Width("16"), h.Height("16"), h.AriaHidden(true), h.Fill("none"), h.Stroke("currentColor"), h.StrokeWidth("1.5")],
    [
      h.rect([h.X("2"), h.Y("3"), h.Width("12"), h.Height("10"), h.Rx("1.5")]),
      hidden ? h.path([h.D("M10 3v10")]) : h.path([h.D("M10 3v10h3.5a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5z"), h.Fill("currentColor")]),
    ],
  );
