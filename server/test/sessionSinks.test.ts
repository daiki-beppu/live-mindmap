import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { QUIET_MS, REVIEW_LOG_ELEMENT_ID, type DiffInput, type DiffOutput, type Snapshot, type SpeakingFrame } from "../src/core/index.ts";
import { ReviewBuild, writeReviewPages, type PromiseReviewPages } from "../src/review.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { promiseOrDie } from "./fixtures/promiseOrDie.ts";

// Issue #240 段 3（ADR 0008）: SessionSinks の実物 Layer を、実 tmpdir + 偽の updater／capture で確かめる。
// updater・ログ・いま話している文字・書き出しを開く契約（CT-SINK-SCOPE）と、録音ファイル名の採番（要件117,127）
// がこのファイルの対象。古い core のセッション（createSession・startRecordedSession）はまだ置き換えず、
// SessionSinks の中で acquireRelease で包む（order.md:9, 86, 要件68）ので、この層のテストは本物の cli.ts の
// 書き出しを実際に行い、Node 実行環境（tmpdir）に依存する（sessions.test.ts は偽の SessionSinks を使う）。
//
// 想定する契約（server/src/sessionSinks.ts）:
// - `SessionSinks.layer({ openUpdater, capture, writeReview: fakeWriteReview })` が実物の Layer を作る（server.ts の ServerOptions と同じ依存）
// - `createDir(sessionsDir)` がセッションのフォルダを作る（失敗すれば以後 open を呼ばない。要件3の前提）
// - `open({ dir, title, publish, speak })` がセッションの Scope の中で 1 回呼ばれ、updater を
//   `Effect.acquireRelease` で開き、`SessionSink`（partial・final・drain・clearSpeaking・stopRelays・
//   appendLog・flush・exports・audioFileNames）を返す。Scope を閉じると updater が閉じる

function makeFakeUpdater() {
  const state = { opened: 0, closed: 0, calls: 0 };
  const openUpdater = () => {
    state.opened++;
    return {
      update: async (): Promise<DiffOutput> => {
        state.calls++;
        return { ops: [] };
      },
      close: () => {
        state.closed++;
      },
    };
  };
  return { openUpdater, state };
}

const fakeCapture = async (_snapshot: Snapshot, path: string) => writeFileSync(path, "");
const failingCapture = async () => {
  throw new Error("撮影に失敗");
};

// 見返し用の HTML は、書き出し（ログの読み込み・埋め込み・書き込み）は本物で、Vite のビルドだけ偽物にする。
// server.ts の入口と同じく、writeReviewPages から Promise の口を 1 つ組む
const FAKE_TEMPLATE = "<!doctype html><html><body></body></html>";
const fakeWriteReview: PromiseReviewPages = (dir, logPath, variants) =>
  Effect.runPromise(
    writeReviewPages(dir, logPath, variants).pipe(
      Effect.provideService(ReviewBuild, ReviewBuild.of({ build: () => Effect.succeed(FAKE_TEMPLATE) })),
    ),
  );
const failingWriteReview: PromiseReviewPages = async () => {
  throw new Error("ビルドに失敗");
};

const withTmpSessionsDir = Effect.fn("withTmpSessionsDir")(function* () {
  return yield* Effect.acquireRelease(
    promiseOrDie(() => mkdtemp(join(tmpdir(), "live-mindmap-sinks-"))),
    (dir) => promiseOrDie(() => rm(dir, { recursive: true, force: true })),
  );
});

