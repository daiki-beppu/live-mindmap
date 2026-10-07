import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { AgentSdk, buildPrompt, ClaudeDiffUpdater, NOOP_SCOPE, QUERY_RENEW_CALLS } from "../src/claude.ts";
import { applyOps, DiffUpdater } from "../src/core/index.ts";
import { emptyMap, type DiffInput, type MeetingMap, type Op } from "../src/core/index.ts";

// 偽の query()。prompt（AsyncIterable）から user メッセージを 1 つ読むたびに、behave の指示どおり 1 回分の応答を返す。
//   ok: success の result（structured_output つき） / fail: success 以外の result / throw: iterator が例外 / end: result を出さずにストリームが終わる
//   missing: success だが structured_output が無い / invalid: success だが structured_output が DiffOutput の形に合わない
//   extra: success で、structured_output の操作に余分なキーがある
//   hang: 何も返さない（Scope を閉じても待ち続ける偽物。呼び出し側が中断で離れられることを確かめる）
type Behavior = "ok" | "fail" | "throw" | "end" | "missing" | "invalid" | "extra" | "hang";
type Message = { type: string; message?: { role?: string; content?: unknown }; parent_tool_use_id?: unknown };
type Created = { messages: Message[]; closeCalls: number; options: Options };
// query() に渡された options（systemPrompt・出力スキーマ・env）
type Options = { systemPrompt: string; outputFormat: { type: string; schema: unknown }; env?: Record<string, string | undefined> };

const noopOutput = (reason: string) => ({ ops: [{ op: "noop", reason }] });

const fakeQuery = (created: Created[], behave: (queryIndex: number, messageIndex: number) => Behavior) =>
  ((params: { prompt: AsyncIterable<Message>; options: Options }) => {
    const record: Created = { messages: [], closeCalls: 0, options: params.options };
    const queryIndex = created.push(record) - 1;
    const gen = (async function* () {
      for await (const message of params.prompt) {
        const messageIndex = record.messages.push(message) - 1;
        const behavior = behave(queryIndex, messageIndex);
        if (behavior === "hang") await new Promise<never>(() => {});
        if (behavior === "throw") throw new Error("CLI が落ちた");
        if (behavior === "end") return;
        yield { type: "assistant" }; // result 以外のメッセージは読み飛ばされる
        const result = { type: "result" };
        if (behavior === "fail") yield { ...result, subtype: "error_during_execution" };
        else if (behavior === "missing") yield { ...result, subtype: "success" };
        else if (behavior === "invalid") yield { ...result, subtype: "success", structured_output: { ops: [{ op: "add", evidence: [] }] } };
        else if (behavior === "extra") yield { ...result, subtype: "success", structured_output: { ops: [{ op: "noop", reason: "extra", unknown: 1 }], note: "x" } };
        else yield { ...result, subtype: "success", structured_output: noopOutput(`q${queryIndex}-m${messageIndex}`) };
      }
    })();
    return Object.assign(gen, { close: () => void record.closeCalls++ });
  }) as unknown as AgentSdk["Service"]["query"];

// 偽の AgentSdk を ClaudeDiffUpdater.layer に渡し、手で作った Scope（セッションの Scope の代わり）の中で build する。
// close は Scope を閉じる操作（旧 updater.close() の代わり）。何度呼んでもよい
function setup(behave: (queryIndex: number, messageIndex: number) => Behavior = () => "ok") {
  return Effect.gen(function* () {
    const created: Created[] = [];
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const sdk = Layer.succeed(AgentSdk, AgentSdk.of({ query: fakeQuery(created, behave) }));
    const context = yield* Layer.buildWithScope(ClaudeDiffUpdater.layer.pipe(Layer.provide(sdk)), scope);
    const updater = Context.get(context, DiffUpdater);
    return { created, updater, scope, close: Scope.close(scope, Exit.void) };
  });
}

