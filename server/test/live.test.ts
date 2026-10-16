import { assert, describe, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { decodeHelperEvent } from "../src/core/index.ts";

// ヘルパーのイベントの形は helper/README.md「イベントの形」が正本。
// 段 3（Issue #240）で remarkFromHelper・partialFromHelper・originFromHelper を decodeHelperEvent に
// まとめた（order.md:34, 47, 61）。期待値は、置き換え前のこのファイルが固定していたものと同じにする
// （order.md:61「期待値は同じ」）。戻り値の形だけが変わる: 知っているイベントは { kind: "known", event }、
// 知らない type は失敗ではなく { kind: "unknown" }、壊れた入力（不正な JSON を含む）はタグ付きの失敗になる。

// decode の成功を主張し、decode した値を返す。失敗していれば SchemaError の message を示して落ちる
// （fixtures/coreSchema.ts の expectDecodeSuccess と同じ idiom）
function expectDecodeSuccess<A, R>(effect: Effect.Effect<A, Schema.SchemaError, R>) {
  return Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    if (Result.isFailure(result)) assert.fail(`decode に失敗した: ${result.failure.message}`);
    return result.success;
  });
}

// decode の失敗（タグ付きの失敗）を主張する
function expectDecodeFailure<A, R>(effect: Effect.Effect<A, Schema.SchemaError, R>) {
  return Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.isTrue(Result.isFailure(result), "decode が成功してしまった（壊れた入力のはずが通った）");
  });
}

