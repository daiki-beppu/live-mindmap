// 字幕の吹き出しの左の「名前の欄」。固定幅の欄に小さく出す（欄の背は字幕を伸ばさない）。文字の色だけを話者ごとに変え、塗りやバッジは使わない。
// 後で押して名前を手で入れられるようになる欄なので、欄を作る場所はこの 1 つの関数に限る（Issue #1022）
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { DisplayBubble } from "../../captions.ts";
import type { Message } from "./message.ts";

type H = HtmlBuilder<Message>;

// 名前の欄の色の番号ごとの文字色（控えめな色相。仮のときの薄さは opacity で出す）
export const SPEAKER_NAME_COLORS = [
  "text-gray-500",
  "text-[#2f6fb3]",
  "text-[#b3622f]",
  "text-[#2f8f6a]",
  "text-[#8a4fb3]",
] as const;

// 名前が無い吹き出し（自分・同じ人が続くとき）でも欄は残す。欄が消えると吹き出しの位置が動く
export const speakerNameCell = (h: H, bubble: DisplayBubble): Html =>
  h.div(
    [
      h.Class(`captions__name flex-none w-[var(--caption-name-width)] text-[12px] leading-[1.5] truncate ${SPEAKER_NAME_COLORS[bubble.colorIndex] ?? SPEAKER_NAME_COLORS[0]} ${bubble.nameState === "provisional" ? "opacity-50" : ""}`),
    ],
    Option.match(bubble.name, { onNone: () => [], onSome: (name) => [name] }),
  );