describe("SessionSinks（実物 Layer）", () => {
  it.live("updater はセッションの Scope の資源で、Scope を閉じると閉じる（CT-SINK-SCOPE）", () => {
    const { openUpdater, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      expect(state.opened).toBe(0); // フォルダを作っただけでは開かない

      const scope = yield* Scope.make();
      yield* Scope.provide(
        sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }),
        scope,
      );
      expect(state).toMatchObject({ opened: 1, closed: 0 });

      yield* Scope.close(scope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });
    }).pipe(Effect.provide(SessionSinks.layer({ openUpdater, capture: fakeCapture, writeReview: fakeWriteReview })));
  });

  it.live("フォルダを作れないと createDir が失敗し、open を呼ばなければ updater も開かない", () => {
    const { openUpdater, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const tmp = yield* withTmpSessionsDir();
      const blocker = join(tmp, "blocker");
      writeFileSync(blocker, ""); // 親のフォルダの位置に通常ファイルを置き、mkdir できなくする
      const sinks = yield* SessionSinks;

      const result = yield* Effect.exit(sinks.createDir(join(blocker, "sessions")));

      expect(result._tag).toBe("Failure");
      expect(state).toMatchObject({ opened: 0, closed: 0 });
    }).pipe(Effect.provide(SessionSinks.layer({ openUpdater, capture: fakeCapture, writeReview: fakeWriteReview })));
  });

  it.live("発言の ID はセッションにつき 1 つのクロージャで、r1 から順に増える（要件125）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const { openUpdater } = makeFakeUpdater();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

      yield* sink.final({ track: "相手", start: 0, end: 1, text: "ひとつめ" });
      yield* sink.final({ track: "自分", start: 2, end: 3, text: "ふたつめ" });
      yield* sink.flush;

      const log = yield* Effect.sync(() => readFileSync(join(dir, "log.jsonl"), "utf8"));
      const remarkIds = log.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)).filter((e) => e.type === "remark").map((e) => e.remark.id);
      expect(remarkIds).toEqual(["r1", "r2"]);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeFakeUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));

  it.live("exports は書き出した 5 パスを返す（4 つ目が map.png、5 つ目が map.html）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      const paths = yield* sink.exports;

      expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png", "map.html"]);
      for (const path of paths) expect(existsSync(path)).toBe(true);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeFakeUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));

  it.live("撮影が失敗しても exports は map.html を含む 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const stderr: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
      try {
        const sessionsDir = yield* withTmpSessionsDir();
        const sinks = yield* SessionSinks;
        const dir = yield* sinks.createDir(sessionsDir);
        const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
        yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
        yield* sink.flush;

        const paths = yield* sink.exports;

        expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.html"]);
        expect(existsSync(join(dir, "map.png"))).toBe(false);
        expect(stderr.some((s) => s.includes("map.png を書き出せませんでした: 撮影に失敗"))).toBe(true);
      } finally {
        process.stderr.write = original;
      }
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeFakeUpdater().openUpdater, capture: failingCapture, writeReview: fakeWriteReview }))));

  it.live("map.html の書き出しが失敗しても exports はほかの 4 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const stderr: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
      try {
        const sessionsDir = yield* withTmpSessionsDir();
        const sinks = yield* SessionSinks;
        const dir = yield* sinks.createDir(sessionsDir);
        const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
        yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
        yield* sink.flush;

        const paths = yield* sink.exports;

        expect(paths.map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png"]);
        expect(existsSync(join(dir, "map.html"))).toBe(false);
        expect(stderr.some((s) => s.includes("map.html を書き出せませんでした: ビルドに失敗"))).toBe(true);
      } finally {
        process.stderr.write = original;
      }
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeFakeUpdater().openUpdater, capture: fakeCapture, writeReview: failingWriteReview }))));

  it.live("exports で書く map.html には、そのセッションの log.jsonl の出来事がそのまま埋め込まれる", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      yield* sink.exports;

      const log = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
      const html = readFileSync(join(dir, "map.html"), "utf8");
      const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toEqual(log);
      expect(log.length).toBeGreaterThan(0);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeFakeUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));

  describe("録音ファイルの番号（audioFileNames。要件117,127）", () => {
    it.live("1 回目の名前（相手.m4a・自分.m4a）は変えず、2 回目以降は -2・-3 の番号が付く", () =>
      Effect.scoped(Effect.gen(function* () {
        const sessionsDir = yield* withTmpSessionsDir();
        const sinks = yield* SessionSinks;
        const dir = yield* sinks.createDir(sessionsDir);
        const sink = yield* sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void });

        expect(sink.audioFileNames(1)).toEqual(["相手.m4a", "自分.m4a"]);
        expect(sink.audioFileNames(2)).toEqual(["相手-2.m4a", "自分-2.m4a"]);
        expect(sink.audioFileNames(3)).toEqual(["相手-3.m4a", "自分-3.m4a"]);
      })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeFakeUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));
  });
});

