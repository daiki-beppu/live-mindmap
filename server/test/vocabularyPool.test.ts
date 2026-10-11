import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import {
  beginPoolSession,
  emptyPool,
  finishPoolSession,
  POOL_DROP_AFTER_SESSIONS,
  sessionVocabularyUsage,
  type VocabularyPool,
} from "../src/core/vocabularyPool.ts";

// Issue #645: 全セッションをまたぐ語彙の溜まり（プール）の出入り。I/O を持たない純粋な関数を、Formal Spec の性質で確かめる。
// - beginPoolSession: セッションの開始。始めたセッションの数を 1 つ進め、そのセッションの番号と、語彙に入れる溜まりの語を返す
// - finishPoolSession: セッションの終了（Formal Spec の finish）。話された語と足した語を溜まりに入れ、古くなった語を落とす
// - sessionVocabularyUsage: ログの行から、そのセッションの番号と、語ごとの「話された／足した」を導く（終了時とcli restoreが同じ関数を通す）
// forget（#646）の性質はこの issue の範囲外。

const K = POOL_DROP_AFTER_SESSIONS;

type Usage = Parameters<typeof finishPoolSession>[1];
const word = (surface: string, flags: { spoken?: boolean; user?: boolean; romaji?: string | null } = {}) => ({
  surface,
  romaji: flags.romaji === undefined ? `yomi-${surface}` : flags.romaji,
  spoken: flags.spoken ?? false,
  user: flags.user ?? false,
});
const usageOf = (session: number, ...words: ReturnType<typeof word>[]): Usage => ({ session, words });
const surfaces = (pool: VocabularyPool) => pool.words.map((w) => w.surface).sort();
const entry = (pool: VocabularyPool, surface: string) => pool.words.find((w) => w.surface === surface);

// セッションを 1 回開いて、usage を使って閉じる
const runSession = (pool: VocabularyPool, words: ReturnType<typeof word>[]) => {
  const begun = beginPoolSession(pool);
  return finishPoolSession(begun.pool, usageOf(begun.session, ...words));
};

describe("定数", () => {
  it("古くなった語を落とすセッション数は 20（置き値。1 か所の定数）", () => {
    expect(POOL_DROP_AFTER_SESSIONS).toBe(20);
  });
});

describe("beginPoolSession（開始）", () => {
  it("空の溜まりから始めると、セッションの番号は 1 で、始めたセッションの数が 1 になり、語は無い", () => {
    expect(beginPoolSession(emptyPool)).toEqual({ pool: { sessions: 1, words: [] }, session: 1, words: [] });
  });

  it("始めたセッションの数を 1 つ進め、溜まりの語を読みごとそのまま返す（語は変えない）", () => {
    const pool: VocabularyPool = {
      sessions: 4,
      words: [
        { surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 3 },
        { surface: "Zendesk", romaji: "zendesuku", source: "user", lastSpoken: 0 },
      ],
    };
    const begun = beginPoolSession(pool);
    expect(begun.session).toBe(5);
    expect(begun.pool).toEqual({ sessions: 5, words: pool.words });
    expect(begun.words).toEqual(pool.words);
  });
});

