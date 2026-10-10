import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { depsDirConfig } from "../src/config.ts";

describe("管理依存の保存先設定", () => {
  it.effect("未指定ならホームの .live-mindmap/deps を使う", () => Effect.gen(function* () {
    const root = yield* depsDirConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})));
    expect(root).toBe(join(homedir(), ".live-mindmap", "deps"));
  }));

  it.effect("LIVE_MINDMAP_DEPS は sessions の保存先と独立して管理ルートを変更する", () => Effect.gen(function* () {
    const root = yield* depsDirConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({
      LIVE_MINDMAP_DEPS: "/isolated/managed-deps",
      LIVE_MINDMAP_SESSIONS: "/isolated/sessions",
    })));
    expect(root).toBe("/isolated/managed-deps");
  }));
});
