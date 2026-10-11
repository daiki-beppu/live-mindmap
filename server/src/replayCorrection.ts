// 再生での発言の補正（Issue #644）。記録したログの vocab の行（読み）・screen の lines・remark の raw と words から、
// 今の規則（correctRemark・screenCandidates）で発言を直し直す。読みのサブコマンドもモデルも呼ばない（読みは vocab の行から同期で引く）。
// ライブの語彙の扱い（sessionSinks.ts）と同じ規則: 語彙は読みのある語だけ、画面の語は規則で取った候補のうち未要求の語だけ。
import { Context, Effect, Ref } from "effect";
import {
  correctRemark,
  screenCandidates,
  type LogEvent,
  type Session,
  type VocabularyWord,
} from "./core/index.ts";

// 補正の部品。テストで差し替えて、規則を変えると再生の結果が変わることを確かめる
export const RemarkCorrection = Context.Reference("live-mindmap/RemarkCorrection", {
  defaultValue: (): typeof correctRemark => correctRemark,
});

type VocabLine = Extract<LogEvent, { type: "vocab" }>;

export const withReplayCorrection = Effect.fnUntraced(function* (
  session: Session,
  options: {
    readonly vocab: ReadonlyArray<VocabLine>;
    readonly commonWords: ReadonlySet<string>;
    readonly appendLog: (event: LogEvent) => Effect.Effect<void>;
  },
) {
  const correct = yield* RemarkCorrection;
  const { commonWords, appendLog } = options;
  const words = options.vocab.flatMap((line) => line.words);

  // 表記 → 読み（最初に出た null でない値）
  const readingOf = new Map<string, string>();
  for (const w of words) if (w.romaji !== null && !readingOf.has(w.surface)) readingOf.set(w.surface, w.romaji);

  const userSurfaces = [...new Set(words.filter((w) => w.source === "user").map((w) => w.surface))];
  const usable = (surfaces: ReadonlyArray<string>): VocabularyWord[] =>
    surfaces.flatMap((surface) => {
      const romaji = readingOf.get(surface);
      return romaji === undefined ? [] : [{ surface, romaji }];
    });

  const vocabulary = yield* Ref.make<ReadonlyArray<VocabularyWord>>(usable(userSurfaces));
  const screenState = yield* Ref.make<{ seen: ReadonlyMap<string, number>; requested: ReadonlySet<string> }>({
    seen: new Map(),
    requested: new Set(userSurfaces),
  });

  const record = (surfaces: ReadonlyArray<string>, source: "user" | "screen") =>
    appendLog({ type: "vocab", words: surfaces.map((surface) => ({ surface, romaji: readingOf.get(surface) ?? null, source })) });
  if (userSurfaces.length > 0) yield* record(userSurfaces, "user");

  return {
    ...session,
    push: (remark, original) =>
      Effect.gen(function* () {
        if (original === undefined) return yield* session.push(remark);
        const text = correct(yield* Ref.get(vocabulary), original.raw, original.words, commonWords).text;
        yield* session.push({ ...remark, text }, original);
      }),
    pushScreen: (change, lines) =>
      Effect.gen(function* () {
        yield* session.pushScreen(change, lines);
        if (lines === undefined || lines.length === 0) return;
        const news = yield* Ref.modify(screenState, (state) => {
          const out = screenCandidates(state.seen, lines);
          const fresh = out.candidates.filter((c) => !state.requested.has(c));
          return [fresh, { seen: out.seen, requested: new Set([...state.requested, ...fresh]) }];
        });
        if (news.length === 0) return;
        yield* record(news, "screen");
        const added = usable(news);
        yield* Ref.update(vocabulary, (current) => [...current, ...added.filter((a) => !current.some((c) => c.surface === a.surface))]);
      }),
  } satisfies Session;
});

