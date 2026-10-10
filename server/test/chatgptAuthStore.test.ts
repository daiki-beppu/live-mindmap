import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, FileSystem, Result } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { accessToken } from "../src/chatgptAuth.ts";
import { logoutChatgpt, readCredentials, withAuthLock, writeAuthFile } from "../src/chatgptAuthStore.ts";
import { CHATGPT_HOME, chatgptCredentials, fakeChatgptFiles, fakeChatgptHttp } from "./fixtures/chatgpt.ts";

describe("認証ストア（C02）", () => {
  it.effect("一時ファイルへの書込が途中で失敗しても旧資格情報を保持し、一時ファイルを削除する", () => Effect.gen(function* () {
    const original = chatgptCredentials(0);
    const files = fakeChatgptFiles(original);
    files.control.failWrite = true;
    const result = yield* Effect.result(writeAuthFile(files.authPath, "replacement")).pipe(Effect.provideService(FileSystem.FileSystem, files.fs));
    expect(Result.isFailure(result)).toBe(true);
    expect(files.writes).toHaveLength(1);
    expect([...files.files.keys()]).toEqual([files.authPath]);
    expect(JSON.parse(files.files.get(files.authPath)!.text)).toEqual(original);
  }));

  it.effect("資格情報の構造が不正なら更新・推論を送らない", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials(0));
    files.files.set(files.authPath, { text: '{"access_token":"incomplete"}', mode: 0o600 });
    const http = fakeChatgptHttp(() => new Response("unexpected"));
    const result = yield* Effect.result(accessToken(files.authPath)).pipe(
      Effect.provideService(FileSystem.FileSystem, files.fs), Effect.provideService(HttpClient.HttpClient, http.client),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(http.requests).toEqual([]);
    expect(files.writes).toEqual([]);
  }));

  it.effect("logout は進行中の更新の保存を待って削除し、更新が資格情報を復活させない", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials(0));
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const http = fakeChatgptHttp(() => Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }));
    }));
    yield* Effect.gen(function* () {
      const refresh = yield* accessToken(files.authPath).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const logout = yield* logoutChatgpt.pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(refresh)).toBe("rotated-access");
      yield* TestClock.adjust(20);
      yield* Fiber.join(logout);
      expect(yield* readCredentials(files.authPath)).toBeUndefined();
      expect(files.renames).toHaveLength(1);
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, files.fs), Effect.provideService(HttpClient.HttpClient, http.client),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: CHATGPT_HOME }))),
    );
  }));

  it.effect("排他の所有者を中断した後に同じファイルを再び更新できる", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials(0));
    const entered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const holder = yield* withAuthLock(files.authPath, Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(holder);
      expect(yield* withAuthLock(files.authPath, Effect.succeed("reacquired"))).toBe("reacquired");
    }).pipe(Effect.provideService(FileSystem.FileSystem, files.fs));
  }));

  it.effect("残存 lock の取得期限を過ぎても他の所有者の lock を削除しない", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials(0));
    yield* Effect.gen(function* () {
      yield* files.fs.makeDirectory(`${files.authPath}.lock`);
      const pending = yield* Effect.result(withAuthLock(files.authPath, Effect.succeed("unexpected"))).pipe(Effect.forkChild);
      yield* TestClock.adjust(30_001);
      expect(Result.isFailure(yield* Fiber.join(pending))).toBe(true);
      expect(yield* files.fs.exists(`${files.authPath}.lock`)).toBe(true);
    }).pipe(Effect.provideService(FileSystem.FileSystem, files.fs));
  }));
});
