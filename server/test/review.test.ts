import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { REVIEW_AUDIO_ELEMENT_ID, REVIEW_LICENSES_ELEMENT_ID, REVIEW_LOG_ELEMENT_ID, embedReviewAudio, embedReviewLicenses, embedReviewLog, makeSession, reviewSnapshot, type LogEvent, type Op, type Remark } from "../src/core/index.ts";
import { embeddedAudio, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";
import { embeddedText, TEMPLATE } from "./fixtures/review.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

// 書き出す HTML への埋め込み（ログ・ライセンス・音声）とスナップショットの組み立て。ファイルは使わない

// 埋め込んだ <template> 要素の中身を、ブラウザが textContent で返すのと同じ文字列に戻す（タグの間の文字列を、実体参照を解いて返す）
function licensesTemplate(html: string): { raw: string; decoded: string } {
  const match = new RegExp(`<template id="${REVIEW_LICENSES_ELEMENT_ID}">([\\s\\S]*?)</template>`).exec(html);
  if (!match) throw new Error("ライセンスの要素がありません");
  const raw = match[1]!;
  return { raw, decoded: raw.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&") };
}

const remark = (id: string, text: string, extra: Partial<Remark> = {}): Remark => ({ id, track: "相手", start: 0, end: 5, text, ...extra });

// 発言と差分更新を通した本物のログ（at 付き JSONL 1 行ぶんの形）
const realisticEvents = Effect.fn("realisticEvents")(function* () {
  const ops: Op[] = [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
  ];
  const events: LogEvent[] = [];
  const session = yield* makeSession({ title: "定例" }).pipe(
    Effect.provide(Layer.merge(updaterLayer(() => Effect.succeed({ ops })), collectLog(events))),
  );
  yield* session.push(remark("r1", "採用の話をします"));
  yield* session.push(remark("r2", "面接は何回にしますか"));
  yield* session.idle;
  return { session, events: events.map((e, i) => JSON.parse(JSON.stringify({ at: `2026-10-07T00:00:0${i}.000Z`, ...e }))) as unknown[] };
});

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

describe("embedReviewLicenses", () => {
  const LICENSES = "# Licenses\n\n## evil - 1.0.0 (MIT)\n\nPermission --> granted </body> </script> <!-- & &amp; &lt;b&gt; <template></template>\n";
  const SCRIPT_TEMPLATE = "<html><head><script type=\"module\">const s = \"</body>\";</script></head><body><div id=\"root\"></div></body></html>";

  it("文言を <template> に入れる。中身に生の < > は無く、実体参照を解くと元の文言そのままに戻る", () => {
    const html = embedReviewLicenses(SCRIPT_TEMPLATE, LICENSES);

    const { raw, decoded } = licensesTemplate(html);
    expect(raw).not.toMatch(/[<>]/);
    expect(decoded).toBe(LICENSES);
    expect(html.match(/<template/g)).toHaveLength(1);
  });

  it("文言の中の </body>・</script>・--> があっても、HTML の形を壊さず、続けて埋め込むログも最後の本物の </body> の直前に入る", () => {
    const events = [{ type: "start", title: "t" }];
    const withLicenses = embedReviewLicenses(SCRIPT_TEMPLATE, LICENSES);
    const html = embedReviewLog(withLicenses, events);

    expect(JSON.parse(embeddedText(html))).toEqual(events);
    expect(licensesTemplate(html).decoded).toBe(LICENSES);
    // 文言の要素はログの要素より前、本物の </body> の前
    const templateAt = html.indexOf(`<template id="${REVIEW_LICENSES_ELEMENT_ID}">`);
    expect(templateAt).toBeGreaterThan(html.indexOf("<div id=\"root\"></div>"));
    expect(html.indexOf(`id="${REVIEW_LOG_ELEMENT_ID}"`)).toBeGreaterThan(html.indexOf("</template>"));
    // テンプレートの JS の文字列は変わらず、</body> の数も増えない（文言の </body> は実体参照になっている）
    expect(html).toContain("const s = \"</body>\";</script></head>");
    expect(html.match(/<\/body>/g)).toHaveLength(2);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html.endsWith("</script></body></html>")).toBe(true);
    expect(html).not.toContain("-->");
  });

  it("テンプレートに </body> が無ければ throw する", () => {
    expect(() => embedReviewLicenses("<html><head></head></html>", LICENSES)).toThrow();
  });
});

describe("embedReviewAudio", () => {
  const SCRIPT_TEMPLATE = "<html><head><script type=\"module\">const s = \"</body>\";</script></head><body><div id=\"root\"></div></body></html>";

  it("base64 の音声を、REVIEW_AUDIO_ELEMENT_ID の要素として最後の </body> の直前に入れ、読み戻すと元のバイト列になる。テンプレートの JS の文字列は変えない", () => {
    const html = embedReviewAudio(SCRIPT_TEMPLATE, FAKE_MIX_BYTES.toString("base64"));

    expect(embeddedAudio(html)).toEqual(FAKE_MIX_BYTES);
    expect(html.indexOf(`id="${REVIEW_AUDIO_ELEMENT_ID}"`)).toBeGreaterThan(html.indexOf("<div id=\"root\"></div>"));
    expect(html).toContain("const s = \"</body>\";</script></head>");
    expect(html.match(/<\/body>/g)).toHaveLength(2);
    expect(html.endsWith("</body></html>")).toBe(true);
  });

  it("ログの要素と並べても、どちらも最後の本物の </body> の直前にあり、それぞれ読み戻せる。要素の id は別", () => {
    const events = [{ type: "start", title: "t" }];
    const html = embedReviewAudio(embedReviewLog(SCRIPT_TEMPLATE, events), FAKE_MIX_BYTES.toString("base64"));

    expect(JSON.parse(embeddedText(html))).toEqual(events);
    expect(embeddedAudio(html)).toEqual(FAKE_MIX_BYTES);
    expect(REVIEW_AUDIO_ELEMENT_ID).not.toBe(REVIEW_LOG_ELEMENT_ID);
    expect(html.match(/<\/body>/g)).toHaveLength(2);
  });

  it("テンプレートに </body> が無ければ throw する", () => {
    expect(() => embedReviewAudio("<html><head></head></html>", "AAAA")).toThrow();
  });
});

describe("reviewSnapshot", () => {
  // web の入口（main.tsx）が同期で呼ぶので、reviewSnapshot は Effect にせず同期の関数のまま保つ
  it.effect("ログの出来事から、元のセッションの最後の時点と同じマップ・「変わったこと」・根拠を同期で組み立てる", () =>
    Effect.gen(function* () {
      const { session, events } = yield* realisticEvents();
      const snapshot = reviewSnapshot(events);

      expect(snapshot).toEqual(yield* session.snapshot);
      expect(snapshot.nodes.map((n) => n.text)).toEqual(["定例", "採用", "面接は何回か"]);
      expect(snapshot.changes.length).toBeGreaterThan(0);
      expect(snapshot.remarks.map((r) => r.id)).toEqual(["r1", "r2"]);
    }));

  it.effect("取り込みの記録（知らない type）の行があっても、マップは変わらない", () =>
    Effect.gen(function* () {
      const { session, events } = yield* realisticEvents();
      const withIntake = [...events.slice(0, 2), { at: "2026-10-07T00:00:09.000Z", type: "intake", note: "x" }, ...events.slice(2)];

      expect(reviewSnapshot(withIntake)).toEqual(yield* session.snapshot);
    }));

  it.effect("diff の行に usage があっても、usage の無い行と同じマップが組み立てられる", () =>
    Effect.gen(function* () {
      const { session, events } = yield* realisticEvents();
      const usage = { input: 10, cacheWrite: 20, cacheRead: 30, output: 40, model: "claude-haiku-5-5" };
      const withUsage = events.map((e) => ((e as { type: string }).type === "diff" ? { ...(e as object), usage } : e));

      expect(withUsage.some((e) => (e as { usage?: unknown }).usage !== undefined)).toBe(true);
      expect(reviewSnapshot(withUsage)).toEqual(yield* session.snapshot);
    }));

  it("壊れたログ（start が無い・項目が壊れた行）では、今と同じく例外を投げる", () => {
    expect(() => reviewSnapshot([])).toThrow();
    expect(() => reviewSnapshot([{ type: "start", title: "定例" }, { type: "remark" }])).toThrow();
  });
});