// 呼び出しごとに内容の違う入力（マップ全体と発言が毎回変わる）
const input = (n: number): DiffInput => ({
  map: emptyMap(`会議${n}`),
  recent: [],
  fresh: [{ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}` }],
});
const noop = (reason: string): Op[] => [{ op: "noop", reason }];
const contents = (c: Created) => c.messages.map((m) => m.message?.content);
const texts = (c: Created) => contents(c) as string[];

// 発言 id r1〜r40 を、根拠に使える既知の発言として applyOps に渡す
const KNOWN = new Set(Array.from({ length: 40 }, (_, i) => `r${i + 1}`));
const evolve = (map: MeetingMap, ops: Op[]) => applyOps(map, ops, KNOWN);
const inputOf = (map: MeetingMap, n: number): DiffInput => ({
  map,
  recent: n > 1 ? [{ id: `r${n - 1}`, track: "相手", start: n - 1, end: n, text: `前の発言${n - 1}` }] : [],
  fresh: [{ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `新しい発言${n}` }],
});

// n 回目の呼び出しの入力。n 回目までに「議題A」「議題B」…を 1 つずつ足したマップ（呼び出しごとに 1 ノード増える）
const SUBJECTS = Array.from({ length: 26 }, (_, i) => `議題${String.fromCharCode(65 + i)}`);
const growingMaps: MeetingMap[] = [emptyMap("会議")];
for (const text of SUBJECTS) {
  growingMaps.push(evolve(growingMaps.at(-1)!, [{ op: "add", ref: "a", parent: "root", kind: "議題", text, evidence: ["r1"] }]).map);
}
const growing = (n: number): DiffInput => inputOf(growingMaps[n]!, n);

// メッセージが偽の query に届くまで、実時間の 1 周を待つ
const nextTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("差分更新の query の使い回し", () => {
  it.effect("最初の呼び出しまでは query を開かない（Layer を build しただけでは開かない）", () =>
    Effect.gen(function* () {
      const { created } = yield* setup();

      expect(created).toHaveLength(0);
    }));

  it.effect("2 回呼んでも query は 1 つで、2 つのメッセージが同じ query に届く。1 通目はその回の入力の buildPrompt（マップ全体）と一致し、2 通目はマップ全体ではなく変更だけを載せる", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();

      const first = yield* updater.update(growing(1));
      const second = yield* updater.update(growing(2));

      expect(created).toHaveLength(1);
      expect(created[0]!.messages.map((m) => [m.type, m.message?.role, m.parent_tool_use_id])).toEqual([
        ["user", "user", null],
        ["user", "user", null],
      ]);
      expect(texts(created[0]!)[0]).toBe(buildPrompt(growing(1)));
      expect(texts(created[0]!)[1]).not.toBe(buildPrompt(growing(2)));
      expect(first.ops).toEqual(noop("q0-m0"));
      expect(second.ops).toEqual(noop("q0-m1"));
    }));

  it.effect("QUERY_RENEW_CALLS 回目までは同じ query を使い、次の 1 回で古い query を閉じて新しい query を開く。開き直したあとも、その回の入力のマップ全体を送る", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();

      for (let n = 1; n <= QUERY_RENEW_CALLS; n++) yield* updater.update(input(n));
      expect(created).toHaveLength(1);
      expect(created[0]!.messages).toHaveLength(QUERY_RENEW_CALLS);
      expect(created[0]!.closeCalls).toBe(0);

      const next = QUERY_RENEW_CALLS + 1;
      const output = yield* updater.update(input(next));

      expect(created).toHaveLength(2);
      expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
      expect(created[0]!.messages).toHaveLength(QUERY_RENEW_CALLS); // 古い query には流し込まない
      expect(contents(created[1]!)).toEqual([buildPrompt(input(next))]);
      expect(output.ops).toEqual(noop("q1-m0"));
    }));

  it.effect("開き直したあとも、回数は数え直されて、次の QUERY_RENEW_CALLS 回は同じ query を使う", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();

      for (let n = 1; n <= QUERY_RENEW_CALLS * 2; n++) yield* updater.update(input(n));
      expect(created).toHaveLength(2);
      yield* updater.update(input(QUERY_RENEW_CALLS * 2 + 1));

      expect(created).toHaveLength(3);
      expect(created[1]!.messages).toHaveLength(QUERY_RENEW_CALLS);
    }));
});

describe("差分更新の失敗後の開き直し", () => {
  it.effect.each(["fail", "throw", "end"] as const)("%s の呼び出しは失敗になり、次の呼び出しは古い query を閉じて、新しい query で続く", (failure) =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup((q, m) => (q === 0 && m === 1 ? failure : "ok"));
      yield* updater.update(input(1));

      yield* Effect.flip(updater.update(input(2)));
      const output = yield* updater.update(input(3));

      expect(created).toHaveLength(2);
      expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
      expect(created[0]!.messages).toHaveLength(2); // 失敗後に古い query へは流し込まない
      expect(contents(created[1]!)).toEqual([buildPrompt(input(3))]);
      expect(output.ops).toEqual(noop("q1-m0"));
    }));

  it.effect("失敗した回は、開き直しまでの回数に数えない（開き直した query は、新しく QUERY_RENEW_CALLS 回使える）", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup((q, m) => (q === 0 && m === 0 ? "fail" : "ok"));
      yield* Effect.flip(updater.update(input(0)));

      for (let n = 1; n <= QUERY_RENEW_CALLS; n++) yield* updater.update(input(n));

      expect(created).toHaveLength(2);
      expect(created[1]!.messages).toHaveLength(QUERY_RENEW_CALLS);
    }));
});

describe("差分更新の失敗のタグ", () => {
  it.effect("query が例外を投げると ClaudeQueryFailed になり、投げられた原因を cause に持つ。message に原因の文面が入る", () =>
    Effect.gen(function* () {
      const { updater } = yield* setup(() => "throw");

      const error = yield* Effect.flip(updater.update(input(1)));

      expect(error).toMatchObject({ _tag: "ClaudeQueryFailed" });
      expect(error.message).toContain("CLI が落ちた");
      expect((error as { cause?: unknown }).cause).toBeDefined();
    }));

  it.effect("result の前にストリームが終わると ClaudeQueryFailed になる", () =>
    Effect.gen(function* () {
      const { updater } = yield* setup(() => "end");

      const error = yield* Effect.flip(updater.update(input(1)));

      expect(error).toMatchObject({ _tag: "ClaudeQueryFailed", message: "差分更新の結果が無い" });
    }));

  it.effect("success 以外の result は ClaudeResultFailed になり、subtype を持つ。message は結果の種類を含み、空の ops の成功にはならない", () =>
    Effect.gen(function* () {
      const { updater } = yield* setup(() => "fail");

      const error = yield* Effect.flip(updater.update(input(1)));

      expect(error).toMatchObject({ _tag: "ClaudeResultFailed", subtype: "error_during_execution", message: "差分更新に失敗: error_during_execution" });
    }));
});

describe("structured_output の検証（Schema で decode）", () => {
  it.effect.each(["missing", "invalid"] as const)("success でも structured_output が %s なら DiffOutputInvalid になる（空の ops の成功にはならない）。その query は捨てられ、次の呼び出しは新しい query で続く", (failure) =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup((q, m) => (q === 0 && m === 0 ? failure : "ok"));

      const error = yield* Effect.flip(updater.update(input(1)));
      const output = yield* updater.update(input(2));

      expect(error).toMatchObject({ _tag: "DiffOutputInvalid" });
      expect(error.message).not.toBe("");
      expect(created).toHaveLength(2);
      expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
      expect(output.ops).toEqual(noop("q1-m0"));
    }));

  it.effect("余分なキーはエラーにならず、黙って落ちる（ops の操作の中も、ops の外も）", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup(() => "extra");

      const output = yield* updater.update(input(1));

      expect(output).toEqual({ ops: noop("extra") });
      expect(created[0]!.closeCalls).toBe(0);
    }));
});

describe("outputFormat の JSON Schema（DiffOutput から作る）", () => {
  // JSON Schema のノードを再帰的にたどる
  const walk = (node: unknown, visit: (n: Record<string, unknown>) => void): void => {
    if (Array.isArray(node)) return node.forEach((item) => walk(item, visit));
    if (node === null || typeof node !== "object") return;
    visit(node as Record<string, unknown>);
    for (const value of Object.values(node)) walk(value, visit);
  };
  const schemaOf = () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();
      yield* updater.update(input(1));
      return created[0]!.options.outputFormat;
    });

  it.effect("outputFormat は json_schema で、全部のオブジェクトが additionalProperties: false", () =>
    Effect.gen(function* () {
      const format = yield* schemaOf();
      const objects: Record<string, unknown>[] = [];
      walk(format.schema, (n) => {
        if (n.type === "object") objects.push(n);
      });

      expect(format.type).toBe("json_schema");
      expect(objects.length).toBeGreaterThanOrEqual(7); // 最上位 1 つと 6 操作
      for (const object of objects) expect(object.additionalProperties).toBe(false);
    }));

  it.effect("$ref が無い（参照は展開されている）", () =>
    Effect.gen(function* () {
      const { schema } = yield* schemaOf();
      let refs = 0;
      walk(schema, (n) => {
        if ("$ref" in n) refs++;
      });

      expect(refs).toBe(0);
    }));

  it.effect("DiffOutput の 6 操作（add・update・combine・move・delete・noop）が anyOf に入り、add と update の根拠は 1 件以上（minItems: 1）を要求する", () =>
    Effect.gen(function* () {
      const { schema } = yield* schemaOf();
      const operations = new Map<string, Record<string, unknown>>();
      walk(schema, (n) => {
        const properties = n.properties as Record<string, { const?: string; enum?: string[] }> | undefined;
        const op = properties?.op;
        const name = op?.const ?? op?.enum?.[0];
        if (name) operations.set(name, n);
      });

      expect([...operations.keys()].sort()).toEqual(["add", "combine", "delete", "move", "noop", "update"]);
      for (const name of ["add", "update"]) {
        const evidence = (operations.get(name)!.properties as Record<string, { minItems?: number }>).evidence;
        expect(evidence?.minItems).toBe(1);
      }
    }));

  it.effect("開き直した query にも同じ JSON Schema が渡る（モジュールで 1 回作った値）", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();
      for (let n = 1; n <= QUERY_RENEW_CALLS + 1; n++) yield* updater.update(input(n));

      expect(created).toHaveLength(2);
      expect(created[1]!.options.outputFormat.schema).toBe(created[0]!.options.outputFormat.schema);
    }));
});

describe("差分更新の query の後片付け（セッションの Scope）", () => {
  it.effect("Scope を閉じると、開いたすべての query が閉じられる（開いた数と閉じた数が合う）。何度閉じてもよい", () =>
    Effect.gen(function* () {
      const { created, updater, close } = yield* setup((q, m) => (q === 0 && m === 0 ? "fail" : "ok"));
      yield* Effect.flip(updater.update(input(1)));
      yield* updater.update(input(2));
      yield* updater.update(input(3));
      expect(created).toHaveLength(2);

      yield* close;
      yield* close;

      for (const c of created) expect(c.closeCalls).toBeGreaterThanOrEqual(1);
    }));

  it.effect("開き直しで閉じた query を、Scope を閉じるときにもう一度閉じ直す必要はない（古い query は開き直しの時点で閉じている）", () =>
    Effect.gen(function* () {
      const { created, updater, close } = yield* setup();
      for (let n = 1; n <= QUERY_RENEW_CALLS + 1; n++) yield* updater.update(input(n));
      expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
      expect(created[1]!.closeCalls).toBe(0);

      yield* close;

      expect(created[1]!.closeCalls).toBeGreaterThanOrEqual(1);
    }));

  it.effect("一度も呼ばずに Scope を閉じても、query は開かれない", () =>
    Effect.gen(function* () {
      const { created, close } = yield* setup();

      yield* close;

      expect(created).toHaveLength(0);
    }));

  it.effect("Scope を閉じたあとの update は、query を開かずに defect になる", () =>
    Effect.gen(function* () {
      const { created, updater, close } = yield* setup();
      yield* updater.update(input(1));
      yield* close;

      const exit = yield* Effect.exit(updater.update(input(2)));

      expect(Exit.hasDies(exit)).toBe(true);
      expect(created).toHaveLength(1);
    }));

  it.effect("Scope を閉じたあとの update は、開き直しの回数に達していても、新しい query を開かない", () =>
    Effect.gen(function* () {
      const { created, updater, close } = yield* setup();
      for (let n = 1; n <= QUERY_RENEW_CALLS; n++) yield* updater.update(input(n));
      yield* close;

      const exit = yield* Effect.exit(updater.update(input(QUERY_RENEW_CALLS + 1)));

      expect(Exit.hasDies(exit)).toBe(true);
      expect(created).toHaveLength(1);
    }));

  it.effect("呼び出しの途中（応答待ち）で Scope を閉じると、その呼び出しは待つのをやめて中断される。query は閉じられる", () =>
    Effect.gen(function* () {
      const { created, updater, scope, close } = yield* setup(() => "hang");
      const fiber = yield* Effect.forkIn(updater.update(input(1)), scope); // セッションの Scope に属する呼び出し
      yield* nextTick; // メッセージが query に届くまで待つ
      expect(created[0]!.messages).toHaveLength(1);

      yield* close;
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    }));
});

describe("差分更新: 開いた query の最初のメッセージだけがマップ全体、2 通目からは変更", () => {
  it.effect("2 通目と 3 通目にはマップ全体（「現在のマップ」の節と、すでに送ったノード）が載らず、その回に増えたノードだけが載る", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();

      for (let n = 1; n <= 3; n++) yield* updater.update(growing(n));

      const [first, second, third] = texts(created[0]!);
      expect(first).toContain("## 現在のマップ");
      expect(first).toContain("議題A");
      expect(second).not.toContain("## 現在のマップ");
      expect(second).toContain("議題B");
      expect(second).not.toContain("議題A");
      expect(third).not.toContain("## 現在のマップ");
      expect(third).toContain("議題C");
      expect(third).not.toContain("議題A");
      expect(third).not.toContain("議題B"); // 前回送った時点からの変更なので、2 通目の追加は載らない
    }));

  it.effect("2 通目にも、マップの状態・直前の発言・新しい発言の節が今どおり載る", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();

      yield* updater.update(growing(1));
      yield* updater.update(growing(2));

      const second = texts(created[0]!)[1]!;
      expect(second).toContain("## マップの状態");
      expect(second).toContain("ノード 2");
      expect(second).toContain("## 直前の発言");
      expect(second).toContain("前の発言1");
      expect(second).toContain("## 新しい発言");
      expect(second).toContain("新しい発言2");
    }));

  it.effect("QUERY_RENEW_CALLS 回の後に開き直した query の最初のメッセージには、再びマップ全体が載り、その次の呼び出しは変更だけになる。開き直す前の query の最後のメッセージは変更だった", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();

      for (let n = 1; n <= QUERY_RENEW_CALLS + 2; n++) yield* updater.update(growing(n));

      expect(created).toHaveLength(2);
      const old = texts(created[0]!);
      expect(old.at(-1)).not.toContain("## 現在のマップ");
      const [reopened, after] = texts(created[1]!);
      expect(reopened).toBe(buildPrompt(growing(QUERY_RENEW_CALLS + 1)));
      for (const subject of SUBJECTS.slice(0, QUERY_RENEW_CALLS + 1)) expect(reopened).toContain(subject);
      expect(after).not.toContain("## 現在のマップ");
      expect(after).toContain(SUBJECTS[QUERY_RENEW_CALLS + 1]);
      expect(after).not.toContain("議題A"); // 開き直す前に送ったマップは持ち越さない
    }));

  it.effect.each(["fail", "throw", "end"] as const)("%s の後に開いた query の最初のメッセージには、再びマップ全体が載る。失敗した回の入力は送った扱いにならない", (failure) =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup((q, m) => (q === 0 && m === 2 ? failure : "ok"));
      yield* updater.update(growing(1));
      yield* updater.update(growing(2));
      yield* Effect.flip(updater.update(growing(3)));

      yield* updater.update(growing(4));
      yield* updater.update(growing(5));

      expect(created).toHaveLength(2);
      const [reopened, after] = texts(created[1]!);
      expect(reopened).toBe(buildPrompt(growing(4)));
      for (const subject of SUBJECTS.slice(0, 4)) expect(reopened).toContain(subject);
      expect(after).not.toContain("## 現在のマップ");
      expect(after).toContain("議題E");
      expect(after).not.toContain("議題D");
    }));
});

describe("差分更新: 変更の中身", () => {
  // root > n1 議題 > n2 論点 > (n3 案, n4 案)、n2 の下に n5 TODO（担当・期限つき）、n1 の下に n6 課題・n7 議題、n7 の下に n8 課題 > n9 案
  const base = (() => {
    const ev = ["r1"];
    const { map, dropped } = evolve(emptyMap("会議"), [
      { op: "add", ref: "a", parent: "root", kind: "議題", text: "進め方", evidence: ev },
      { op: "add", ref: "b", parent: "a", kind: "論点", text: "どこで開催するか", evidence: ev },
      { op: "add", ref: "c", parent: "b", kind: "案", text: "オンライン", evidence: ev },
      { op: "add", ref: "d", parent: "b", kind: "案", text: "対面", evidence: ev },
      { op: "add", ref: "e", parent: "b", kind: "TODO", text: "会場を探す", evidence: ev, assignee: "佐藤", due: "来週" },
      { op: "add", ref: "f", parent: "a", kind: "課題", text: "予算が足りない", evidence: ev },
      { op: "add", ref: "g", parent: "root", kind: "議題", text: "別件", evidence: ev },
      { op: "add", ref: "h", parent: "g", kind: "課題", text: "予算不足", evidence: ev },
      { op: "add", ref: "i", parent: "h", kind: "案", text: "割り勘", evidence: ev },
    ]);
    expect(dropped).toEqual([]);
    return map;
  })();

  // base の次の呼び出しで届くメッセージ（同じ query の 2 通目）と、そのときの applyOps の捨てた操作
  const second = (from: MeetingMap, ops: Op[]) =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();
      yield* updater.update(inputOf(from, 1));
      const { map, dropped } = evolve(from, ops);
      yield* updater.update(inputOf(map, 2));
      return { message: texts(created[0]!)[1]!, dropped };
    });
  const line = (message: string, id: string) => message.split("\n").filter((l) => new RegExp(`\\b${id}\\b`).test(l));

  it.effect("追加: 付いた id・種別・本文・親が 1 行に載る。既存のノードは載らない", () =>
    Effect.gen(function* () {
      const { message } = yield* second(base, [{ op: "add", ref: "x", parent: "n2", kind: "課題", text: "雨天時の代替", evidence: ["r2"] }]);

      const added = line(message, "n10");
      expect(added).toHaveLength(1);
      expect(added[0]).toContain("課題");
      expect(added[0]).toContain("雨天時の代替");
      expect(added[0]).toMatch(/\bn2\b/);
      expect(message).not.toContain("会場を探す");
      expect(message).not.toContain("（変更なし）");
    }));

  it.effect("追加: 同じ応答の中で add した親子は、子の行の親に付いた id（仮 id ではない）が載る", () =>
    Effect.gen(function* () {
      const { message } = yield* second(base, [
        { op: "add", ref: "p", parent: "n1", kind: "議題", text: "懇親会", evidence: ["r2"] },
        { op: "add", ref: "q", parent: "p", kind: "要点", text: "金曜の夜", evidence: ["r2"] },
      ]);

      const child = line(message, "n11");
      expect(child).toHaveLength(1);
      expect(child[0]).toContain("金曜の夜");
      expect(child[0]).toMatch(/\bn10\b/);
      expect(message.indexOf("懇親会")).toBeLessThan(message.indexOf("金曜の夜"));
    }));

  it.effect("更新（本文）: 後の本文が載り、前の本文は載らない", () =>
    Effect.gen(function* () {
      const { message } = yield* second(base, [{ op: "update", node: "n3", text: "ハイブリッド開催", evidence: ["r2"] }]);

      const updated = line(message, "n3");
      expect(updated).toHaveLength(1);
      expect(updated[0]).toContain("ハイブリッド開催");
      expect(message).not.toContain("オンライン");
    }));

  it.effect("更新（論点の状態）: 子に決定が付いた論点は「決定済み」で載る", () =>
    Effect.gen(function* () {
      const { message } = yield* second(base, [{ op: "add", ref: "x", parent: "n2", kind: "決定", text: "対面にする", evidence: ["r2"] }]);

      const point = line(message, "n2").filter((l) => !l.includes("対面にする"));
      expect(point).toHaveLength(1);
      expect(point[0]).toContain("決定済み");
      expect(line(message, "n10")[0]).toContain("対面にする");
    }));

  it.effect("更新（案の状態）: 却下は「却下」で、却下から検討中へ戻るときは「検討中」で載る", () =>
    Effect.gen(function* () {
      const rejected = yield* second(base, [{ op: "update", node: "n4", planStatus: "却下", evidence: ["r2"] }]);
      const line1 = line(rejected.message, "n4");
      expect(line1).toHaveLength(1);
      expect(line1[0]).toContain("却下");

      const rejectedMap = evolve(base, [{ op: "update", node: "n4", planStatus: "却下", evidence: ["r2"] }]).map;
      const restored = yield* second(rejectedMap, [{ op: "update", node: "n4", planStatus: "検討中", evidence: ["r2"] }]);
      const line2 = line(restored.message, "n4");
      expect(line2).toHaveLength(1);
      expect(line2[0]).toContain("検討中");
      expect(line2[0]).not.toContain("却下");
    }));

  it.effect("更新（TODO の担当・期限）: 変わった担当と期限が載る", () =>
    Effect.gen(function* () {
      const changed: MeetingMap = { ...base, nodes: { ...base.nodes, n5: { ...base.nodes.n5!, assignee: "鈴木", due: "金曜" } } };
      const { created, updater } = yield* setup();
      yield* updater.update(inputOf(base, 1));
      yield* updater.update(inputOf(changed, 2));

      const todo = line(texts(created[0]!)[1]!, "n5");
      expect(todo).toHaveLength(1);
      expect(todo[0]).toContain("鈴木");
      expect(todo[0]).toContain("金曜");
    }));

  it.effect("移動: 新しい親が載る", () =>
    Effect.gen(function* () {
      const { message } = yield* second(base, [{ op: "move", node: "n6", parent: "n7" }]);

      const moved = line(message, "n6");
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatch(/\bn7\b/);
    }));

  it.effect("削除: 「削除（統合された場合は統合先に子と根拠が移った）」の文言でノードの id が載る", () =>
    Effect.gen(function* () {
      const { message } = yield* second(base, [{ op: "delete", node: "n6" }]);

      const deleted = line(message, "n6");
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toContain("削除（統合された場合は統合先に子と根拠が移った）");
      expect(message).not.toContain("（変更なし）");
    }));

  it.effect("統合: 統合元は削除として載り、統合先へ移った子は新しい親つきの移動として載る", () =>
    Effect.gen(function* () {
      const { message } = yield* second(base, [{ op: "combine", from: "n8", into: "n6" }]);

      const from = line(message, "n8");
      expect(from).toHaveLength(1);
      expect(from[0]).toContain("削除（統合された場合は統合先に子と根拠が移った）");
      const child = line(message, "n9").filter((l) => !/\bn8\b/.test(l) || /\bn6\b/.test(l));
      expect(child).toHaveLength(1);
      expect(child[0]).toMatch(/\bn6\b/);
    }));

  it.effect("変更が無い（noop）なら「（変更なし）」と載り、ノードの行は載らない", () =>
    Effect.gen(function* () {
      const { message } = yield* second(base, [{ op: "noop", reason: "相づち" }]);

      expect(message).toContain("（変更なし）");
      expect(message).not.toContain("削除");
      expect(message).not.toContain("会場を探す");
    }));

  it.effect("適用できなかった操作は変更に出ない（存在しない親への add だけなら「（変更なし）」）", () =>
    Effect.gen(function* () {
      const { message, dropped } = yield* second(base, [{ op: "add", ref: "x", parent: "n99", kind: "課題", text: "幻の課題", evidence: ["r2"] }]);

      expect(dropped).toHaveLength(1);
      expect(message).toContain("（変更なし）");
      expect(message).not.toContain("幻の課題");
    }));

  it.effect("適用できた操作と適用できなかった操作が混ざっても、適用できた分だけが載る", () =>
    Effect.gen(function* () {
      const { message, dropped } = yield* second(base, [
        { op: "add", ref: "x", parent: "n99", kind: "課題", text: "幻の課題", evidence: ["r2"] },
        { op: "add", ref: "y", parent: "n2", kind: "課題", text: "本物の課題", evidence: ["r2"] },
        { op: "delete", node: "n1" }, // 子を持つので捨てられる
      ]);

      expect(dropped).toHaveLength(2);
      expect(message).toContain("本物の課題");
      expect(message).not.toContain("幻の課題");
      expect(message).not.toContain("削除");
      expect(message).not.toContain("（変更なし）");
    }));

  it.effect("変更は、直前に送ったマップからの差。前の回で送った変更は、変わらなければ次の回に載らない", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();
      const added = evolve(base, [{ op: "add", ref: "x", parent: "n2", kind: "課題", text: "雨天時の代替", evidence: ["r2"] }]).map;
      yield* updater.update(inputOf(base, 1));
      yield* updater.update(inputOf(added, 2));
      yield* updater.update(inputOf(added, 3));

      const [, secondMessage, thirdMessage] = texts(created[0]!);
      expect(secondMessage).toContain("雨天時の代替");
      expect(thirdMessage).toContain("（変更なし）");
      expect(thirdMessage).not.toContain("雨天時の代替");
    }));
});

// query() に渡された options（systemPrompt・出力スキーマ・env）を取り出す
const capturedOptions = (calls = 1) =>
  Effect.gen(function* () {
    const { created, updater, close } = yield* setup();
    for (let n = 1; n <= calls; n++) yield* updater.update(input(n));
    yield* close;
    return created.map((c) => c.options);
  });
const systemPrompt = Effect.map(capturedOptions(), (seen) => seen[0]!.systemPrompt);
const count = (text: string, part: string) => text.split(part).length - 1;

describe("system プロンプト: noop にする範囲", () => {
  it.effect("範囲の定義 NOOP_SCOPE が、見出し「# noop にする範囲」の下に 1 回だけ現れる", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(NOOP_SCOPE).toEqual(expect.any(String));
      expect(count(sys, NOOP_SCOPE)).toBe(1);
      expect(count(sys, "# noop にする範囲")).toBe(1);
      expect(sys.indexOf(NOOP_SCOPE)).toBeGreaterThan(sys.indexOf("# noop にする範囲"));
    }));

  it("NOOP_SCOPE は、相づち・進行の段取り・聞き取れない断片・同じ内容の言い直しの 4 つを定義し、雑談や解説は noop の範囲に入れない", () => {
    for (const part of ["相づち", "進行の段取り", "聞き取れない断片", "同じ内容の言い直し"]) expect(NOOP_SCOPE).toContain(part);
    expect(NOOP_SCOPE).not.toContain("雑談、");
    expect(NOOP_SCOPE).not.toContain("番組の解説");
  });

  it.effect("雑談・番組の解説を noop にする旧い指示と、迷ったら何もしない指示は残らない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).not.toContain("雑談、番組の解説のような");
      expect(sys).not.toContain("迷ったら何もしない");
    }));

  it.effect("noop を広げる語は NOOP_SCOPE の外に書かれていない（noop の条件の定義は 1 か所）", () =>
    Effect.gen(function* () {
      const outside = (yield* systemPrompt).replace(NOOP_SCOPE, "");

      expect(outside).not.toMatch(/(雑談|解説|挨拶)[^。\n]*noop にする/);
    }));
});

describe("system プロンプト: 共有・雑談型の会議で話題と要点を残す", () => {
  it.effect("要点を、紹介・体験談・おすすめ・質問とその答えを表す種別として語彙に定義する", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      const line = sys.split("\n").find((l) => l.startsWith("- 要点:"));
      expect(line).toBeDefined();
      for (const part of ["紹介", "体験談", "おすすめ"]) expect(line).toContain(part);
    }));

  it.effect("決定がなくても、話題を議題として立てて要点を残す指示がある", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).toMatch(/決定がなくても/);
      expect(sys).toMatch(/議題として立て/);
    }));

  it.effect("紹介・解説・体験談の中の「〜にする」を、決定や TODO にせず要点にする指示がある。決定と TODO の既存の指示も残る", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).toContain("決定や TODO にせず、要点にする");
      expect(sys).toContain("「〜にしましょう」「〜を結論とする」「〜を基準にする」のような合意は決定にする");
      expect(sys).toContain("「〜さんが〜する」「〜を持ち帰る」「〜に当たる」のように、誰かが後でやると決まった作業は TODO にする");
    }));

  it.effect("目安（60 分で 50 ノード前後・深さ 4 段）の指示が残り、深さの例に要点が入る", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).toContain("60 分の会議で 50 ノード前後、root からの深さ 4 段");
      expect(sys).toMatch(/案・課題・決定・要点/);
    }));

  it.effect("出力スキーマの add の kind に要点が入る", () =>
    Effect.gen(function* () {
      const schema = JSON.stringify((yield* capturedOptions())[0]!.outputFormat.schema);

      expect(schema).toContain('"要点"');
    }));
});

describe("system プロンプトは会議の種類によらず 1 つ", () => {
  it.effect("入力の違う 2 回の呼び出しと、開き直したあとの query で、systemPrompt は同じ文字列", () =>
    Effect.gen(function* () {
      const seen = yield* capturedOptions(QUERY_RENEW_CALLS + 1);

      expect(seen).toHaveLength(2);
      expect(seen[1]!.systemPrompt).toBe(seen[0]!.systemPrompt);
    }));
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

describe("system プロンプト: 会話の扱い", () => {
  const CONVERSATION =
    "この会話の最初のメッセージには、現在のマップの全体が載る。2 通目からは、マップの全体の代わりに前回からのマップの変更だけが載る。変更には、前回の操作を当てた結果（add で付いた id、update 後の本文、統合・移動・削除）が含まれる。最初のマップにこれまでの変更を順に当てたものが今のマップ。ノードは変更に書かれた id で指す";

  it.effect("見出し「# 会話の扱い」の下に、最初は全体・2 通目からは変更という説明がある", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(count(sys, "# 会話の扱い")).toBe(1);
      expect(sys.indexOf(CONVERSATION)).toBeGreaterThan(sys.indexOf("# 会話の扱い"));
    }));

  it.effect("「毎回のメッセージは独立した依頼」「前のメッセージのマップは古い」という旧い指示は残らない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).not.toContain("毎回のメッセージは独立した依頼");
      expect(sys).not.toContain("前のメッセージのマップは古い");
    }));
});

describe("query の options の env（5 分 TTL のキャッシュ）", () => {
  it.effect("env に FORCE_PROMPT_CACHING_5M: \"1\" が入り、process.env の値（PATH など）も引き継がれている。開き直した query も同じ", () =>
    Effect.gen(function* () {
      process.env.LIVE_MINDMAP_TEST_ENV = "引き継がれる";
      yield* Effect.addFinalizer(() => Effect.sync(() => void delete process.env.LIVE_MINDMAP_TEST_ENV));

      const seen = yield* capturedOptions(QUERY_RENEW_CALLS + 1);

      expect(seen).toHaveLength(2);
      for (const options of seen) {
        expect(options.env?.FORCE_PROMPT_CACHING_5M).toBe("1");
        expect(options.env?.PATH).toBe(process.env.PATH);
        expect(options.env?.LIVE_MINDMAP_TEST_ENV).toBe("引き継がれる");
      }
    }));
});
