import { Option, Schema } from "effect";
import { CaptionBubble, continuesAfter, speakerName, type SpeakerNames } from "../../server/src/core/index.ts";

export const CAPTION_VISIBLE_BUBBLES = 3;
export const CAPTION_BUBBLE_WIDTH = 0.8;
export const CAPTION_LABEL_WAIT_MS = 600;
export const CAPTION_PROVISIONAL_LIMIT_MS = 3000;
export const CAPTION_SLIDE_MS = 250;

const UNKNOWN_SPEAKER = "相手";
export const CAPTION_PALETTE_SIZE = 5;

const Placement = Schema.Union([Schema.Struct({ kind: Schema.Literal("own") }), Schema.Struct({ kind: Schema.Literal("continue"), into: Schema.String })]);
const Entry = Schema.Struct({
  bubble: CaptionBubble,
  receivedAt: Schema.Finite,
  placement: Schema.Option(Placement),
});
type Entry = typeof Entry["Type"];

export const CaptionState = Schema.Struct({
  entries: Schema.Array(Entry),
  clock: Schema.Finite,
});
export type CaptionState = typeof CaptionState["Type"];

export const settledCaptions = (bubbles: readonly CaptionBubble[]): CaptionState => ({
  entries: bubbles.map((bubble) => ({ bubble, receivedAt: 0, placement: Option.some({ kind: "own" as const }) })),
  clock: 0,
});

export const createCaptionState = (): CaptionState => ({ entries: [], clock: 0 });

const isShown = (e: Entry): boolean => e.bubble.label !== "なし" || Option.isSome(e.placement);

export function advanceCaptions(state: CaptionState, now: number): CaptionState {
  const clock = Math.max(state.clock, now);
  const ordered = [...state.entries].sort((a, b) => a.bubble.start - b.bubble.start);
  const decided = new Map<string, Entry["placement"]>();
  const effective = (e: Entry) => decided.get(e.bubble.id) ?? e.placement;
  ordered.forEach((e, i) => {
    if (e.bubble.label !== "なし" || Option.isSome(e.placement) || now - e.receivedAt < CAPTION_LABEL_WAIT_MS) return;
    const previous = ordered.slice(0, i).reverse().find((p) => p.bubble.track === e.bubble.track);
    if (previous === undefined) return void decided.set(e.bubble.id, Option.some({ kind: "own" as const }));
    if (previous.bubble.label === "なし" && Option.isNone(effective(previous))) return;
    const root = rootOf(previous, ordered, effective);
    decided.set(e.bubble.id, Option.some(continuesAfter(previous.bubble.end, e.bubble.start) ? { kind: "continue" as const, into: root.bubble.id } : { kind: "own" as const }));
  });
  if (decided.size === 0 && clock === state.clock) return state;
  return { entries: state.entries.map((e) => ({ ...e, placement: effective(e) })), clock };
}

function rootOf(entry: Entry, all: readonly Entry[], effective: (e: Entry) => Entry["placement"]): Entry {
  const placement = effective(entry);
  if (Option.isSome(placement) && placement.value.kind === "continue") {
    const into = placement.value.into;
    const target = all.find((e) => e.bubble.id === into);
    if (target !== undefined) return rootOf(target, all, effective);
  }
  return entry;
}

function splitOrigin(entries: readonly Entry[], bubble: CaptionBubble): Entry | undefined {
  return bubble.splitFrom === undefined ? undefined : entries.find((e) => e.bubble.id === bubble.splitFrom);
}

function placementOf(known: Entry | undefined, origin: Entry | undefined, entries: readonly Entry[], bubble: CaptionBubble): Entry["placement"] {
  if (known?.placement !== undefined && Option.isSome(known.placement)) return known.placement;
  if (known === undefined && origin !== undefined && isShown(origin)) return Option.some({ kind: "continue" as const, into: rootOf(origin, entries, (e) => e.placement).bubble.id });
  return bubble.label === "なし" ? Option.none() : Option.some({ kind: "own" as const });
}

export function receiveCaptions(state: CaptionState, bubbles: readonly CaptionBubble[], now: number): CaptionState {
  const advanced = advanceCaptions(state, now);
  return {
    clock: advanced.clock,
    entries: bubbles.map((bubble) => {
      const known = advanced.entries.find((e) => e.bubble.id === bubble.id);
      const origin = splitOrigin(advanced.entries, bubble);
      return { bubble, receivedAt: known?.receivedAt ?? origin?.receivedAt ?? now, placement: placementOf(known, origin, advanced.entries, bubble) };
    }),
  };
}

