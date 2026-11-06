import { describe, expect, it } from "@effect/vitest";
import { Effect, PlatformError } from "effect";
import { SessionWriteFailed } from "../src/core/index.ts";

describe("SessionWriteFailed", () => {
  it.effect("型付き失敗として対象パスと元のエラーを返す", () => Effect.gen(function* () {
    const cause = new Error("EACCES: 書込拒否");
    const failure = yield* Effect.flip(Effect.fail(new SessionWriteFailed({ path: "/synthetic/log.jsonl", cause })));
    expect(failure).toMatchObject({ _tag: "SessionWriteFailed", path: "/synthetic/log.jsonl", cause });
    expect(failure.message).toBe("ログを書けない: /synthetic/log.jsonl: EACCES: 書込拒否");
  }));

  it("OS の原因を持つ FileSystem の失敗は、その原因を一行で表示する", () => {
    const cause = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "writeFileString", cause: new Error("EACCES: 書込拒否\n詳細") });
    expect(new SessionWriteFailed({ path: "/synthetic/export.json", cause }).message)
      .toBe("ログを書けない: /synthetic/export.json: EACCES: 書込拒否 詳細");
  });

  it("元の原因が文字列の場合も表示する", () => {
    expect(new SessionWriteFailed({ path: "/synthetic/log.jsonl", cause: "disk unavailable" }).message)
      .toBe("ログを書けない: /synthetic/log.jsonl: disk unavailable");
  });
});