describe("decodeHelperEvent（ヘルパーのイベント文字列 → 知っている／知らないイベント）", () => {
  describe("remark（確定結果）", () => {
    it.effect("両トラックとも同じ形で decode され、type・track・start・end・text を保つ", () =>
      Effect.gen(function* () {
        const base = { type: "remark", start: 1.5, end: 3.25, text: "こんにちは", duplicate: false } as const;
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ ...base, track: "相手" })));
        assert.deepStrictEqual(decoded, { kind: "known", event: { ...base, track: "相手" } });
        const decoded2 = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ ...base, track: "自分" })));
        if (decoded2.kind !== "known" || decoded2.event.type !== "remark") return assert.fail("remark のはず");
        assert.strictEqual(decoded2.event.track, "自分");
      }));

    it.effect.each([
      ["不正なトラック", { type: "remark", track: "司会", start: 0, end: 1, text: "あ" }],
      ["本文の欠落", { type: "remark", track: "相手", start: 0, end: 1 }],
      ["秒数の型違い", { type: "remark", track: "相手", start: "0", end: 1, text: "あ" }],
    ])("必須項目が壊れていたら、読み飛ばさずにタグ付きの失敗になる（%s）", (_name, data) =>
      expectDecodeFailure(decodeHelperEvent(JSON.stringify(data))));
  });

  describe("partial（途中結果）", () => {
    it.effect("両トラックとも同じ形で decode され、track・start・end・text を保つ", () =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(
          decodeHelperEvent(JSON.stringify({ type: "partial", track: "相手", start: 1.5, end: 3.25, text: "こんに" })),
        );
        assert.deepStrictEqual(decoded, { kind: "known", event: { type: "partial", track: "相手", start: 1.5, end: 3.25, text: "こんに", duplicate: false } });
        const decoded2 = yield* expectDecodeSuccess(
          decodeHelperEvent(JSON.stringify({ type: "partial", track: "自分", start: 0, end: 1, text: "はい" })),
        );
        if (decoded2.kind !== "known" || decoded2.event.type !== "partial") return assert.fail("partial のはず");
        assert.deepStrictEqual({ track: decoded2.event.track, start: decoded2.event.start, end: decoded2.event.end, text: decoded2.event.text }, { track: "自分", start: 0, end: 1, text: "はい" });
      }));

    it.effect("duplicate は true のときだけ重複の印になる。項目がなければ（#36 より前の partial は）印なし", () =>
      Effect.gen(function* () {
        for (const [duplicateField, expected] of [[{ duplicate: true }, true], [{ duplicate: false }, false], [{}, false]] as const) {
          const decoded = yield* expectDecodeSuccess(
            decodeHelperEvent(JSON.stringify({ type: "partial", track: "自分", start: 0, end: 1, text: "あ", ...duplicateField })),
          );
          if (decoded.kind !== "known" || decoded.event.type !== "partial") return assert.fail("partial のはず");
          assert.strictEqual(decoded.event.duplicate, expected);
        }
      }));

    it.effect.each([
      ["不正なトラック", { type: "partial", track: "司会", start: 0, end: 1, text: "あ" }],
      ["本文の欠落", { type: "partial", track: "相手", start: 0, end: 1 }],
      ["本文の型違い", { type: "partial", track: "相手", start: 0, end: 1, text: 1 }],
      ["start の欠落（start / end を持たない旧形式）", { type: "partial", track: "相手", text: "あ" }],
      ["end の欠落", { type: "partial", track: "相手", start: 0, text: "あ" }],
      ["start の型違い", { type: "partial", track: "相手", start: "0", end: 1, text: "あ" }],
      ["end の型違い", { type: "partial", track: "相手", start: 0, end: "1", text: "あ" }],
    ])("必須項目が壊れていたら、読み飛ばさずにタグ付きの失敗になる（%s）", (_name, data) =>
      expectDecodeFailure(decodeHelperEvent(JSON.stringify(data))));
  });

  // Issue #639: 語ごとの読み。remark / partial に words（surface・romaji・location・length。位置は UTF-16）が載る。
  // words の無い旧形式のイベントも、これまでどおり受け付ける
  describe("words（発言の語ごとの読み）", () => {
    const words = [
      { surface: "今日", romaji: "kyō", location: 0, length: 2 },
      { surface: "は", romaji: "wa", location: 2, length: 1 },
      { surface: "xyz", romaji: "", location: 3, length: 3 },
    ];

    it.effect.each(["remark", "partial"] as const)("%s は words をそのまま保って decode される", (type) =>
      Effect.gen(function* () {
        const base = { type, track: "相手", start: 1, end: 2, text: "今日はxyz", duplicate: false } as const;
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ ...base, words })));
        assert.deepStrictEqual(decoded, { kind: "known", event: { ...base, words } });
      }));

    it.effect.each(["remark", "partial"] as const)("%s は words の無いイベントも受け付け、words のキーを足さない", (type) =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type, track: "相手", start: 1, end: 2, text: "あ" })));
        if (decoded.kind !== "known" || (decoded.event.type !== "remark" && decoded.event.type !== "partial")) return assert.fail("remark / partial のはず");
        assert.isFalse("words" in decoded.event);
      }));

    it.effect.each(["remark", "partial"] as const)("%s は空の words を受け付ける", (type) =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type, track: "相手", start: 1, end: 2, text: "", words: [] })));
        if (decoded.kind !== "known" || (decoded.event.type !== "remark" && decoded.event.type !== "partial")) return assert.fail("remark / partial のはず");
        assert.deepStrictEqual(decoded.event.words, []);
      }));

    const brokenWords: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["words が配列でない", { words: "x" }],
      ["surface の欠落", { words: [{ romaji: "a", location: 0, length: 1 }] }],
      ["romaji の型違い", { words: [{ surface: "あ", romaji: 1, location: 0, length: 1 }] }],
      ["location が負", { words: [{ surface: "あ", romaji: "a", location: -1, length: 1 }] }],
      ["length が小数", { words: [{ surface: "あ", romaji: "a", location: 0, length: 1.5 }] }],
      ["location の欠落", { words: [{ surface: "あ", romaji: "a", length: 1 }] }],
    ];
    it.effect.each(brokenWords)("words の形が壊れていたら、読み飛ばさずにタグ付きの失敗になる（%s）", ([_name, extra]) =>
      Effect.gen(function* () {
        for (const type of ["remark", "partial"]) {
          yield* expectDecodeFailure(decodeHelperEvent(JSON.stringify({ type, track: "相手", start: 0, end: 1, text: "あ", ...extra })));
        }
      }));
  });

  // Issue #1019: 語ごとの区間。remark / partial に wordTimes（location・length は本文の UTF-16 位置、start・end は秒）が載る。
  // wordTimes の無い旧ヘルパーのイベントも、これまでどおり受け付ける
  describe("wordTimes（発言の語ごとの区間）", () => {
    const wordTimes = [
      { location: 0, length: 2, start: 1, end: 1.5 },
      { location: 2, length: 1, start: 1.5, end: 1.75 },
    ];

    it.effect.each(["remark", "partial"] as const)("%s は wordTimes をそのまま保って decode される（words と併存する）", (type) =>
      Effect.gen(function* () {
        const base = { type, track: "自分", start: 1, end: 2, text: "今日は", duplicate: false } as const;
        const words = [{ surface: "今日", romaji: "kyō", location: 0, length: 2 }];
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ ...base, words, wordTimes })));
        assert.deepStrictEqual(decoded, { kind: "known", event: { ...base, words, wordTimes } });
      }));

    it.effect.each(["remark", "partial"] as const)("%s は wordTimes の無いイベントも受け付け、wordTimes のキーを足さない", (type) =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type, track: "相手", start: 1, end: 2, text: "あ" })));
        if (decoded.kind !== "known" || (decoded.event.type !== "remark" && decoded.event.type !== "partial")) return assert.fail("remark / partial のはず");
        assert.isFalse("wordTimes" in decoded.event);
      }));

    it.effect.each(["remark", "partial"] as const)("%s は空の wordTimes を受け付ける", (type) =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type, track: "相手", start: 1, end: 2, text: "", wordTimes: [] })));
        if (decoded.kind !== "known" || (decoded.event.type !== "remark" && decoded.event.type !== "partial")) return assert.fail("remark / partial のはず");
        assert.deepStrictEqual(decoded.event.wordTimes, []);
      }));

    const brokenWordTimes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["wordTimes が配列でない", { wordTimes: "x" }],
      ["start の欠落", { wordTimes: [{ location: 0, length: 1, end: 1 }] }],
      ["end の型違い", { wordTimes: [{ location: 0, length: 1, start: 0, end: "1" }] }],
      ["location が負", { wordTimes: [{ location: -1, length: 1, start: 0, end: 1 }] }],
      ["length が小数", { wordTimes: [{ location: 0, length: 1.5, start: 0, end: 1 }] }],
      ["location の欠落", { wordTimes: [{ length: 1, start: 0, end: 1 }] }],
    ];
    it.effect.each(brokenWordTimes)("wordTimes の形が壊れていたら、読み飛ばさずにタグ付きの失敗になる（%s）", ([_name, extra]) =>
      Effect.gen(function* () {
        for (const type of ["remark", "partial"]) {
          yield* expectDecodeFailure(decodeHelperEvent(JSON.stringify({ type, track: "相手", start: 0, end: 1, text: "あ", ...extra })));
        }
      }));
  });

  // 原点（host time）の通知イベント。64 bit の値は JSON の number では桁が落ちるので、文字列のまま運ぶ（order.md:60、要件 #22）。
  describe("origin（ヘルパーが決めた時刻の原点）", () => {
    it.effect("渡された hostTime を文字列のまま保つ（2^53 を超える値でも桁が落ちない）", () =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "origin", hostTime: "9007199254740993" })));
        assert.deepStrictEqual(decoded, { kind: "known", event: { type: "origin", hostTime: "9007199254740993" } });
      }));

    it.effect.each([
      ["hostTime が数値（JSON の number は桁が落ちるので受け付けない）", { type: "origin", hostTime: 9007199254740993 }],
      ["hostTime が数字でない文字列", { type: "origin", hostTime: "12a" }],
      ["hostTime の欠落", { type: "origin" }],
    ])("必須項目が壊れていたら、読み飛ばさずにタグ付きの失敗になる（%s）", (_name, data) =>
      expectDecodeFailure(decodeHelperEvent(JSON.stringify(data))));
  });

  // 共有画面の変化（Issue #278）。image は JPEG の base64。decode でバイト列にし、ウィンドウが無くなったら null。
  describe("screen（共有画面の変化）", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    const base64 = Buffer.from(jpeg).toString("base64");

    it.effect("image は base64 を元のバイト列に戻し、start を保つ", () =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "screen", start: 1.5, image: base64 })));
        if (decoded.kind !== "known" || decoded.event.type !== "screen") return assert.fail("screen のはず");
        assert.strictEqual(decoded.event.start, 1.5);
        if (decoded.event.image === null) return assert.fail("image はバイト列のはず");
        assert.deepStrictEqual([...decoded.event.image], [...jpeg]);
      }));

    it.effect("image が null（ウィンドウが無くなった）なら null のまま decode される", () =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "screen", start: 3, image: null })));
        assert.deepStrictEqual(decoded, { kind: "known", event: { type: "screen", start: 3, image: null } });
      }));

    // Issue #643: lines は省ける項目。古い helper（lines なし）も読める
    it.effect("lines つきの screen は lines を文字列の配列のまま保つ。空の配列も空のまま保つ", () =>
      Effect.gen(function* () {
        const withLines = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "screen", start: 1.5, image: base64, lines: ["港南店", "Zendesk"] })));
        if (withLines.kind !== "known" || withLines.event.type !== "screen") return assert.fail("screen のはず");
        assert.deepStrictEqual(withLines.event.lines, ["港南店", "Zendesk"]);
        assert.strictEqual(withLines.event.start, 1.5);
        const empty = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "screen", start: 2, image: base64, lines: [] })));
        if (empty.kind !== "known" || empty.event.type !== "screen") return assert.fail("screen のはず");
        assert.deepStrictEqual(empty.event.lines, []);
      }));

    it.effect("lines の無い screen（古い helper）は lines のキーを持たずに読める", () =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "screen", start: 1, image: base64 })));
        if (decoded.kind !== "known" || decoded.event.type !== "screen") return assert.fail("screen のはず");
        assert.isFalse("lines" in decoded.event);
      }));

    it.effect.each([
      ["lines が文字列", { type: "screen", start: 1, image: base64, lines: "港南店" }],
      ["lines の要素が数値", { type: "screen", start: 1, image: base64, lines: [1] }],
    ])("壊れた lines は、読み飛ばさずに SchemaError で失敗する（%s）", (row) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(decodeHelperEvent(JSON.stringify(row[1])));
        assert.isTrue(Result.isFailure(result), "decode が成功してしまった");
      }));

    it.effect.each([
      ["image のキーが無い", { type: "screen", start: 1 }],
      ["image が数値", { type: "screen", start: 1, image: 1 }],
      ["image が base64 として不正", { type: "screen", start: 1, image: "%%%" }],
      ["start が文字列", { type: "screen", start: "1", image: base64 }],
      ["start のキーが無い", { type: "screen", image: base64 }],
    ])("壊れた screen は、読み飛ばさずに SchemaError で失敗する（%s）", (row) =>
      Effect.gen(function* () {
        // it.effect.each は表の 1 行を配列のまま 1 引数で渡す（vitest の each のように展開しない）
        const [, data] = row;
        const result = yield* Effect.result(decodeHelperEvent(JSON.stringify(data)));
        if (Result.isSuccess(result)) return assert.fail("decode が成功してしまった（壊れた screen のはずが通った）");
        assert.strictEqual(result.failure._tag, "SchemaError");
      }));
  });

  describe("screen-off（画面収録の許可が無く、共有画面を使えない）", () => {
    it.effect("正しい形は known として decode され、start と reason を保つ", () =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "screen-off", start: 2.5, reason: "許可なし" })));
        assert.deepStrictEqual(decoded, { kind: "known", event: { type: "screen-off", start: 2.5, reason: "許可なし" } });
      }));

    it.effect.each([
      ["reason が 指定（指定はサーバーが書く。ヘルパーは流さない）", { type: "screen-off", start: 0, reason: "指定" }],
      ["reason が知らない文字列", { type: "screen-off", start: 0, reason: "other" }],
      ["reason のキーが無い", { type: "screen-off", start: 0 }],
      ["start のキーが無い", { type: "screen-off", reason: "許可なし" }],
      ["start が文字列", { type: "screen-off", start: "0", reason: "許可なし" }],
    ])("壊れた screen-off は、読み飛ばさずに SchemaError で失敗する（%s）", (row) =>
      Effect.gen(function* () {
        const [, data] = row;
        const result = yield* Effect.result(decodeHelperEvent(JSON.stringify(data)));
        if (Result.isSuccess(result)) return assert.fail("decode が成功してしまった（壊れた screen-off のはずが通った）");
        assert.strictEqual(result.failure._tag, "SchemaError");
      }));
  });

  describe("speaker（話者の区間。Issue #1020）", () => {
    it.effect("仮と確定のどちらも known として decode され、track・start・end・slot・final を保つ", () =>
      Effect.gen(function* () {
        for (const final of [false, true]) {
          const event = { type: "speaker", track: "相手", start: 1.5, end: 2.75, slot: 3, final } as const;
          const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify(event)));
          assert.deepStrictEqual(decoded, { kind: "known", event });
        }
      }));

    it.effect.each([
      ["track が不正", { type: "speaker", track: "司会", start: 0, end: 1, slot: 0, final: true }],
      ["slot が文字列", { type: "speaker", track: "相手", start: 0, end: 1, slot: "0", final: true }],
      ["slot が小数", { type: "speaker", track: "相手", start: 0, end: 1, slot: 0.5, final: true }],
      ["slot が負", { type: "speaker", track: "相手", start: 0, end: 1, slot: -1, final: true }],
      ["slot のキーが無い", { type: "speaker", track: "相手", start: 0, end: 1, final: true }],
      ["final が真偽値でない", { type: "speaker", track: "相手", start: 0, end: 1, slot: 0, final: "true" }],
      ["final のキーが無い", { type: "speaker", track: "相手", start: 0, end: 1, slot: 0 }],
      ["start が文字列", { type: "speaker", track: "相手", start: "0", end: 1, slot: 0, final: true }],
      ["end のキーが無い", { type: "speaker", track: "相手", start: 0, slot: 0, final: true }],
    ])("壊れた speaker は、読み飛ばさずに SchemaError で失敗する（%s）", (row) =>
      Effect.gen(function* () {
        const [, data] = row;
        const result = yield* Effect.result(decodeHelperEvent(JSON.stringify(data)));
        if (Result.isSuccess(result)) return assert.fail("decode が成功してしまった（壊れた speaker のはずが通った）");
        assert.strictEqual(result.failure._tag, "SchemaError");
      }));
  });

  describe("speaker-settled（話者分離がここまで確定した。Issue #1021）", () => {
    it.effect("正しい形は known として decode され、track・to を保つ", () =>
      Effect.gen(function* () {
        const event = { type: "speaker-settled", track: "相手", to: 14 } as const;
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify(event)));
        assert.deepStrictEqual(decoded, { kind: "known", event });
      }));

    it.effect.each([
      ["to が文字列", { type: "speaker-settled", track: "相手", to: "14" }],
      ["to のキーが無い", { type: "speaker-settled", track: "相手" }],
      ["track が不正", { type: "speaker-settled", track: "司会", to: 14 }],
      ["track のキーが無い", { type: "speaker-settled", to: 14 }],
    ])("壊れた speaker-settled は、読み飛ばさずに SchemaError で失敗する（%s）", (row) =>
      Effect.gen(function* () {
        const [, data] = row;
        const result = yield* Effect.result(decodeHelperEvent(JSON.stringify(data)));
        if (Result.isSuccess(result)) return assert.fail("decode が成功してしまった（壊れた speaker-settled のはずが通った）");
        assert.strictEqual(result.failure._tag, "SchemaError");
      }));
  });

  describe("speaker-mixed（枠への混入。Issue #1024）", () => {
    it.effect("正しい形は known として decode される。値は生のまま", () =>
      Effect.gen(function* () {
        const row = { type: "speaker-mixed", track: "相手", slot: 2, start: 95.5 } as const;
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify(row)));
        assert.deepStrictEqual(decoded, { kind: "known", event: row });
      }));

    it.effect.each([
      ["slot のキーが無い", { type: "speaker-mixed", track: "相手", start: 1 }],
      ["slot が負", { type: "speaker-mixed", track: "相手", slot: -1, start: 1 }],
      ["slot が小数", { type: "speaker-mixed", track: "相手", slot: 1.5, start: 1 }],
      ["start のキーが無い", { type: "speaker-mixed", track: "相手", slot: 1 }],
      ["start が文字列", { type: "speaker-mixed", track: "相手", slot: 1, start: "1" }],
      ["track が不正", { type: "speaker-mixed", track: "司会", slot: 1, start: 1 }],
      ["track のキーが無い", { type: "speaker-mixed", slot: 1, start: 1 }],
    ])("壊れた speaker-mixed は、読み飛ばさずに SchemaError で失敗する（%s）", (row) =>
      Effect.gen(function* () {
        const [, data] = row;
        const result = yield* Effect.result(decodeHelperEvent(JSON.stringify(data)));
        if (Result.isSuccess(result)) return assert.fail("decode が成功してしまった（壊れた speaker-mixed のはずが通った）");
        assert.strictEqual(result.failure._tag, "SchemaError");
      }));
  });

  describe("speaker-centroid（枠ごとの声の埋め込みの重心。Issue #1025）", () => {
    it.effect("正しい形は known として decode される。値は生のまま", () =>
      Effect.gen(function* () {
        const row = { type: "speaker-centroid", track: "相手", slot: 2, centroid: [0.25, -0.5, 1] } as const;
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify(row)));
        assert.deepStrictEqual(decoded, { kind: "known", event: row });
      }));

    it.effect.each([
      ["slot のキーが無い", { type: "speaker-centroid", track: "相手", centroid: [1] }],
      ["slot が負", { type: "speaker-centroid", track: "相手", slot: -1, centroid: [1] }],
      ["slot が小数", { type: "speaker-centroid", track: "相手", slot: 1.5, centroid: [1] }],
      ["centroid のキーが無い", { type: "speaker-centroid", track: "相手", slot: 1 }],
      ["centroid が配列でない", { type: "speaker-centroid", track: "相手", slot: 1, centroid: "1,2" }],
      ["centroid に文字列が混じる", { type: "speaker-centroid", track: "相手", slot: 1, centroid: [1, "2"] }],
      ["centroid に null が混じる", { type: "speaker-centroid", track: "相手", slot: 1, centroid: [1, null] }],
      ["track が不正", { type: "speaker-centroid", track: "司会", slot: 1, centroid: [1] }],
      ["track のキーが無い", { type: "speaker-centroid", slot: 1, centroid: [1] }],
    ])("壊れた speaker-centroid は、読み飛ばさずに SchemaError で失敗する（%s）", (row) =>
      Effect.gen(function* () {
        const [, data] = row;
        const result = yield* Effect.result(decodeHelperEvent(JSON.stringify(data)));
        if (Result.isSuccess(result)) return assert.fail("decode が成功してしまった（壊れた speaker-centroid のはずが通った）");
        assert.strictEqual(result.failure._tag, "SchemaError");
      }));
  });

  describe("speaker-off（話者分離を使えない。Issue #1020）", () => {
    it.effect.each(["モデルなし", "読み込みに失敗", "途中で停止"] as const)("reason が %s の正しい形は known として decode される", (reason) =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "speaker-off", start: 2.5, reason })));
        assert.deepStrictEqual(decoded, { kind: "known", event: { type: "speaker-off", start: 2.5, reason } });
      }));

    it.effect.each([
      ["reason が知らない文字列", { type: "speaker-off", start: 0, reason: "other" }],
      ["reason のキーが無い", { type: "speaker-off", start: 0 }],
      ["start のキーが無い", { type: "speaker-off", reason: "モデルなし" }],
      ["start が文字列", { type: "speaker-off", start: "0", reason: "モデルなし" }],
    ])("壊れた speaker-off は、読み飛ばさずに SchemaError で失敗する（%s）", (row) =>
      Effect.gen(function* () {
        const [, data] = row;
        const result = yield* Effect.result(decodeHelperEvent(JSON.stringify(data)));
        if (Result.isSuccess(result)) return assert.fail("decode が成功してしまった（壊れた speaker-off のはずが通った）");
        assert.strictEqual(result.failure._tag, "SchemaError");
      }));
  });

  describe("知らない type・壊れた入力", () => {
    it.effect("知らない type は失敗にならず、「知らないイベント」として返る", () =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(decodeHelperEvent(JSON.stringify({ type: "heartbeat" })));
        assert.deepStrictEqual(decoded, { kind: "unknown" });
      }));

    it.effect("不正な JSON はタグ付きの失敗になる", () => expectDecodeFailure(decodeHelperEvent("{")));

    it.effect("オブジェクトではない入力（type を見分けられない）はタグ付きの失敗になる", () =>
      expectDecodeFailure(decodeHelperEvent(JSON.stringify("origin"))));

    it.effect("type の欄がないオブジェクトはタグ付きの失敗になる", () => expectDecodeFailure(decodeHelperEvent(JSON.stringify({}))));
  });
});
