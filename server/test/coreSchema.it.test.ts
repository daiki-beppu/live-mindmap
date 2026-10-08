// Issue #238 段 1: core の Truth の Schema が、bench の実在する正解ファイル（deciding.truth.json）を decode できること。
// 本物のファイルシステムでリポジトリのファイルを読む。そのほかの Schema の確認は coreSchema.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Truth } from "../src/core/index.ts";
import { expectDecodeSuccess } from "./fixtures/coreSchema.ts";

describe("正解ファイル（Truth）（CT-4DATA）", () => {
  const fixture = join(import.meta.dirname, "../bench/meetings/deciding.truth.json");

  it.effect("bench の正解ファイル（deciding.truth.json）を decode できる。keywords の文字列と配列の両方の形を含む", () =>
    Effect.gen(function* () {
      const raw = JSON.parse(readFileSync(fixture, "utf8"));
      const decoded = yield* expectDecodeSuccess(Schema.decodeUnknownEffect(Truth)(raw));
      assert.strictEqual(decoded.決定.length, 2);
      assert.strictEqual(decoded.TODO.length, 3);
      assert.deepStrictEqual(decoded.決定[0]!.keywords, ["A社"]);
      assert.deepStrictEqual(decoded.決定[1]!.keywords[1], ["二月末", "2月末", "二月の末", "2月の末"]);
    }));
});
