import { Input } from "@foldkit/ui";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { DisplayBubble } from "../../captions.ts";
import { Message } from "./message.ts";

type H = HtmlBuilder<Message>;

export const SPEAKER_NAME_COLORS = [
  "text-gray-500",
  "text-[#2f6fb3]",
  "text-[#b3622f]",
  "text-[#2f8f6a]",
  "text-[#8a4fb3]",
] as const;

type NameEdit = { readonly bubble: DisplayBubble; readonly label: string; readonly draft: string };

export const NAME_INPUT_ID = "speaker-name-input";

const cellClass = (bubble: DisplayBubble): string =>
  `captions__name flex-none w-[var(--caption-name-width)] text-[12px] leading-[1.5] truncate ${SPEAKER_NAME_COLORS[bubble.colorIndex] ?? SPEAKER_NAME_COLORS[0]} ${bubble.nameState === "provisional" ? "opacity-50" : ""}`;

// 確定は form の submit にする（日本語入力の変換中の Enter で途中の文字を送らない）
const nameInputView = (h: H, bubble: DisplayBubble, edit: NameEdit): Html =>
  h.div(
    [h.Class(`${cellClass(bubble)} pointer-events-auto`)],
    [
      h.form(
        [h.Class("m-0 w-full"), h.OnSubmit(Message.SubmittedSpeakerName())],
        [
          Input.view(
            {
              id: NAME_INPUT_ID,
              value: edit.draft,
              onInput: (draft) => Message.ChangedSpeakerNameDraft({ draft }),
              toView: (attributes) =>
                h.input([
                  ...attributes.input,
                  h.Class("block w-full min-w-0 box-border m-0 p-0 text-[12px] leading-[1.5] text-inherit bg-transparent border-0 outline-none [border-bottom:1px_solid_currentColor]"),
                  h.AriaLabel("話者の名前"),
                  h.OnBlur(Message.CancelledSpeakerName()),
                  h.OnKeyDownPreventDefault((key) => (key === "Escape" ? Option.some(Message.CancelledSpeakerName()) : Option.none())),
                ]),
            },
            h,
          ),
        ],
      ),
    ],
  );

export const speakerNameCell = (h: H, bubble: DisplayBubble, nameEdit: Option.Option<NameEdit>): Html => {
  const text = Option.match(bubble.name, { onNone: () => [], onSome: (name) => [name] });
  const editing = Option.filter(nameEdit, (edit) => edit.bubble.id === bubble.id);
  if (Option.isSome(editing)) return nameInputView(h, bubble, editing.value);
  return Option.match(bubble.label, {
    onNone: () => h.div([h.Class(cellClass(bubble))], text),
    onSome: (label) =>
      h.button(
        [
          h.Type("button"),
          h.Class(`${cellClass(bubble)} pointer-events-auto m-0 p-0 bg-transparent border-0 text-left cursor-pointer hover:underline`),
          h.AriaLabel(`${label}に名前を付ける`),
          h.OnClick(Message.PressedSpeakerName({ bubbleId: bubble.id, label })),
        ],
        text,
      ),
  });
};
