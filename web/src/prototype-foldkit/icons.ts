// 試作（Issue #736）: 見返しの操作の行のアイコン。今の画面が使う @videojs/react/icons と同じ図形を、インラインの SVG で描く
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "./message.ts";

const ICONS = {
  play: ["currentColor", '<path d="m14.051 10.723-7.985 4.964a1.98 1.98 0 0 1-2.758-.638A2.06 2.06 0 0 1 3 13.964V4.036C3 2.91 3.895 2 5 2c.377 0 .747.109 1.066.313l7.985 4.964a2.057 2.057 0 0 1 .627 2.808c-.16.257-.373.475-.627.637"/>'],
  pause: ["currentColor", '<rect width="5" height="14" x="2" y="2" rx="1.75"/><rect width="5" height="14" x="11" y="2" rx="1.75"/>'],
  captionsOn: ["currentColor", '<path d="M15 2a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zM4 11a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2zm8 0a1 1 0 1 0 0 2h2a1 1 0 1 0 0-2zM4 8a1 1 0 0 0 0 2h1a1 1 0 0 0 0-2zm4 0a1 1 0 0 0 0 2h3a1 1 0 1 0 0-2zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2"/>'],
  captionsOff: [
    "none",
    '<rect width="16" height="12" x="1" y="3" stroke="currentColor" stroke-width="2" rx="3"/><rect width="3" height="2" x="3" y="8" fill="currentColor" fill-opacity="0.5" rx="1"/><rect width="2" height="2" x="13" y="8" fill="currentColor" fill-opacity="0.5" rx="1"/><rect width="4" height="2" x="11" y="11" fill="currentColor" fill-opacity="0.5" rx="1"/><rect width="5" height="2" x="7" y="8" fill="currentColor" fill-opacity="0.5" rx="1"/><rect width="7" height="2" x="3" y="11" fill="currentColor" fill-opacity="0.5" rx="1"/>',
  ],
  speed: [
    "currentColor",
    '<path d="M9 18q-.213 0-.424-.012h.85Q9.214 18 9 18M9 2a8 8 0 0 1 8 8c0 1.975-.719 3.78-1.905 5.175a.75.75 0 0 1-1.204.018l-1.509-1.971a.75.75 0 0 1 .596-1.206h1.674a6 6 0 1 0-11.304 0h1.68a.75.75 0 0 1 .596 1.206l-1.507 1.971a.75.75 0 0 1-1.133.07l-.003.004A8 8 0 0 1 9 2"/><rect width="6" height="2" x="6" y="14" fill-opacity="0.5" rx="1"/><path d="M8.3 6.318c.246-.64 1.154-.64 1.4 0L10.732 9h-.002a2 2 0 1 1-3.46 0h-.001z"/><g fill-opacity="0.5"><circle cx="5" cy="10.25" r="0.75"/><circle cx="13" cy="10.25" r="0.75"/><circle cx="6" cy="7.25" r="0.75"/><circle cx="12" cy="7.25" r="0.75"/></g>',
  ],
  volumeHigh: [
    "currentColor",
    '<path d="M15.6 3.3c-.4-.4-1-.4-1.4 0s-.4 1 0 1.4C15.4 5.9 16 7.4 16 9s-.6 3.1-1.8 4.3c-.4.4-.4 1 0 1.4.2.2.5.3.7.3.3 0 .5-.1.7-.3C17.1 13.2 18 11.2 18 9s-.9-4.2-2.4-5.7"/><path d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752m10.568.59a.91.91 0 0 1 0-1.316.91.91 0 0 1 1.316 0c1.203 1.203 1.47 2.216 1.522 3.208q.012.255.011.51c0 1.16-.358 2.733-1.533 3.803a.7.7 0 0 1-.298.156c-.382.106-.873-.011-1.018-.156a.91.91 0 0 1 0-1.316c.57-.57.995-1.551.995-2.487 0-.944-.26-1.667-.995-2.402"/>',
  ],
  volumeLow: [
    "currentColor",
    '<path d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752m10.568.59a.91.91 0 0 1 0-1.316.91.91 0 0 1 1.316 0c1.203 1.203 1.47 2.216 1.522 3.208q.012.255.011.51c0 1.16-.358 2.733-1.533 3.803a.7.7 0 0 1-.298.156c-.382.106-.873-.011-1.018-.156a.91.91 0 0 1 0-1.316c.57-.57.995-1.551.995-2.487 0-.944-.26-1.667-.995-2.402"/>',
  ],
  volumeOff: [
    "currentColor",
    '<path d="M.714 6.008h3.072l4.071-3.857c.5-.376 1.143 0 1.143.601V15.28c0 .602-.643.903-1.143.602l-4.071-3.858H.714c-.428 0-.714-.3-.714-.752V6.76c0-.451.286-.752.714-.752M14.5 7.586l-1.768-1.768a1 1 0 1 0-1.414 1.414L13.085 9l-1.767 1.768a1 1 0 0 0 1.414 1.414l1.768-1.768 1.768 1.768a1 1 0 0 0 1.414-1.414L15.914 9l1.768-1.768a1 1 0 0 0-1.414-1.414z"/>',
  ],
  check: ["none", '<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 10.455 6.5 13 14 5"/>'],
  stepPrev: ["currentColor", '<path d="M3 3h2v10H3zM13 3v10L6 8z"/>', "0 0 16 16"],
  stepNext: ["currentColor", '<path d="M11 3h2v10h-2zM3 3l7 5-7 5z"/>', "0 0 16 16"],
} as const;

export type IconName = keyof typeof ICONS;

export const icon = (h: HtmlBuilder<Message>, name: IconName): Html => {
  const [fill, inner, box = "0 0 18 18"] = ICONS[name] as readonly [string, string, string?];
  return h.svg([h.ViewBox(box), h.Fill(fill), h.AriaHidden(true), h.InnerHTML(inner)]);
};

// 右の列のアイコン（今の画面の SideIcon と同じ）。隠しているときは右の列を塗らない
export const sideIcon = (h: HtmlBuilder<Message>, hidden: boolean): Html =>
  h.svg(
    [h.ViewBox("0 0 16 16"), h.Width("16"), h.Height("16"), h.Fill("none"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.AriaHidden(true)],
    [
      h.rect([h.X("2"), h.Y("3"), h.Width("12"), h.Height("10"), h.Rx("1.5")]),
      hidden ? h.path([h.D("M10 3v10")]) : h.path([h.D("M10 3v10h3.5a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5z"), h.Fill("currentColor")]),
    ],
  );
