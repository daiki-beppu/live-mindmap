import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { markRecordStatus, readPublishRecords } from "../src/publishRecords.ts";

const home = "/synthetic/home";
const path = join(home, ".live-mindmap", "publish", "records.jsonl");
const record = {
  name: "lmm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", url: "https://lmm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example.workers.dev", accountId: "acct", dir: "/sessions/a",
  level: "map", anyone: false, passphrase: "pass", publishedAt: "2026-10-24T00:00:00.000Z", expiresAt: "2026-10-31T00:00:00.000Z", status: "published",
};
const text = `${JSON.stringify(record)}\n\n{broken\n`;

const recordsFile = (written: string[]) => Layer.mergeAll(
  Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({
    exists: (file) => Effect.succeed(file === path),
    makeDirectory: () => Effect.void,
    readFileString: () => Effect.succeed(text),
    writeFileString: (file) => Effect.sync(() => void written.push(file)),
  })),
  ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home })),
);

describe("公開の記録", () => {
  it.effect("壊れた行を含む記録の書き換えは、読み込みと同じ行番号とパスの失敗になり、何も書かない", () => Effect.gen(function* () {
    const written: string[] = [];
    const layer = recordsFile(written);

    const marked = yield* Effect.flip(markRecordStatus([record.name], "withdrawn").pipe(Effect.provide(layer)));
    const read = yield* Effect.flip(readPublishRecords().pipe(Effect.provide(layer)));

    expect(marked).toMatchObject({ _tag: "UnreadablePublishRecord", path, line: 3, message: `公開の記録 ${path} の 3 行目が読めません` });
    expect(read).toEqual(marked);
    expect(written).toEqual([]);
  }));
});
