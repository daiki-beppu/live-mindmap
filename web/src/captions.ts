import { Option, Schema } from "effect";
import { CaptionBubble, continuesAfter, speakerName, type SpeakerNames } from "../../server/src/core/index.ts";

// ここから会議中の字幕（Issue #1022）。サーバーの吹き出し（CaptionBubble）を、表示の吹き出しに直す純粋な状態。時計は持たず、時刻（ミリ秒）は引数で受ける。

// 見せる吹き出しの数（末尾から）
export const CAPTION_VISIBLE_BUBBLES = 3;
// 吹き出しの幅（字幕の列に対する割合）。文字の量で変えない
export const CAPTION_BUBBLE_WIDTH = 0.8;
// ラベルが届くまで文字を待たせる上限（ミリ秒）。仮のラベルが届けば、その時点で待ちは終わる
export const CAPTION_LABEL_WAIT_MS = 600;
// 仮のラベルのまま確定しない吹き出しの名前を、「相手」だけにするまでの時間（ミリ秒）
export const CAPTION_PROVISIONAL_LIMIT_MS = 3000;
// 位置が変わるときに滑らせる時間（ミリ秒）
export const CAPTION_SLIDE_MS = 250;

const UNKNOWN_SPEAKER = "相手";
// 名前の色の数（番号 0 は名前の無い・読めない名前の色）
export const CAPTION_PALETTE_SIZE = 5;

// 出すと決めた先。決めたら動かさない（後から届くラベルで、続けた文字を動かさない）
const Placement = Schema.Union([Schema.Struct({ kind: Schema.Literal("own") }), Schema.Struct({ kind: Schema.Literal("continue"), into: Schema.String })]);
const Entry = Schema.Struct({
  bubble: CaptionBubble,
  // 吹き出しの id を最初に受けた時刻。待ちの上限と 3 秒の規則は、この時刻から数える（受け直しても数え直さない）
  receivedAt: Schema.Finite,
  placement: Schema.Option(Placement),
});
type Entry = typeof Entry["Type"];

export const CaptionState = Schema.Struct({
  entries: Schema.Array(Entry),
  // 最後に状態へ時刻を渡した時刻。過ぎた期限を数え直さないために持つ
  clock: Schema.Finite,
});
export type CaptionState = typeof CaptionState["Type"];

// 見返しの吹き出しの状態。ラベルを待たず、全部をその場で出す（話者なしは「相手」、話者ありは確定。仮のラベルは作らない）
export const settledCaptions = (bubbles: readonly CaptionBubble[]): CaptionState => ({
  entries: bubbles.map((bubble) => ({ bubble, receivedAt: 0, placement: Option.some({ kind: "own" as const }) })),
  clock: 0,
});

export const createCaptionState = (): CaptionState => ({ entries: [], clock: 0 });

const isShown = (e: Entry): boolean => e.bubble.label !== "なし" || Option.isSome(e.placement);

// 期限が来た「なし」の文字の行き先を決める。同じトラックの直前の吹き出し（出ているもの）との間が短ければ続け、空いていれば新しい吹き出しにする。
// 直前の吹き出しがまだ出ていなければ、その後に決める
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

// 続けた先をたどって、吹き出しとして出ているものを返す
function rootOf(entry: Entry, all: readonly Entry[], effective: (e: Entry) => Entry["placement"]): Entry {
  const placement = effective(entry);
  if (Option.isSome(placement) && placement.value.kind === "continue") {
    const into = placement.value.into;
    const target = all.find((e) => e.bubble.id === into);
    if (target !== undefined) return rootOf(target, all, effective);
  }
  return entry;
}

// 区間が届く前に 1 つで送られた吹き出しから、話者で分かれて生まれた吹き出し（splitFrom）の受け方。もとの吹き出しを受けた時刻を引き継ぎ（待ちを最大 CAPTION_LABEL_WAIT_MS に保つ）、
// もとの吹き出しをもう出していれば、出た文字を動かさないよう、その続きとして出す。まだ出していなければ、これまでの規則で決める。もとの吹き出しを知らなければ、splitFrom は無視する
function splitOrigin(entries: readonly Entry[], bubble: CaptionBubble): Entry | undefined {
  return bubble.splitFrom === undefined ? undefined : entries.find((e) => e.bubble.id === bubble.splitFrom);
}

