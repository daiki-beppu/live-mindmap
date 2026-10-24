import { Effect, Predicate, Schema, Stream } from "effect";
import { normalizeSurface } from "./correction.ts";
import { escapeCell } from "./markdownTable.ts";
import { InvalidLogEvent, RemarkEvent, VocabEvent, VocabPoolEvent } from "./session.ts";

export const POOL_DROP_AFTER_SESSIONS = 20;

export const PoolWord = Schema.Struct({
  surface: Schema.String,
  romaji: Schema.NullOr(Schema.String),
  source: Schema.Literals(["spoken", "user"]),
  lastSpoken: Schema.Int,
});
export type PoolWord = typeof PoolWord["Type"];

export const VocabularyPool = Schema.Struct({
  sessions: Schema.Int,
  words: Schema.Array(PoolWord),
});
export type VocabularyPool = typeof VocabularyPool["Type"];

export const emptyPool: VocabularyPool = { sessions: 0, words: [] };

export function beginPoolSession(pool: VocabularyPool): { pool: VocabularyPool; session: number; words: ReadonlyArray<PoolWord> } {
  const session = pool.sessions + 1;
  return { pool: { sessions: session, words: pool.words }, session, words: pool.words };
}

export type WordUsage = { readonly surface: string; readonly romaji: string | null; readonly spoken: boolean; readonly user: boolean };
export type SessionUsage = { readonly session: number; readonly words: ReadonlyArray<WordUsage> };

export function finishPoolSession(pool: VocabularyPool, usage: SessionUsage): VocabularyPool {
  const sessions = Math.max(pool.sessions, usage.session);
  const prior = new Map(pool.words.map((w) => [w.surface, w] as const));
  const used = new Map(usage.words.map((w) => [w.surface, w] as const));
  const surfaces = [...new Set([...prior.keys(), ...usage.words.filter((w) => w.spoken || w.user).map((w) => w.surface)])];
  const words = surfaces.flatMap((surface): PoolWord[] => {
    const before = prior.get(surface);
    const now = used.get(surface);
    const user = before?.source === "user" || now?.user === true;
    const lastSpoken = now?.spoken === true ? Math.max(before?.lastSpoken ?? 0, usage.session) : (before?.lastSpoken ?? 0);
    const romaji = before?.romaji ?? now?.romaji ?? null;
    if (romaji === null && !user) return [];
    if (!user && sessions - lastSpoken >= POOL_DROP_AFTER_SESSIONS) return [];
    return [{ surface, romaji, source: user ? "user" : "spoken", lastSpoken }];
  });
  return { sessions, words };
}

export function forgetPoolWord(pool: VocabularyPool, surface: string): VocabularyPool | undefined {
  if (!pool.words.some((w) => w.surface === surface)) return undefined;
  return { sessions: pool.sessions, words: pool.words.filter((w) => w.surface !== surface) };
}

const POOL_SOURCE_LABELS = { spoken: "話された語", user: "足した語" } as const;
const NEVER_SPOKEN = "未";

export function formatPoolTable(pool: VocabularyPool): string {
  if (pool.words.length === 0) return "溜まりに語がありません\n";
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  const header = ["表記", "出どころ", "最後に話されてからのセッション数"];
  const rows = pool.words.map((w) => [w.surface, POOL_SOURCE_LABELS[w.source], w.lastSpoken === 0 ? NEVER_SPOKEN : String(pool.sessions - w.lastSpoken)]);
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}

const typeOf = (event: unknown): unknown => (Predicate.isObject(event) && "type" in event ? event.type : undefined);
const decodeRemark = Schema.decodeUnknownEffect(RemarkEvent);
const decodeVocab = Schema.decodeUnknownEffect(VocabEvent);
const decodePoolSession = Schema.decodeUnknownEffect(VocabPoolEvent);

export const sessionVocabularyUsage = Effect.fnUntraced(function* <E>(events: Stream.Stream<unknown, E>): Effect.fn.Return<SessionUsage | undefined, InvalidLogEvent | E> {
  let session: number | undefined;
  const vocab = new Map<string, { surface: string; romaji: string | null; user: boolean }>();
  let index = -1;
  yield* Stream.runForEach(events, (event) =>
    Effect.gen(function* () {
      index++;
      const invalid = (error: { message: string }) => new InvalidLogEvent({ index, reason: error.message });
      const type = typeOf(event);
      if (type === VocabPoolEvent.fields.type.literal) {
        const e = yield* decodePoolSession(event).pipe(Effect.mapError(invalid));
        session ??= e.session;
      } else if (type === VocabEvent.fields.type.literal) {
        const e = yield* decodeVocab(event).pipe(Effect.mapError(invalid));
        for (const w of e.words) {
          const known = vocab.get(w.surface);
          vocab.set(w.surface, { surface: w.surface, romaji: known?.romaji ?? w.romaji, user: (known?.user ?? false) || w.source === "user" });
        }
      } else if (type === RemarkEvent.fields.type.literal) {
        yield* decodeRemark(event).pipe(Effect.mapError(invalid));
      }
    }),
  );
  if (session === undefined) return undefined;
  const pending = new Map([...vocab.keys()].map((surface) => [surface, normalizeSurface(surface)] as const));
  const spoken = new Set<string>();
  index = -1;
  yield* Stream.runForEach(events, (event) =>
    Effect.gen(function* () {
      index++;
      if (pending.size === 0 || typeOf(event) !== RemarkEvent.fields.type.literal) return;
      const e = yield* decodeRemark(event).pipe(Effect.mapError((error) => new InvalidLogEvent({ index, reason: error.message })));
      const text = normalizeSurface(e.remark.text);
      for (const [surface, normalized] of pending) {
        if (!text.includes(normalized)) continue;
        spoken.add(surface);
        pending.delete(surface);
      }
    }),
  );
  const words = [...vocab.values()].map((w) => ({ surface: w.surface, romaji: w.romaji, spoken: spoken.has(w.surface), user: w.user }));
  return { session, words };
});