// 差分更新に渡った発言・公開したスナップショット・送った speaking を記録する Sink の組み立て
const openRecordingSink = Effect.fn("openRecordingSink")(function* () {
  const sessionsDir = yield* withTmpSessionsDir();
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(sessionsDir);
  const calls: DiffInput[] = [];
  const speaks: SpeakingFrame[] = [];
  const published: Snapshot[] = [];
  const sink = yield* sinks.open({
    dir,
    title: "週次",
    publish: (snapshot) => Effect.sync(() => void published.push(snapshot)),
    speak: (frame) => Effect.sync(() => void speaks.push(frame)),
  });
  return { sink, dir, calls, speaks, published };
});

const makeRecordingUpdater = () => {
  const calls: DiffInput[] = [];
  const openUpdater = () => ({
    update: async (input: DiffInput): Promise<DiffOutput> => {
      calls.push(input);
      return { ops: [] };
    },
    close: () => {},
  });
  return { calls, openUpdater };
};

const logEvents = (dir: string) =>
  readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

const realDelay = (ms: number) => promiseOrDie(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const waitUntil = (condition: () => boolean, timeoutMs: number) =>
  Effect.gen(function* () {
    for (let waited = 0; !condition() && waited < timeoutMs; waited += 50) yield* realDelay(50);
    expect(condition()).toBe(true);
  });

const finalRemark = (track: "相手" | "自分", start: number, end: number, text: string) => ({ track, start, end, text });

describe("SessionSinks（実物 Layer）: 発言の確定・途中結果・書き出し", () => {
  it.live("確定結果が来なくても、相手の途中結果は 1 秒更新されなければ、最後の本文・区間で発言が 1 件、差分更新に渡る。ID は r1 で、ログにも残る", () => {
    const { calls, openUpdater } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "あしたの", duplicate: false });
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議は", duplicate: false });

      yield* waitUntil(() => calls.flatMap((c) => c.fresh).length === 1, 10_000);
      expect(calls.flatMap((c) => c.fresh)[0]).toMatchObject({ id: "r1", track: "相手", start: 5, end: 8, text: "あしたの会議は" });

      yield* sink.drain;
      yield* sink.flush;
      expect(calls.flatMap((c) => c.fresh)).toHaveLength(1); // 終了処理で増えない
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議は"]]);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater, capture: fakeCapture, writeReview: fakeWriteReview })));
  });

  it.live("出した後に届いた確定結果は捨てる。発言は増えず、次の発言の ID は r2 で番号が飛ばない", () => {
    const { calls, openUpdater } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議", duplicate: false });
      yield* waitUntil(() => calls.flatMap((c) => c.fresh).length === 1, 10_000);

      yield* sink.final(finalRemark("相手", 5.2, 8.2, "明日の会議は十時です。")); // r1 を覆う確定結果。本文が違っても捨てる
      yield* sink.final(finalRemark("相手", 30, 32, "べつの確定結果"));
      yield* sink.drain;
      yield* sink.flush;

      const fresh = calls.flatMap((c) => c.fresh);
      expect(fresh.map((u) => u.id)).toEqual(["r1", "r2"]);
      expect(fresh.some((u) => u.text.includes("十時です"))).toBe(false);
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議"], ["r2", "べつの確定結果"]]);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater, capture: fakeCapture, writeReview: fakeWriteReview })));
  });

  it.live("drain は、まだ出ていない発話を落とさない。途中結果の最後の本文が差分更新に渡る", () => {
    const { calls, openUpdater } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "とちゅうでとめた", duplicate: false });

      yield* sink.drain;
      yield* sink.flush;

      expect(calls.flatMap((c) => c.fresh).map((u) => [u.id, u.text])).toEqual([["r1", "とちゅうでとめた"]]);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater, capture: fakeCapture, writeReview: fakeWriteReview })));
  });

  it.live("自分の途中結果は、1 秒を超えても発言にならない（相手の同じ入力は発言になる）。自分の発言は確定結果だけから作られる", () => {
    const { calls, openUpdater } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "あいてのとちゅう", duplicate: false });
      yield* sink.partial({ track: "自分", start: 5, end: 6, text: "じぶんのとちゅう", duplicate: false });
      yield* sink.final(finalRemark("自分", 20, 22, "じぶんの確定結果"));

      // 守っている状態に到達する: 相手の途中結果は 1 秒経って出ている（自分の途中結果は同時に届いており、出るなら同じ時刻に出る）
      yield* waitUntil(() => calls.flatMap((c) => c.fresh).some((u) => u.text === "あいてのとちゅう"), 10_000);
      yield* sink.drain;
      yield* sink.flush;

      const fresh = calls.flatMap((c) => c.fresh);
      expect(fresh.map((u) => [u.track, u.text])).toEqual(expect.arrayContaining([["相手", "あいてのとちゅう"], ["自分", "じぶんの確定結果"]]));
      expect(fresh).toHaveLength(2);
      expect(fresh.some((u) => u.text === "じぶんのとちゅう")).toBe(false);
      expect(logEvents(dir).filter((e) => e.type === "remark")).toHaveLength(2);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater, capture: fakeCapture, writeReview: fakeWriteReview })));
  });

  it.live("発言が 1 件だけ届き QUIET_MS 新しい発言が来ないとき、flush を待たずにその 1 件で差分更新が呼ばれ、反映後のマップが公開される", () => {
    const { calls, openUpdater } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, published } = yield* openRecordingSink();
      yield* sink.final(finalRemark("相手", 1, 5, "採用の面接について"));

      yield* waitUntil(() => calls.length > 0, QUIET_MS + 5_000);
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]);
      yield* waitUntil(() => published.length >= 2, 5_000);
      expect(published.map((s) => s.round)).toEqual([0, 1]);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater, capture: fakeCapture, writeReview: fakeWriteReview })));
  });

  it.live("途中結果は speaking として届く。重複の印の付いた自分の途中結果は出ず、印のないものは出る。stopRelays で両トラックとも空になり、以後は送らない", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 1, end: 3, text: "はじまりの途中結果", duplicate: false });
      yield* sink.partial({ track: "自分", start: 1, end: 2, text: "もれたあいてのこえ", duplicate: true });
      yield* sink.partial({ track: "自分", start: 3, end: 4, text: "じぶんのこえ", duplicate: false });
      yield* waitUntil(() => speaks.some((f) => f.track === "自分" && f.text.includes("じぶんのこえ")), 5_000);
      expect(speaks[0]).toEqual({ type: "speaking", track: "相手", text: "はじまりの途中結果" });
      expect(speaks.filter((f) => f.track === "自分").some((f) => f.text.includes("もれたあいてのこえ"))).toBe(false);

      yield* sink.stopRelays;
      for (const track of ["相手", "自分"] as const) expect(speaks.filter((f) => f.track === track).at(-1)?.text).toBe("");
      const sent = speaks.length;
      yield* sink.partial({ track: "相手", start: 9, end: 10, text: "終了後の途中結果", duplicate: false });
      yield* realDelay(400);
      expect(speaks).toHaveLength(sent);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeRecordingUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));

  it.live("clearSpeaking は両トラックを空にするが、以後も途中結果を送れる", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 1, end: 3, text: "ひとつめ", duplicate: false });
      yield* waitUntil(() => speaks.some((f) => f.text === "ひとつめ"), 5_000);

      yield* sink.clearSpeaking;
      expect(speaks.filter((f) => f.track === "相手").at(-1)?.text).toBe("");
      yield* sink.partial({ track: "相手", start: 4, end: 5, text: "ふたつめ", duplicate: false });
      yield* waitUntil(() => speaks.some((f) => f.text === "ふたつめ"), 5_000);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeRecordingUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));

  it.live("発言が 1 件も来ないセッションでも、exports はそのセッションのマップ（空の会議ノード）を書き出す", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();

      const paths = yield* sink.exports;

      expect(paths).toHaveLength(5);
      expect(JSON.parse(readFileSync(join(dir, "map.json"), "utf8")).root).toMatchObject({ kind: "会議", text: "週次", children: [] });
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeRecordingUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));

  it.live("撮影に渡すスナップショットは 1 回だけで、書き出した map.png が 4 つ目のパスになる", () => {
    const captured: Snapshot[] = [];
    const capture = async (snapshot: Snapshot, path: string) => {
      captured.push(snapshot);
      writeFileSync(path, "png");
    };
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final(finalRemark("相手", 1, 2, "採用"));
      yield* sink.flush;

      const paths = yield* sink.exports;

      expect(captured).toHaveLength(1);
      expect(paths[3]).toBe(join(dir, "map.png"));
      expect(readFileSync(join(dir, "map.png"), "utf8")).toBe("png");
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeRecordingUpdater().openUpdater, capture, writeReview: fakeWriteReview })));
  });

  // base の server.test.ts の移動先
  it.live("flush は最後の差分更新（r3 を含む）が終わるまで待ち、その後に Scope を閉じて updater を閉じる。閉じた後には呼ばれない（base:581）", () => {
    const state = { calls: [] as string[][], closed: 0, callsAfterClose: 0 };
    const openUpdater = () => ({
      update: async (input: DiffInput): Promise<DiffOutput> => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30)); // 反映に時間がかかる
        if (state.closed > 0) state.callsAfterClose++;
        state.calls.push(input.fresh.map((u) => u.id));
        return { ops: [] };
      },
      close: () => {
        state.closed++;
      },
    });
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const scope = yield* Scope.make();
      const sink = yield* Scope.provide(sinks.open({ dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void }), scope);
      yield* sink.final(finalRemark("相手", 1, 2, "ひとつめ"));
      yield* sink.final(finalRemark("自分", 3, 4, "ふたつめ"));
      yield* sink.final(finalRemark("相手", 5, 6, "みっつめ"));

      yield* sink.flush;
      expect(state.calls.flat().sort()).toEqual(["r1", "r2", "r3"]); // flush が戻った時点で、3 件とも差分更新に渡っている
      expect(state.closed).toBe(0);
      yield* Scope.close(scope, Exit.void);
      yield* realDelay(100);

      expect(state).toMatchObject({ closed: 1, callsAfterClose: 0 });
    }).pipe(Effect.provide(SessionSinks.layer({ openUpdater, capture: fakeCapture, writeReview: fakeWriteReview })));
  });

  it.live("反映前の確定した発言は、自分の speaking にも出る（emit が relay.remark へつながる。base:301）", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();

      yield* sink.final(finalRemark("自分", 1, 2, "面接は何回にしますか"));

      yield* waitUntil(() => speaks.some((f) => f.track === "自分" && f.text.includes("面接は何回にしますか")), 5_000);
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeRecordingUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));

  it.live("同じ sessionsDir の 2 つ目のセッションは、発言が 1 件も無くても、作成直後の export.json がそのセッションのマップ（前のセッションではない。base:510）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const noop = { publish: () => Effect.void, speak: () => Effect.void };
      const firstDir = yield* sinks.createDir(sessionsDir);
      const first = yield* sinks.open({ dir: firstDir, title: "前", ...noop });
      yield* first.final(finalRemark("相手", 1, 2, "前の発言"));
      yield* first.flush;
      yield* first.exports;
      yield* realDelay(5); // フォルダ名は開始時刻（ミリ秒）
      const secondDir = yield* sinks.createDir(sessionsDir);
      yield* sinks.open({ dir: secondDir, title: "今", ...noop });

      expect(secondDir).not.toBe(firstDir);
      const exported = JSON.parse(readFileSync(join(secondDir, "export.json"), "utf8"));
      expect(JSON.stringify(exported)).toContain("今");
      expect(JSON.stringify(exported)).not.toContain("前の発言");
    })).pipe(Effect.provide(SessionSinks.layer({ openUpdater: makeRecordingUpdater().openUpdater, capture: fakeCapture, writeReview: fakeWriteReview }))));
});
