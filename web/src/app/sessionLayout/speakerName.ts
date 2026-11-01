import { Input } from "@foldkit/ui";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { DisplayBubble } from "../../captions.ts";
import { Message } from "./message.ts";

type H = HtmlBuilder<Message>;

export const SPEAKER_NAME_COLORS = [
  "var(--color-gray-500)",
  "#2f6fb3",
  "#b3622f",
  "#2f8f6a",
  "#8a4fb3",
] as const;

type NameEdit = { readonly bubble: DisplayBubble; readonly label: string; readonly draft: string };

export const NAME_INPUT_ID = "speaker-name-input";

const cellClass = (bubble: DisplayBubble): string =>
  `captions__name ${bubble.nameState === "provisional" ? "captions__name--provisional" : ""}`;

// 確定は form の submit にする（日本語入力の変換中の Enter で途中の文字を送らない）
const nameInputView = (h: H, bubble: DisplayBubble, edit: NameEdit): Html =>
  h.div(
    [h.Class(`${cellClass(bubble)} captions__name--editing`), h.Style({ "--speaker-name-color": SPEAKER_NAME_COLORS[bubble.colorIndex] ?? SPEAKER_NAME_COLORS[0] })],
    [
      h.form(
        [h.Class("captions__name-form"), h.OnSubmit(Message.SubmittedSpeakerName())],
        [
          Input.view(
            {
              id: NAME_INPUT_ID,
              value: edit.draft,
              onInput: (draft) => Message.ChangedSpeakerNameDraft({ draft }),
              toView: (attributes) =>
                h.input([
                  ...attributes.input,
                  h.Class("captions__name-input"),
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
    onNone: () => h.div([h.Class(cellClass(bubble)), h.Style({ "--speaker-name-color": SPEAKER_NAME_COLORS[bubble.colorIndex] ?? SPEAKER_NAME_COLORS[0] })], text),
    onSome: (label) =>
      h.button(
        [
          h.Type("button"),
          h.Class(`${cellClass(bubble)} captions__name--editable`),
          h.Style({ "--speaker-name-color": SPEAKER_NAME_COLORS[bubble.colorIndex] ?? SPEAKER_NAME_COLORS[0] }),
          h.AriaLabel(`${label}に名前を付ける`),
          h.OnClick(Message.PressedSpeakerName({ bubbleId: bubble.id, label })),
        ],
        text,
      ),
  });
};