describe("finishPoolSession（終了）", () => {
  it("話された語は、読みと最後に話されたセッションの番号つきで溜まりに入る（出どころ spoken）", () => {
    const pool = finishPoolSession({ sessions: 1, words: [] }, usageOf(1, word("港南店", { spoken: true, romaji: "kounanten" })));
    expect(pool).toEqual({ sessions: 1, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] });
  });

  it("共有画面に映っただけで話されなかった語（話された印も足した印も無い語）は溜まりに入らない", () => {
    const pool = finishPoolSession({ sessions: 1, words: [] }, usageOf(1, word("Zendesk"), word("港南店", { spoken: true })));
    expect(surfaces(pool)).toEqual(["港南店"]);
  });

  it("利用者が足した語は、話されなくても溜まりに入る（出どころ user、最後に話されたセッションは 0）", () => {
    const pool = finishPoolSession({ sessions: 1, words: [] }, usageOf(1, word("葛西", { user: true, romaji: "kasai" })));
    expect(pool).toEqual({ sessions: 1, words: [{ surface: "葛西", romaji: "kasai", source: "user", lastSpoken: 0 }] });
  });

  it("足した語は、話されなくても、何セッションたっても溜まりから落ちない", () => {
    let pool = runSession(emptyPool, [word("葛西", { user: true })]);
    for (let n = 0; n < K * 3; n++) pool = runSession(pool, [word("葛西")]); // 開始時に carried で入るだけで、話されない
    expect(pool.sessions).toBe(K * 3 + 1);
    expect(entry(pool, "葛西")).toMatchObject({ source: "user" });
  });

  it("話された語は、続く K−1 セッション話されなくても残り、K セッション話されなかった終了時に落ちる", () => {
    let pool = runSession(emptyPool, [word("港南店", { spoken: true })]); // セッション 1 で話された
    for (let n = 2; n <= K; n++) {
      pool = runSession(pool, [word("港南店")]); // 開始時に carried で入っても、話されない
      expect(entry(pool, "港南店")).toBeDefined(); // セッション K（最後に話されてから K−1 セッション）までは残る
    }
    pool = runSession(pool, [word("港南店")]); // セッション K+1: 最後に話されてから K セッションたつ
    expect(entry(pool, "港南店")).toBeUndefined();
    expect(pool.sessions).toBe(K + 1);
  });

  it("溜まりの語が、そのセッションのログに現れなくても、同じ規則で古くなって落ちる", () => {
    let pool: VocabularyPool = { sessions: 1, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] };
    for (let n = 2; n <= K; n++) pool = runSession(pool, []);
    expect(entry(pool, "港南店")).toBeDefined();
    pool = runSession(pool, []);
    expect(entry(pool, "港南店")).toBeUndefined();
  });

  it("途中でもう一度話された語は、最後に話されたセッションの番号が更新され、その分だけ長く残る", () => {
    let pool = runSession(emptyPool, [word("港南店", { spoken: true })]); // セッション 1
    for (let n = 2; n < K; n++) pool = runSession(pool, []);
    pool = runSession(pool, [word("港南店", { spoken: true })]); // セッション K で話された
    expect(entry(pool, "港南店")).toMatchObject({ lastSpoken: K });
    for (let n = K + 1; n < 2 * K; n++) pool = runSession(pool, []); // セッション 2K−1 まで
    expect(entry(pool, "港南店")).toBeDefined();
    pool = runSession(pool, []); // セッション 2K: 最後に話されてから K セッション
    expect(entry(pool, "港南店")).toBeUndefined();
  });

  it("足した語が話されると、最後に話されたセッションが更新される。足した語の印は残る（落ちない）", () => {
    let pool = runSession(emptyPool, [word("葛西", { user: true })]);
    pool = runSession(pool, [word("葛西", { spoken: true })]);
    expect(entry(pool, "葛西")).toMatchObject({ source: "user", lastSpoken: 2 });
  });

  it("話された語を、あとで利用者が足すと、足した語になって落ちなくなる", () => {
    let pool = runSession(emptyPool, [word("港南店", { spoken: true })]);
    pool = runSession(pool, [word("港南店", { user: true })]);
    expect(entry(pool, "港南店")).toMatchObject({ source: "user", lastSpoken: 1 });
    for (let n = 0; n < K * 2; n++) pool = runSession(pool, []);
    expect(entry(pool, "港南店")).toBeDefined();
  });

  it("溜まりにすでに読みがある語は、その読みを使う（今回の読みで上書きしない）。無い語は今回の読みを使う", () => {
    const pool = finishPoolSession(
      { sessions: 2, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] },
      usageOf(2, word("港南店", { spoken: true, romaji: "別の読み" }), word("Zendesk", { spoken: true, romaji: "zendesuku" })),
    );
    expect(entry(pool, "港南店")).toMatchObject({ romaji: "kounanten", lastSpoken: 2 });
    expect(entry(pool, "Zendesk")).toMatchObject({ romaji: "zendesuku" });
  });

  it("読みが作れなかった語（romaji が null）で、溜まりにも無い語は、話された語なら溜まりに入れない（直しに使えず、残す理由が無い）", () => {
    const pool = finishPoolSession(emptyPool, usageOf(1, word("謎", { spoken: true, romaji: null })));
    expect(pool.words).toEqual([]);
  });

  it("読みが作れなかった足した語は、romaji null の足した語として溜まりに残り、何セッションたっても落ちない。user でなくなれば今までどおり除く", () => {
    let pool = finishPoolSession(emptyPool, usageOf(1, word("足した", { user: true, romaji: null })));
    expect(pool.words).toEqual([{ surface: "足した", romaji: null, source: "user", lastSpoken: 0 }]);
    for (let n = 0; n < K * 3; n++) pool = runSession(pool, []);
    expect(entry(pool, "足した")).toMatchObject({ romaji: null, source: "user", lastSpoken: 0 });
  });

  it("溜まりに romaji null の足した語があるとき、後のセッションで読みが分かればその読みで埋まる。溜まりの読みは上書きしない", () => {
    const pool = finishPoolSession(
      { sessions: 2, words: [{ surface: "葛西", romaji: null, source: "user", lastSpoken: 0 }, { surface: "港南店", romaji: "kounanten", source: "user", lastSpoken: 0 }] },
      usageOf(2, word("葛西", { user: true, romaji: "kasai" }), word("港南店", { user: true, romaji: "別" })),
    );
    expect(entry(pool, "葛西")).toMatchObject({ romaji: "kasai", source: "user" });
    expect(entry(pool, "港南店")).toMatchObject({ romaji: "kounanten" });
  });

  it("始めたセッションの数は、溜まりの数とログのセッション番号の大きい方になる", () => {
    expect(finishPoolSession({ sessions: 5, words: [] }, usageOf(3)).sessions).toBe(5);
    expect(finishPoolSession({ sessions: 0, words: [] }, usageOf(3)).sessions).toBe(3);
  });

  it("同じ使われ方で 2 回終えても結果が変わらない（cli restore を繰り返しても溜まりは同じ）", () => {
    const start: VocabularyPool = { sessions: 7, words: [{ surface: "古い", romaji: "furui", source: "spoken", lastSpoken: 2 }] };
    const usage = usageOf(7, word("港南店", { spoken: true }), word("葛西", { user: true }), word("Zendesk"));
    const once = finishPoolSession(start, usage);
    expect(finishPoolSession(once, usage)).toEqual(once);
  });

  it("語数に上限は設けない（落ちない語を 500 語入れても全部残る）", () => {
    const many = Array.from({ length: 500 }, (_, i) => word(`語${i}`, { spoken: true }));
    expect(finishPoolSession(emptyPool, usageOf(1, ...many)).words).toHaveLength(500);
  });

  it("入力の溜まりを書き換えない", () => {
    const start: VocabularyPool = { sessions: 1, words: [{ surface: "港南店", romaji: "kounanten", source: "spoken", lastSpoken: 1 }] };
    const snapshot = structuredClone(start);
    finishPoolSession(start, usageOf(2, word("葛西", { user: true })));
    expect(start).toEqual(snapshot);
  });
});