export function nextCaptionDeadline(state: CaptionState): number | undefined {
  const deadlines = state.entries.flatMap((e): number[] => {
    if (e.bubble.label === "仮") return [e.receivedAt + CAPTION_PROVISIONAL_LIMIT_MS];
    if (e.bubble.label === "なし" && Option.isNone(e.placement)) return [e.receivedAt + CAPTION_LABEL_WAIT_MS];
    return [];
  });
  const upcoming = deadlines.filter((d) => d > state.clock);
  return upcoming.length === 0 ? undefined : Math.min(...upcoming);
}

export const DisplayBubble = Schema.Struct({
  id: Schema.String,
  side: Schema.Literals(["left", "right"]),
  name: Schema.Option(Schema.String),
  label: Schema.Option(Schema.String),
  nameState: Schema.Literals(["provisional", "settled"]),
  colorIndex: Schema.Int,
  text: Schema.String,
  settledLength: Schema.Int,
});
export type DisplayBubble = typeof DisplayBubble["Type"];

export const Captions = Schema.TaggedStruct("Bubbles", { bubbles: Schema.Array(DisplayBubble) });
export type Captions = typeof Captions["Type"];
export const NO_CAPTIONS: Captions = { _tag: "Bubbles", bubbles: [] };

const colorIndexOf = (name: string): number => {
  const letters = /^相手 ([A-Z]+)$/.exec(name)?.[1];
  if (letters === undefined) return 0;
  return ([...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) % (CAPTION_PALETTE_SIZE - 1)) + 1;
};

const joinText = (left: string, right: string) => (/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : left + right);

export function displayBubbles(state: CaptionState, now: number, names: SpeakerNames = {}): DisplayBubble[] {
  const ordered = [...state.entries].sort((a, b) => a.bubble.start - b.bubble.start);
  const ids = new Set(ordered.map((e) => e.bubble.id));
  const continuedInto = (e: Entry): string | undefined =>
    Option.isSome(e.placement) && e.placement.value.kind === "continue" && ids.has(e.placement.value.into) ? e.placement.value.into : undefined;
  const heads = ordered.filter((e) => isShown(e) && continuedInto(e) === undefined);
  const full = heads.map((head) => {
    const joined = ordered
      .filter((e) => continuedInto(e) === head.bubble.id)
      .reduce(
        (acc, e) => {
          const text = joinText(acc.text, e.bubble.text);
          const settledLength = acc.settledLength < acc.text.length ? acc.settledLength : text.length - e.bubble.text.length + e.bubble.settledLength;
          return { text, settledLength };
        },
        { text: head.bubble.text, settledLength: head.bubble.settledLength },
      );
    return { head, ...joined };
  });
  const visible = full.slice(-CAPTION_VISIBLE_BUBBLES);
  let previousName: string | undefined;
  return visible.map(({ head, text, settledLength }) => {
    const { track, speaker, label } = head.bubble;
    const limited = label === "仮" && now - head.receivedAt >= CAPTION_PROVISIONAL_LIMIT_MS;
    const name = track === "自分" ? undefined : ((label !== "なし" && !limited ? speaker : undefined) ?? UNKNOWN_SPEAKER);
    const shown = name !== previousName ? name : undefined;
    previousName = name;
    const nameable = shown !== undefined && label === "確定" && name !== UNKNOWN_SPEAKER ? shown : undefined;
    return {
      id: head.bubble.id,
      side: track === "自分" ? "right" : "left",
      name: Option.fromNullishOr(shown === undefined ? undefined : (speakerName(shown, names) ?? shown)),
      label: Option.fromNullishOr(nameable),
      nameState: label === "仮" && !limited ? "provisional" : "settled",
      colorIndex: name === undefined ? 0 : colorIndexOf(name),
      text,
      settledLength,
    };
  });
}

export function slideDeltas(previous: ReadonlyMap<string, number>, current: ReadonlyMap<string, number>): { moved: Map<string, number>; entered: string[] } {
  const moved = new Map<string, number>();
  const entered: string[] = [];
  for (const [id, top] of current) {
    const before = previous.get(id);
    if (before === undefined) entered.push(id);
    else if (before !== top) moved.set(id, before - top);
  }
  return { moved, entered };
}
