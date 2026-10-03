import { describe, expect, it } from "vitest";
import { buildPrompt, NOOP_SCOPE, openClaudeUpdater, QUERY_RENEW_CALLS } from "../src/claude.ts";
import { applyOps } from "../src/core/index.ts";
import { emptyMap, type DiffInput, type Op } from "../src/core/index.ts";

// 偽の query()。prompt（AsyncIterable）から user メッセージを 1 つ読むたびに、behave の指示どおり 1 回分の応答を返す。
//   ok: success の result（structured_output つき） / fail: success 以外の result / throw: iterator が例外 / end: result を出さずにストリームが終わる
//   hang: 何も返さない（close しても待ち続ける偽物。updater 側が close で reject を保証できることを確かめる）
type Behavior = "ok" | "fail" | "throw" | "end" | "hang";
type Message = { type: string; message?: { role?: string; content?: unknown }; parent_tool_use_id?: unknown };
type Created = { messages: Message[]; closeCalls: number };

function setup(behave: (queryIndex: number, messageIndex: number) => Behavior = () => "ok") {
  const created: Created[] = [];
  const run = ((params: { prompt: AsyncIterable<Message> }) => {
    const record: Created = { messages: [], closeCalls: 0 };
    const queryIndex = created.push(record) - 1;
    const gen = (async function* () {
      for await (const message of params.prompt) {
        const messageIndex = record.messages.push(message) - 1;
        const behavior = behave(queryIndex, messageIndex);
        if (behavior === "hang") await new Promise<never>(() => {});
        if (behavior === "throw") throw new Error("CLI が落ちた");
        if (behavior === "end") return;
        yield { type: "assistant" }; // result 以外のメッセージは読み飛ばされる
        if (behavior === "fail") yield { type: "result", subtype: "error_during_execution" };
        else yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: `q${queryIndex}-m${messageIndex}` }] } };
      }
    })();
    return Object.assign(gen, { close: () => void record.closeCalls++ });
  }) as unknown as Parameters<typeof openClaudeUpdater>[0];
  return { created, updater: openClaudeUpdater(run) };
}