function placementOf(known: Entry | undefined, origin: Entry | undefined, entries: readonly Entry[], bubble: CaptionBubble): Entry["placement"] {
  if (known?.placement !== undefined && Option.isSome(known.placement)) return known.placement;
  if (known === undefined && origin !== undefined && isShown(origin)) return Option.some({ kind: "continue" as const, into: rootOf(origin, entries, (e) => e.placement).bubble.id });
  return bubble.label === "なし" ? Option.none() : Option.some({ kind: "own" as const });
}

// サーバーのフレーム（吹き出しの並びの全体）を受ける。次のフレームに無い吹き出しは外れる。同じ id の吹き出しは、受けた時刻と出すと決めた先を保って、中身だけ更新する。ラベル付きで受けた吹き出しは、そのとき出す先を決める
export function receiveCaptions(state: CaptionState, bubbles: readonly CaptionBubble[], now: number): CaptionState {
  const advanced = advanceCaptions(state, now);
  return {
    clock: advanced.clock,
    entries: bubbles.map((bubble) => {
      const known = advanced.entries.find((e) => e.bubble.id === bubble.id);
      // ラベル付きで受けた吹き出しは、その時点で出す先を決める。後でラベルが「なし」に戻っても、出た吹き出しを消さない
      const origin = splitOrigin(advanced.entries, bubble);
      return { bubble, receivedAt: known?.receivedAt ?? origin?.receivedAt ?? now, placement: placementOf(known, origin, advanced.entries, bubble) };
    }),
  };
}

// 次に状態が変わる時刻（ミリ秒）。待ちの上限か 3 秒の規則のうち、まだ来ていない早い方。無ければ undefined
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
  // 名前の欄の文字（名前が付いていれば名前）。自分と、同じ人が続くときの 2 つ目以降は無い
  name: Schema.Option(Schema.String),
  // 名前を付けられる欄のとき、サーバーへ送る話者のラベル（Issue #1026）。値があるのは、確定した相手のラベルの欄だけ
  // （自分・同じ人が続くときの 2 つ目以降・仮のラベル・「相手」だけの欄・話者なしは無い）。名前が付いていても、ここはラベルのまま
  label: Schema.Option(Schema.String),
  nameState: Schema.Literals(["provisional", "settled"]),
  // 名前ごとの色の番号（0 〜 CAPTION_PALETTE_SIZE - 1）。同じ名前は同じ色
  colorIndex: Schema.Int,
  text: Schema.String,
  // text の先頭から何文字までが確定か。残りは途中結果
  settledLength: Schema.Int,
});
export type DisplayBubble = typeof DisplayBubble["Type"];

// セッションの画面に渡す字幕。会議中も見返しも、話者つきの吹き出し
export const Captions = Schema.TaggedStruct("Bubbles", { bubbles: Schema.Array(DisplayBubble) });
export type Captions = typeof Captions["Type"];
export const NO_CAPTIONS: Captions = { _tag: "Bubbles", bubbles: [] };

const colorIndexOf = (name: string): number => {
  const letters = /^相手 ([A-Z]+)$/.exec(name)?.[1];
  if (letters === undefined) return 0;
  return ([...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) % (CAPTION_PALETTE_SIZE - 1)) + 1;
};

const joinText = (left: string, right: string) => (/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : left + right);

// 表示する吹き出し。start の順に 1 列に並べ、末尾の CAPTION_VISIBLE_BUBBLES 個だけを出す。相手は左、自分は右。
// 名前の欄の文字は、状態に入れず、表示のたびに名前の表（names）から導く（名前が付いたら、それまでの吹き出しも名前になる）。
// 色と、同じ人が続くときの省略は、名前ではなくラベルで決める（同じ名前が 2 つのラベルに付いても、まとめない）
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
          // 前に途中の分が残っていれば、後ろの文字は全部途中。前が全部確定なら、後ろの確定の分だけ延びる
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
    // 名前を付けられるのは、確定した相手のラベルの欄（ラベルの無い「相手」には付けない）
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

// 動きを除いた位置（offsetTop）の差。moved は「前の位置 − 今の位置」（前の見かけの位置へ戻す向き）で、動かないものは含めない。
// entered は前に無かった吹き出し（薄く現れる）。消えた吹き出しは無視する。差は渡された位置だけで決まる
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
