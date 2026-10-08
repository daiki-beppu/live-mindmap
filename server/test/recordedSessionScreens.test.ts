import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import type { DiffInput, Remark, ScreenChange } from "../src/core/index.ts";
import { createSessionDir, openRecordedSession } from "../src/sessionFiles.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";

// ログを書く配線（openRecordedSession。play もライブも同じ）が、共有画面の画像をセッションのフォルダの screens/ に、
// 受け取ったバイト列のまま書き、log.jsonl に screen の行を { at, type, start, image } で書くこと。
// 中核（Session）はファイルに書かない（ADR 0003）ので、書くのはこの配線だけ。

const sessionsDir = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-screens-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

// 0〜255 を全部含めるバイト列（テキストとして書き換わると壊れる）
const allBytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
const shot = (start: number, bytes: Uint8Array, id = `s${start}`): ScreenChange => ({ start, image: { id, bytes } });
const remark = (id: string, end: number): Remark => ({ id, track: "相手", start: end - 1, end, text: "発言" });

const open = Effect.fn("open")(function* () {
  const root = yield* sessionsDir;
  const dir = yield* createSessionDir(root).pipe(Effect.provide(NodeFileSystem.layer));
  const inputs: DiffInput[] = [];
  const { session } = yield* openRecordedSession({ dir, title: "定例", publish: () => Effect.void }).pipe(
    Effect.provide(updaterLayer((input) => Effect.sync(() => (inputs.push(input), { ops: [] })))),
    Effect.provide(NodeFileSystem.layer),
  );
  const lines = () => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { dir, session, inputs, lines };
});

describe("openRecordedSession の共有画面", () => {
  it.effect("画像を screens/<時刻から付いた名前> に受け取ったバイト列のまま書き、log.jsonl には at 付きの screen の行を書く", () =>
    Effect.gen(function* () {
      const { dir, session, lines } = yield* open();
      yield* session.pushScreen(shot(754.2, allBytes));
      yield* session.pushScreen({ start: 800, image: null });

      expect(readdirSync(join(dir, "screens"))).toEqual(["0754.2.jpg"]);
      expect(new Uint8Array(readFileSync(join(dir, "screens", "0754.2.jpg")))).toEqual(allBytes);
      const screens = lines().filter((l) => l.type === "screen");
      expect(screens.map(({ type, start, image }) => ({ type, start, image }))).toEqual([
        { type: "screen", start: 754.2, image: "0754.2.jpg" },
        { type: "screen", start: 800, image: null },
      ]);
      expect(screens.every((l) => typeof l.at === "string")).toBe(true);
      // 行にバイト列は載らない
      expect(JSON.stringify(screens)).not.toContain("bytes");
    }).pipe(Effect.scoped));

  it.effect("同じ時刻の画像が重なっても上書きせず、別のファイルとして残る", () =>
    Effect.gen(function* () {
      const { dir, session, lines } = yield* open();
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([9, 8, 7]);
      yield* session.pushScreen(shot(10, a, "a"));
      yield* session.pushScreen(shot(10, b, "b"));

      const names = lines().filter((l) => l.type === "screen").map((l) => l.image as string);
      expect(new Set(names).size).toBe(2);
      expect(readdirSync(join(dir, "screens")).sort()).toEqual([...names].sort());
      expect(new Uint8Array(readFileSync(join(dir, "screens", names[0]!)))).toEqual(a);
      expect(new Uint8Array(readFileSync(join(dir, "screens", names[1]!)))).toEqual(b);
    }).pipe(Effect.scoped));

  it.effect("diff の行の input.screens は、添えた画面の { start, image: ファイル名 } で、そのファイルが screens/ に在る", () =>
    Effect.gen(function* () {
      const { dir, session, inputs, lines } = yield* open();
      yield* session.pushScreen(shot(5, allBytes));
      yield* session.push(remark("r1", 8));
      yield* session.push(remark("r2", 9));
      yield* session.idle;

      expect(inputs).toHaveLength(1);
      const diff = lines().find((l) => l.type === "diff") as { input: { screens?: unknown } };
      expect(diff.input.screens).toEqual([{ start: 5, image: "0005.0.jpg" }]);
      expect(existsSync(join(dir, "screens", "0005.0.jpg"))).toBe(true);
    }).pipe(Effect.scoped));

  it.effect("画面を 1 件も受けないセッションは screens/ を作らず、screen の行も無い", () =>
    Effect.gen(function* () {
      const { dir, session, inputs, lines } = yield* open();
      yield* session.push(remark("r1", 8));
      yield* session.push(remark("r2", 9));
      yield* session.idle;

      expect(inputs).toHaveLength(1); // 否定のテストなので、差分更新が実際に起きたことを先に確かめる
      expect(existsSync(join(dir, "screens"))).toBe(false);
      expect(lines().some((l) => l.type === "screen")).toBe(false);
    }).pipe(Effect.scoped));
});
