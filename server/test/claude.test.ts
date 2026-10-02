import { describe, expect, it } from "vitest";
import { buildPrompt, openClaudeUpdater, QUERY_RENEW_CALLS } from "../src/claude.ts";
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