// 呼び出しごとに内容の違う入力（マップ全体と発言が毎回変わる）
const input = (n: number): DiffInput => ({
  map: emptyMap(`会議${n}`),
  recent: [],
  fresh: [{ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}` }],
});
const noop = (reason: string): Op[] => [{ op: "noop", reason }];
const contents = (c: Created) => c.messages.map((m) => m.message?.content);

describe("差分更新の query の使い回し", () => {
  it("最初の呼び出しまでは query を開かない", () => {
    const { created } = setup();

    expect(created).toHaveLength(0);
  });

  it("2 回呼んでも query は 1 つで、2 つのメッセージが同じ query に届く。各メッセージは、その回の入力の buildPrompt と一致する", async () => {
    const { created, updater } = setup();

    const first = await updater.update(input(1));
    const second = await updater.update(input(2));

    expect(created).toHaveLength(1);
    expect(created[0]!.messages.map((m) => [m.type, m.message?.role, m.parent_tool_use_id])).toEqual([
      ["user", "user", null],
      ["user", "user", null],
    ]);
    expect(contents(created[0]!)).toEqual([buildPrompt(input(1)), buildPrompt(input(2))]);
    expect(first.ops).toEqual(noop("q0-m0"));
    expect(second.ops).toEqual(noop("q0-m1"));
  });

  it("QUERY_RENEW_CALLS 回目までは同じ query を使い、次の 1 回で古い query を閉じて新しい query を開く。開き直したあとも、その回の入力のマップ全体を送る", async () => {
    const { created, updater } = setup();

    for (let n = 1; n <= QUERY_RENEW_CALLS; n++) await updater.update(input(n));
    expect(created).toHaveLength(1);
    expect(created[0]!.messages).toHaveLength(QUERY_RENEW_CALLS);
    expect(created[0]!.closeCalls).toBe(0);

    const next = QUERY_RENEW_CALLS + 1;
    const output = await updater.update(input(next));

    expect(created).toHaveLength(2);
    expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    expect(created[0]!.messages).toHaveLength(QUERY_RENEW_CALLS); // 古い query には流し込まない
    expect(contents(created[1]!)).toEqual([buildPrompt(input(next))]);
    expect(output.ops).toEqual(noop("q1-m0"));
  });

  it("開き直したあとも、回数は数え直されて、次の QUERY_RENEW_CALLS 回は同じ query を使う", async () => {
    const { created, updater } = setup();

    for (let n = 1; n <= QUERY_RENEW_CALLS * 2; n++) await updater.update(input(n));
    expect(created).toHaveLength(2);
    await updater.update(input(QUERY_RENEW_CALLS * 2 + 1));

    expect(created).toHaveLength(3);
    expect(created[1]!.messages).toHaveLength(QUERY_RENEW_CALLS);
  });
});

describe("差分更新の失敗後の開き直し", () => {
  it.each(["fail", "throw", "end"] as const)("%s の呼び出しはエラーになり、次の呼び出しは古い query を閉じて、新しい query で続く", async (failure) => {
    const { created, updater } = setup((q, m) => (q === 0 && m === 1 ? failure : "ok"));
    await updater.update(input(1));

    await expect(updater.update(input(2))).rejects.toThrow();
    const output = await updater.update(input(3));

    expect(created).toHaveLength(2);
    expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    expect(created[0]!.messages).toHaveLength(2); // 失敗後に古い query へは流し込まない
    expect(contents(created[1]!)).toEqual([buildPrompt(input(3))]);
    expect(output.ops).toEqual(noop("q1-m0"));
  });

  it("success 以外の result は、結果の種類を含むエラーになり、空の ops の成功にはならない", async () => {
    const { updater } = setup(() => "fail");

    await expect(updater.update(input(1))).rejects.toThrow("差分更新に失敗: error_during_execution");
  });

  it("失敗した回は、開き直しまでの回数に数えない（開き直した query は、新しく QUERY_RENEW_CALLS 回使える）", async () => {
    const { created, updater } = setup((q, m) => (q === 0 && m === 0 ? "fail" : "ok"));
    await expect(updater.update(input(0))).rejects.toThrow();

    for (let n = 1; n <= QUERY_RENEW_CALLS; n++) await updater.update(input(n));

    expect(created).toHaveLength(2);
    expect(created[1]!.messages).toHaveLength(QUERY_RENEW_CALLS);
  });
});

describe("差分更新の query の後片付け", () => {
  it("close() で、開いたすべての query が閉じられる（開いた数と閉じた数が合う）。何度呼んでもよい", async () => {
    const { created, updater } = setup((q, m) => (q === 0 && m === 0 ? "fail" : "ok"));
    await expect(updater.update(input(1))).rejects.toThrow();
    await updater.update(input(2));
    await updater.update(input(3));
    expect(created).toHaveLength(2);

    updater.close();
    updater.close();

    for (const c of created) expect(c.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("一度も呼ばずに close() しても、query は開かれない", () => {
    const { created, updater } = setup();

    updater.close();

    expect(created).toHaveLength(0);
  });

  it("close() のあとの update は、query を開かずに拒否する", async () => {
    const { created, updater } = setup();
    await updater.update(input(1));
    updater.close();

    await expect(updater.update(input(2))).rejects.toThrow();

    expect(created).toHaveLength(1);
  });

  it("close() のあとの update は、開き直しの回数に達していても、新しい query を開かない", async () => {
    const { created, updater } = setup();
    for (let n = 1; n <= QUERY_RENEW_CALLS; n++) await updater.update(input(n));
    updater.close();

    await expect(updater.update(input(QUERY_RENEW_CALLS + 1))).rejects.toThrow();

    expect(created).toHaveLength(1);
  });

  it("呼び出しの途中（応答待ち）で close() すると、その呼び出しは拒否される。query は閉じられる", async () => {
    const { created, updater } = setup(() => "hang");
    const pending = updater.update(input(1)).then(
      () => "resolved",
      () => "rejected",
    );
    await new Promise((resolve) => setImmediate(resolve)); // メッセージが query に届くまで待つ
    expect(created[0]!.messages).toHaveLength(1);

    updater.close();

    expect(await pending).toBe("rejected");
    expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });
});

// query() に渡された options（systemPrompt と出力スキーマ）を記録する偽物
type Options = { systemPrompt: string; outputFormat: { schema: unknown } };
async function capturedOptions(calls = 1): Promise<Options[]> {
  const seen: Options[] = [];
  const run = ((params: { prompt: AsyncIterable<Message>; options: Options }) => {
    seen.push(params.options);
    const gen = (async function* () {
      for await (const _ of params.prompt) {
        yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "r" }] } };
      }
    })();
    return Object.assign(gen, { close: () => {} });
  }) as unknown as Parameters<typeof openClaudeUpdater>[0];
  const updater = openClaudeUpdater(run);
  for (let n = 1; n <= calls; n++) await updater.update(input(n));
  updater.close();
  return seen;
}
const systemPrompt = async () => (await capturedOptions())[0]!.systemPrompt;
const count = (text: string, part: string) => text.split(part).length - 1;

describe("system プロンプト: noop にする範囲", () => {
  it("範囲の定義 NOOP_SCOPE が、見出し「# noop にする範囲」の下に 1 回だけ現れる", async () => {
    const sys = await systemPrompt();

    expect(NOOP_SCOPE).toEqual(expect.any(String));
    expect(count(sys, NOOP_SCOPE)).toBe(1);
    expect(count(sys, "# noop にする範囲")).toBe(1);
    expect(sys.indexOf(NOOP_SCOPE)).toBeGreaterThan(sys.indexOf("# noop にする範囲"));
  });

  it("NOOP_SCOPE は、相づち・進行の段取り・聞き取れない断片・同じ内容の言い直しの 4 つを定義し、雑談や解説は noop の範囲に入れない", () => {
    for (const part of ["相づち", "進行の段取り", "聞き取れない断片", "同じ内容の言い直し"]) expect(NOOP_SCOPE).toContain(part);
    expect(NOOP_SCOPE).not.toContain("雑談、");
    expect(NOOP_SCOPE).not.toContain("番組の解説");
  });

  it("雑談・番組の解説を noop にする旧い指示と、迷ったら何もしない指示は残らない", async () => {
    const sys = await systemPrompt();

    expect(sys).not.toContain("雑談、番組の解説のような");
    expect(sys).not.toContain("迷ったら何もしない");
  });

  it("noop を広げる語は NOOP_SCOPE の外に書かれていない（noop の条件の定義は 1 か所）", async () => {
    const outside = (await systemPrompt()).replace(NOOP_SCOPE, "");

    expect(outside).not.toMatch(/(雑談|解説|挨拶)[^。\n]*noop にする/);
  });
});

describe("system プロンプト: 共有・雑談型の会議で話題と要点を残す", () => {
  it("要点を、紹介・体験談・おすすめ・質問とその答えを表す種別として語彙に定義する", async () => {
    const sys = await systemPrompt();

    const line = sys.split("\n").find((l) => l.startsWith("- 要点:"));
    expect(line).toBeDefined();
    for (const part of ["紹介", "体験談", "おすすめ"]) expect(line).toContain(part);
  });

  it("決定がなくても、話題を議題として立てて要点を残す指示がある", async () => {
    const sys = await systemPrompt();

    expect(sys).toMatch(/決定がなくても/);
    expect(sys).toMatch(/議題として立て/);
  });

  it("紹介・解説・体験談の中の「〜にする」を、決定や TODO にせず要点にする指示がある。決定と TODO の既存の指示も残る", async () => {
    const sys = await systemPrompt();

    expect(sys).toContain("決定や TODO にせず、要点にする");
    expect(sys).toContain("「〜にしましょう」「〜を結論とする」「〜を基準にする」のような合意は決定にする");
    expect(sys).toContain("「〜さんが〜する」「〜を持ち帰る」「〜に当たる」のように、誰かが後でやると決まった作業は TODO にする");
  });

  it("目安（60 分で 50 ノード前後・深さ 4 段）の指示が残り、深さの例に要点が入る", async () => {
    const sys = await systemPrompt();

    expect(sys).toContain("60 分の会議で 50 ノード前後、root からの深さ 4 段");
    expect(sys).toMatch(/案・課題・決定・要点/);
  });

  it("出力スキーマの add の kind に要点が入る", async () => {
    const schema = JSON.stringify((await capturedOptions())[0]!.outputFormat.schema);

    expect(schema).toContain('"要点"');
  });
});

describe("system プロンプトは会議の種類によらず 1 つ", () => {
  it("入力の違う 2 回の呼び出しと、開き直したあとの query で、systemPrompt は同じ文字列", async () => {
    const seen = await capturedOptions(QUERY_RENEW_CALLS + 1);

    expect(seen).toHaveLength(2);
    expect(seen[1]!.systemPrompt).toBe(seen[0]!.systemPrompt);
  });
});

describe("種別「要点」の経路", () => {
  it("buildPrompt のアウトラインに「要点:」の行が、親の字下げの下に出る", () => {
    const known = new Set(["r1", "r2"]);
    const { map } = applyOps(
      emptyMap("共有会"),
      [
        { op: "add", ref: "a", parent: "root", kind: "議題", text: "ふりかえりのやり方", evidence: ["r1"] },
        { op: "add", ref: "b", parent: "a", kind: "要点", text: "毎週 15 分で回している", evidence: ["r2"] },
      ],
      known,
    );

    const prompt = buildPrompt({ map, recent: [], fresh: [{ id: "r3", track: "相手", start: 3, end: 4, text: "x" }] });

    expect(prompt).toMatch(/^ {2}- n1 議題: ふりかえりのやり方$/m);
    expect(prompt).toMatch(/^ {4}- n2 要点: 毎週 15 分で回している$/m);
  });
});