describe("溜まりの性質（Formal Spec: invPoolOnlySpokenOrUser・invAgedOutDropped・invUserMarkOnlyInPool・invBounded）", () => {
  // 決まった乱数で、語・セッション数を変えながら多数のセッションを回す
  const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("乱数の系列 %i: どのセッションの終了後でも 4 つの性質が成り立つ", (seed) => {
    const random = lcg(seed);
    const names = ["a", "b", "c", "d", "e", "f"];
    let pool: VocabularyPool = emptyPool;
    for (let n = 1; n <= K * 3; n++) {
      const begun = beginPoolSession(pool);
      expect(begun.session).toBe(n);
      const present = new Set(begun.words.map((w) => w.surface));
      const words = names.flatMap((name) => {
        const user = random() < 0.08;
        const spoken = random() < 0.2;
        const onScreen = random() < 0.3;
        if (!user && !spoken && !onScreen && !present.has(name)) return [];
        return [word(name, { user, spoken })];
      });
      pool = finishPoolSession(begun.pool, usageOf(begun.session, ...words));
      // invBounded
      expect(pool.sessions).toBe(n);
      for (const w of pool.words) expect(w.lastSpoken).toBeGreaterThanOrEqual(0);
      for (const w of pool.words) expect(w.lastSpoken).toBeLessThanOrEqual(pool.sessions);
      // invPoolOnlySpokenOrUser
      for (const w of pool.words) expect(w.source === "user" || w.lastSpoken > 0).toBe(true);
      // invAgedOutDropped
      for (const w of pool.words) if (w.source !== "user") expect(pool.sessions - w.lastSpoken).toBeLessThan(K);
      // 同じ表記は 1 語
      expect(new Set(pool.words.map((w) => w.surface)).size).toBe(pool.words.length);
    }
  });
});

