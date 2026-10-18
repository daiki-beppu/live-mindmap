import { copyFile, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { ManagedDeps } from "../src/managedDeps.ts";
import { fakeNpm, temporaryDeps } from "./fixtures/managedDeps.ts";
import { archive, CONTENT } from "./fixtures/cloudflared.ts";

const installed = { name: "cloudflared", need: "optional", state: "ready" } as const;

const transientNames = (names: string[]) => names.filter((name) => name.startsWith(".work-") || name.startsWith("install.lock"));

// tar の展開で値が決まる契約（導入した中身と実行ビット）の代表。ハッシュ不一致などは managedCloudflared.it.test.ts に残す
describe("管理 cloudflared の導入（tar の展開）", () => {
  it.live("831 C2・C4・C5: 合成 tgz を管理ルートに導入し実行可能なパスを返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    const npm = yield* fakeNpm(dir);
    const downloads: string[] = [];
    const options = { root, npm, cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (url: string, destination: string) => Effect.tryPromise(async () => {
        downloads.push(url);
        await copyFile(fixture.path, destination);
      }),
    } };
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const events = yield* Stream.runCollect(deps.install(["cloudflared"]));
      expect(events.at(-1)).toEqual({ type: "result", items: [installed] });
      expect(downloads).toEqual([fixture.artifact.url]);
      expect(yield* deps.check(["cloudflared"])).toEqual([installed]);
      const binary = yield* deps.executable("cloudflared");
      const within = relative(yield* Effect.tryPromise(() => realpath(join(root, "cloudflared"))), yield* Effect.tryPromise(() => realpath(binary)));
      expect(isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)).toBe(false);
      expect(yield* Effect.tryPromise(() => readFile(binary, "utf8"))).toBe(CONTENT);
      expect((yield* Effect.tryPromise(() => stat(binary))).mode & 0o111).not.toBe(0);
      expect(yield* Effect.tryPromise(() => readFile(join(root, "cloudflared/current/cloudflared"), "utf8"))).toBe(CONTENT);
      expect(yield* Effect.tryPromise(() => readdir(dir))).not.toContain("calls.jsonl");
      expect(transientNames(yield* Effect.tryPromise(() => readdir(join(root, "cloudflared"))))).toEqual([]);
    }).pipe(Effect.provide(ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer))));
  }).pipe(Effect.scoped));
});
