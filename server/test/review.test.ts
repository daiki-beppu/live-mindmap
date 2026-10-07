import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { REVIEW_LOG_ELEMENT_ID, createSession, embedReviewLog, reviewSnapshot, type LogEvent, type Op, type Remark } from "../src/core/index.ts";
import { ReviewBuild, ReviewPageFailed, writeReviewPages } from "../src/review.ts";

const TEMPLATE = "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>";

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-review-test-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

// 埋め込んだ JSON 要素の中身を取り出す（ブラウザの textContent と同じく、タグの間の文字列そのもの）
function embeddedText(html: string): string {
  const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!match) throw new Error("埋め込みの要素がありません");
  return match[1]!;
}

const fakeBuild = (build: () => Effect.Effect<string, ReviewPageFailed>) =>
  Effect.provideService(ReviewBuild, ReviewBuild.of({ build }));

const remark = (id: string, text: string, extra: Partial<Remark> = {}): Remark => ({ id, track: "相手", start: 0, end: 5, text, ...extra });

// 発言と差分更新を通した本物のログ（at 付き JSONL 1 行ぶんの形）
async function realisticEvents() {
  const ops: Op[] = [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
  ];
  const events: LogEvent[] = [];
  const session = createSession({ title: "定例", updater: async () => ({ ops }), log: (e) => events.push(e) });
  session.push(remark("r1", "採用の話をします"));
  session.push(remark("r2", "面接は何回にしますか"));
  await session.idle();
  return { session, events: events.map((e, i) => JSON.parse(JSON.stringify({ at: `2026-10-07T00:00:0${i}.000Z`, ...e }))) as unknown[] };
}

describe("embedReviewLog", () => {
  it("出来事を <script type=\"application/json\"> に入れる。中身に生の < は 1 つも無く、JSON.parse すると元の出来事に戻る", () => {
    const events = [
      { type: "start", title: "</script><script>alert(1)</script>" },
      { type: "remark", remark: { id: "r1", text: "<!-- <b>&</b> -->" } },
    ];
    const html = embedReviewLog(TEMPLATE, events);

    const text = embeddedText(html);
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual(events);
    // 発言の中の </script> で、要素が早く閉じない
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("テンプレートの JS の文字列に </body> があっても、最後の本物の </body> の直前に入れ、JS の文字列は変えない", () => {
    const template = "<html><head><script type=\"module\">const s = \"</body>\";</script></head><body><div id=\"root\"></div></body></html>";
    const html = embedReviewLog(template, [{ type: "start", title: "t" }]);

    expect(html).toContain("const s = \"</body>\";</script></head>");
    expect(html.indexOf(`id="${REVIEW_LOG_ELEMENT_ID}"`)).toBeGreaterThan(html.indexOf("<div id=\"root\"></div>"));
    expect(html.endsWith("</script></body></html>")).toBe(true);
    expect(html.match(/<\/body>/g)).toHaveLength(2);
  });

  it("テンプレートに </body> が無ければ throw する", () => {
    expect(() => embedReviewLog("<html><head></head></html>", [])).toThrow();
  });
});

describe("reviewSnapshot", () => {
  it("ログの出来事から、元のセッションの最後の時点と同じマップ・「変わったこと」・根拠を組み立てる", async () => {
    const { session, events } = await realisticEvents();
    const snapshot = reviewSnapshot(events);

    expect(snapshot).toEqual(session.snapshot());
    expect(snapshot.nodes.map((n) => n.text)).toEqual(["定例", "採用", "面接は何回か"]);
    expect(snapshot.changes.length).toBeGreaterThan(0);
    expect(snapshot.remarks.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("取り込みの記録（知らない type）の行があっても、マップは変わらない", async () => {
    const { session, events } = await realisticEvents();
    const withIntake = [...events.slice(0, 2), { at: "2026-10-07T00:00:09.000Z", type: "intake", note: "x" }, ...events.slice(2)];

    expect(reviewSnapshot(withIntake)).toEqual(session.snapshot());
  });
});

describe("writeReviewPages", () => {
  it.effect("log.jsonl の出来事（空行は除く・行末の改行あり）を、版ごとに 1 つの HTML へ埋め込んで書き、パスを版の順に返す。ビルドは 1 回だけ", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const events = [{ at: "a", type: "start", title: "定例" }, { at: "b", type: "intake", note: "x" }];
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify(events[0])}\n\n${JSON.stringify(events[1])}\n`);
    let builds = 0;

    const paths = yield* writeReviewPages(dir, logPath, [{ file: "map.html" }, { file: "second.html" }]).pipe(
      fakeBuild(() => Effect.sync(() => { builds++; return TEMPLATE; })),
    );

    expect(paths).toEqual([join(dir, "map.html"), join(dir, "second.html")]);
    expect(builds).toBe(1);
    for (const path of paths) {
      const html = yield* Effect.tryPromise(() => readFile(path, "utf8"));
      expect(JSON.parse(embeddedText(html))).toEqual(events);
    }
  }));

  it.effect("ビルドが失敗したら ReviewPageFailed になり、何も書かない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n`);

    const result = yield* Effect.result(
      writeReviewPages(dir, logPath, [{ file: "map.html" }]).pipe(fakeBuild(() => Effect.fail(new ReviewPageFailed({ message: "ビルドに失敗" })))),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewPageFailed);
      expect(result.failure.message).toContain("ビルドに失敗");
    }
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));

  it.effect("読めない行があれば ReviewPageFailed にし、理由に行番号（空行を数える）を含める。HTML は書かない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n\n{broken\n`);

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [{ file: "map.html" }]).pipe(fakeBuild(() => Effect.succeed(TEMPLATE))));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewPageFailed);
      expect(result.failure.message).toContain("3");
    }
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));

  it.effect("テンプレートに </body> が無ければ ReviewPageFailed になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n`);

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [{ file: "map.html" }]).pipe(fakeBuild(() => Effect.succeed("<html></html>"))));

    expect(Result.isFailure(result) && result.failure instanceof ReviewPageFailed).toBe(true);
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));
});