describe("sessionVocabularyUsage（ログの行から、そのセッションの語の使われ方を導く）", () => {
  const start = { type: "start", title: "t" };
  const remark = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ type: "remark", remark: { id, track: "相手", start: 0, end: 1, text }, ...extra });
  const vocab = (...words: { surface: string; romaji: string | null; source: "user" | "screen" | "carried" }[]) => ({ type: "vocab", words });
  const usageFromLog = (events: ReadonlyArray<unknown>) => sessionVocabularyUsage(Stream.fromIterable(events));
  const byName = (words: ReadonlyArray<{ surface: string }>) => Object.fromEntries(words.map((w) => [w.surface, w]));

  it.effect("vocab-pool の行のセッション番号と、vocab の行の語ごとの「話された／足した」を返す。話されたかは直した後の発言（remark.text）で決める", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([
      start,
      { type: "vocab-pool", session: 3 },
      vocab(
        { surface: "港南店", romaji: "kounanten", source: "screen" },
        { surface: "Zendesk", romaji: "zendesuku", source: "screen" },
        { surface: "葛西", romaji: "kasai", source: "user" },
        { surface: "渋谷", romaji: null, source: "carried" },
      ),
      // 直して出た語（港南店）：直す前の本文は江南店
      remark("r1", "港南店に行きます", { raw: "江南店に行きます" }),
    ]);
    expect(usage?.session).toBe(3);
    const words = byName(usage!.words);
    expect(words["港南店"]).toEqual({ surface: "港南店", romaji: "kounanten", spoken: true, user: false });
    expect(words["Zendesk"]).toEqual({ surface: "Zendesk", romaji: "zendesuku", spoken: false, user: false });
    expect(words["葛西"]).toEqual({ surface: "葛西", romaji: "kasai", spoken: false, user: true });
    expect(words["渋谷"]).toEqual({ surface: "渋谷", romaji: null, spoken: false, user: false });
    expect(usage!.words).toHaveLength(4);
  }));

  it.effect("vocab の行が発言より後ろにあっても、それより前の発言で話された語と判定する", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([start, { type: "vocab-pool", session: 1 }, remark("r1", "港南店に行きます"), vocab({ surface: "港南店", romaji: "kounanten", source: "user" })]);
    expect(byName(usage!.words)["港南店"]).toMatchObject({ spoken: true, user: true });
  }));

  it.effect("直さずに正しい表記で出た語（raw も words も無い発言）も話された語になる", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([start, { type: "vocab-pool", session: 1 }, vocab({ surface: "港南店", romaji: "kounanten", source: "screen" }), remark("r1", "港南店に行きます")]);
    expect(byName(usage!.words)["港南店"]).toMatchObject({ spoken: true });
  }));

  it.effect("直す前の本文（raw）にしか無い語は話された語にしない（直した後の発言で決める）", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([start, { type: "vocab-pool", session: 1 }, vocab({ surface: "江南店", romaji: "kounanten", source: "screen" }), remark("r1", "港南店に行きます", { raw: "江南店に行きます" })]);
    expect(byName(usage!.words)["江南店"]).toMatchObject({ spoken: false });
  }));

  it.effect("共有画面の lines に出ただけの語は話された語にならない", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([
      start,
      { type: "vocab-pool", session: 1 },
      vocab({ surface: "Zendesk", romaji: "zendesuku", source: "screen" }),
      { type: "screen", start: 1, image: null, lines: ["Zendesk 導入"] },
      remark("r1", "別の話をします"),
    ]);
    expect(byName(usage!.words)["Zendesk"]).toMatchObject({ spoken: false, user: false });
  }));

  it.effect("表記は NFKC・小文字でそろえて比べる（全角・大文字小文字の違いは同じ語）", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([start, { type: "vocab-pool", session: 1 }, vocab({ surface: "Zendesk", romaji: "zendesuku", source: "user" }), remark("r1", "ｚｅｎｄｅｓｋを使います")]);
    expect(byName(usage!.words)["Zendesk"]).toMatchObject({ spoken: true, user: true });
  }));

  it.effect("同じ語が複数の vocab の行に出たら、足した行が 1 つでもあれば足した語で、読みは最初に出た null でない値", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([
      start,
      { type: "vocab-pool", session: 2 },
      vocab({ surface: "葛西", romaji: null, source: "carried" }),
      vocab({ surface: "葛西", romaji: "kasai", source: "user" }),
      vocab({ surface: "葛西", romaji: "別", source: "screen" }),
    ]);
    expect(usage!.words).toEqual([{ surface: "葛西", romaji: "kasai", spoken: false, user: true }]);
  }));

  it.effect("vocab-pool の行が無いログ（play のフォルダ・古いログ）は undefined を返す", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([start, vocab({ surface: "港南店", romaji: "kounanten", source: "user" }), remark("r1", "港南店")]);
    expect(usage).toBeUndefined();
  }));

  it.effect("知らない種類の行は読み飛ばす", () => Effect.gen(function* () {
    const usage = yield* usageFromLog([start, { type: "jev" }, { type: "vocab-pool", session: 2 }, { type: "intake-restarted", trigger: "auto" }]);
    expect(usage).toEqual({ session: 2, words: [] });
  }));

  it.effect("項目が壊れた vocab の行は、その行の位置つきで InvalidLogEvent になる", () => Effect.gen(function* () {
    const error = yield* Effect.flip(usageFromLog([start, { type: "vocab-pool", session: 1 }, { type: "vocab", words: "壊れた" }]));
    expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 2 });
  }));
});
