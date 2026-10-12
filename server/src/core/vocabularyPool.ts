// 全セッションをまたぐ語彙の溜まり（Issue #645）の出入り。I/O を持たない純粋な関数（Formal Spec の finish）。
// ライブの終了時と cli restore は、同じログから同じ関数（sessionVocabularyUsage → finishPoolSession）を通す。
import { Effect, Predicate, Schema, Stream } from "effect";
import { normalizeSurface } from "./correction.ts";
import { escapeCell } from "./markdownTable.ts";
import { InvalidLogEvent, RemarkEvent, VocabEvent, VocabPoolEvent } from "./session.ts";

// 最後に話されてからこのセッション数のあいだ話されなかった語を落とす（足した語を除く）。計測の根拠がない置き値で、ここ 1 か所で変える
export const POOL_DROP_AFTER_SESSIONS = 20;

export const PoolWord = Schema.Struct({
  surface: Schema.String,
  romaji: Schema.NullOr(Schema.String), // 読みを作れなかった足した語は null（補正には使わない）
  source: Schema.Literals(["spoken", "user"]), // 話された語か、利用者が足した語か
  lastSpoken: Schema.Int, // 最後に話されたセッションの番号（0 は一度も話されていない）
});
export type PoolWord = typeof PoolWord["Type"];

export const VocabularyPool = Schema.Struct({
  sessions: Schema.Int, // 始めたセッションの数
  words: Schema.Array(PoolWord),
});
export type VocabularyPool = typeof VocabularyPool["Type"];

export const emptyPool: VocabularyPool = { sessions: 0, words: [] };

// セッションの開始: 始めたセッションの数を 1 つ進め、その値をこのセッションの番号にする。語彙に入れる溜まりの語は、読みごとそのまま返す
export function beginPoolSession(pool: VocabularyPool): { pool: VocabularyPool; session: number; words: ReadonlyArray<PoolWord> } {
  const session = pool.sessions + 1;
  return { pool: { sessions: session, words: pool.words }, session, words: pool.words };
}

// そのセッションでの語ごとの使われ方。spoken は直した後の発言に出た語、user は利用者が足した語
export type WordUsage = { readonly surface: string; readonly romaji: string | null; readonly spoken: boolean; readonly user: boolean };
export type SessionUsage = { readonly session: number; readonly words: ReadonlyArray<WordUsage> };

// セッションの終了（Formal Spec の finish）。話された語と足した語を溜まりに入れ、古くなった語を落とす。語数の上限は設けない
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
    // 溜まりにある読みを優先する。読みが無い語のうち、話された語は入れない（直しに使えず、残す理由が無い）。
    // 利用者が足した語は読みが無くても残す（読みを補正に使わないだけで、足した語を溜まりから落とす理由にならない）
    const romaji = before?.romaji ?? now?.romaji ?? null;
    if (romaji === null && !user) return [];
    if (!user && sessions - lastSpoken >= POOL_DROP_AFTER_SESSIONS) return [];
    return [{ surface, romaji, source: user ? "user" : "spoken", lastSpoken }];
  });
  return { sessions, words };
}

// cli vocab forget: 表記が完全一致する語を除いた溜まり。無ければ undefined。正規化では照合せず、sessions は変えない。消した語は覚えない
export function forgetPoolWord(pool: VocabularyPool, surface: string): VocabularyPool | undefined {
  if (!pool.words.some((w) => w.surface === surface)) return undefined;
  return { sessions: pool.sessions, words: pool.words.filter((w) => w.surface !== surface) };
}

const POOL_SOURCE_LABELS = { spoken: "話された語", user: "足した語" } as const;
const NEVER_SPOKEN = "未";

// cli vocab list: 語ごとに 1 行の Markdown の表（formatTable と同じ書き方）。語が無ければ空だと分かる 1 行
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

// ログの行から、そのセッションの番号と語ごとの使われ方を導く。話されたかは直した後の発言（remark.text）を NFKC・小文字でそろえて比べる。
// vocab-pool の行（そのセッションの番号）が無いログ（play のフォルダ・古いログ）は undefined。知らない種類の行は読み飛ばす。
// 行は 2 回走査し、全件は保持しない。1 回目は vocab-pool・vocab・remark を検証して番号と語ごとの状態を集め、
// 2 回目は remark だけを読んで、まだ話されていない語を照合する（vocab の行が発言より後ろにあっても、その語を判定できる）
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
