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
// メッセージのうち、マップ全体または前回からの変更の節だけ（議題の一覧は毎回今の話し中の議題を載せるので除く）
const mapPartOf = (prompt: string) => {
  const start = prompt.search(/^## (現在のマップ|前回からのマップの変更)/m);
  return prompt.slice(start, prompt.indexOf("\n\n## 直前の発言", start));
};

// 発言 id r1〜r40 を、根拠に使える既知の発言として applyOps に渡す
const KNOWN = new Set(Array.from({ length: 40 }, (_, i) => `r${i + 1}`));
const evolve = (map: MeetingMap, ops: Op[]) => applyOps(map, ops, KNOWN, { round: 1, at: 0 });
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
      expect(objects.length).toBeGreaterThanOrEqual(7); // 最上位 1 つと 7 操作
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

  it.effect("DiffOutput の 7 操作（add・update・combine・move・delete・noop・close）が anyOf に入り、add と update の根拠は 1 件以上（minItems: 1）を要求する", () =>
    Effect.gen(function* () {
      const { schema } = yield* schemaOf();
      const operations = new Map<string, Record<string, unknown>>();
      walk(schema, (n) => {
        const properties = n.properties as Record<string, { const?: string; enum?: string[] }> | undefined;
        const op = properties?.op;
        const name = op?.const ?? op?.enum?.[0];
        if (name) operations.set(name, n);
      });

      expect([...operations.keys()].sort()).toEqual(["add", "close", "combine", "delete", "move", "noop", "update"]);
      // close は対象 ID のみ（根拠・理由は持たない）
      const close = operations.get("close")!;
      expect(Object.keys(close.properties as object).sort()).toEqual(["node", "op"]);
      expect([...(close.required as string[])].sort()).toEqual(["node", "op"]);
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
      expect(mapPartOf(second!)).not.toContain("議題A");
      expect(third).not.toContain("## 現在のマップ");
      expect(third).toContain("議題C");
      expect(mapPartOf(third!)).not.toContain("議題A");
      expect(mapPartOf(third!)).not.toContain("議題B"); // 前回送った時点からの変更なので、2 通目の追加は載らない
    }));

  it.effect("2 通目（変更だけの回）にも、議題の一覧・直前の発言・新しい発言の節が載る。一覧は今のマップの話し中の議題を出す", () =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();

      yield* updater.update(growing(1));
      yield* updater.update(growing(2));

      const [first, second] = texts(created[0]!) as [string, string];
      expect(first).toContain("## 議題の一覧（話し中 1・済み 0。済みと、済みの議題の下は省略）");
      expect(second).toContain("## 議題の一覧（話し中 2・済み 0。済みと、済みの議題の下は省略）");
      expect(second).toMatch(/^- n1 議題A（/m);
      expect(second).toMatch(/^- n2 議題B（/m);
      expect(second).not.toContain("## マップの状態");
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
      expect(mapPartOf(after!)).not.toContain("議題A"); // 開き直す前に送ったマップは持ち越さない
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
      expect(mapPartOf(after!)).not.toContain("議題D");
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

  it.effect("「60 分で 50 ノード」「深さ 4 段」「6 つを超えたら束ねる」「要点は 3 つまで」「直前・今回触れたものは閉じられない」の旧い目安・規則は書かれていない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      for (const old of ["60 分", "50 ノード", "深さ 4", "4 段", "6 つを超え", "3 つまで", "閉じられない", "直前・今回触れた", "マップの状態"]) {
        expect(sys, old).not.toContain(old);
      }
      expect(sys).not.toContain("1 つの対象についての"); // 入れ子の説明を否定の形で書かない
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

describe("system プロンプト: 議題の立て方・入れ子・目安・閉じるの出し方", () => {
  const sectionOf = (sys: string, heading: string) => {
    const start = sys.indexOf(heading);
    const rest = sys.slice(start + heading.length);
    const end = rest.search(/\n#{1,2} /);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it.effect("見出し「## 議題の立て方」「## 議題の入れ子」「## 目安」「## 閉じるの出し方」が 1 回ずつ、「# 方針」の下（「# noop にする範囲」より前）にある", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      for (const heading of ["## 議題の立て方", "## 議題の入れ子", "## 目安", "## 閉じるの出し方"]) {
        expect(count(sys, `\n${heading}\n`), heading).toBe(1);
        expect(sys.indexOf(heading), heading).toBeGreaterThan(sys.indexOf("# 方針"));
        expect(sys.indexOf(heading), heading).toBeLessThan(sys.indexOf("# noop にする範囲"));
      }
    }));

  it.effect("議題の立て方: ルートは会議そのもの・1 つ（1 人）ごとに議題・発表の中は番号で分けない・議題名に収まれば論点・戻ったら同じ id", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;
      const section = sectionOf(sys, "## 議題の立て方");

      for (const part of ["会議そのもの", "1 つ（1 人）ごと", "番号", "議題名に収まる", "id に add・update"]) expect(section, part).toContain(part);
      expect(section).toContain("議題にも論点にもしない");
    }));

  it.effect("議題の入れ子: 先に親の議題を立てる・気づかず直下に立てた 1 つ目だけ move・新しい議題の代わりではない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;
      const section = sectionOf(sys, "## 議題の入れ子");

      for (const part of ["先に親の議題", "1 つ目だけ move", "新しい議題"]) expect(section, part).toContain(part);
    }));

  it.effect("目安: 1 つの議題の話し中の部分は 15〜20 ノード・兄弟は 5 つまで・上限を守るための move はしない。深さの目安は置かない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;
      const section = sectionOf(sys, "## 目安");

      for (const part of ["15〜20", "5 つまで", "上限を守るための move はしない"]) expect(section, part).toContain(part);
      expect(section).not.toMatch(/深さ.{0,6}(まで|以内|目安)/);
    }));

  it.effect("閉じるの出し方: 毎回見直す・移ったばかりの応答では前の議題を閉じない・時刻は判断の材料・迷うときは閉じないは 1 か所だけ", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;
      const section = sectionOf(sys, "## 閉じるの出し方");

      for (const part of ["新しい議題に移ったばかりの応答では前の議題を閉じず", "判断の材料", "迷うときは閉じない"]) expect(section, part).toContain(part);
      expect(count(sys, "迷うときは閉じない")).toBe(1);
    }));
});

describe("system プロンプト: 補足は子の要点に置き、本文の書き換えを絞る（#162）", () => {
  it.effect("要点の語彙に、その中身を具体化する要点（具体例・数字・手順・経緯）を要点の下に置けることがある。紹介・体験談・おすすめは残る", () =>
    Effect.gen(function* () {
      const line = (yield* systemPrompt).split("\n").find((l) => l.startsWith("- 要点:"));

      expect(line).toBeDefined();
      for (const part of ["具体化する要点", "具体例", "数字", "手順", "経緯", "紹介", "体験談", "おすすめ"]) expect(line, part).toContain(part);
    }));

  it.effect("補足（具体例・数字・手順・経緯）は、親の要点を言い直さず、その要点の子の要点として add する", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).toContain("親の要点を言い直さず");
      expect(sys).toContain("その要点の子の要点として add");
      // 補足を update で済ませる旧い指示は 2 か所とも残らない
      expect(sys).not.toContain("ノードを作らず既存ノードに根拠を足す update");
      expect(sys).not.toContain("新しい要点にせず、既存の要点に根拠を足す");
      expect(sys).not.toContain("本文に収まるものだけ短く言い直す");
    }));

  it.effect("本文の規則は親の要点への追記・言い直しだけを禁じ、補足を子の要点にする指示と矛盾しない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;
      const line = sys.split("\n").find((l) => l.startsWith("- 本文は"));

      expect(line).toBeDefined();
      for (const part of ["40 字以内", "言い回しをそのまま写さない", "親の要点"]) expect(line, part).toContain(part);
      expect(sys).not.toContain("例や経緯は本文に書かない");
    }));

  it.effect("update で本文を変えるのは、誤認識・読み違いの修正、質問に答えが出たとき、案の状態の切り替えの 3 つのときだけ。定義は 1 か所", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(count(sys, "の 3 つのときだけ")).toBe(1);
      const at = sys.indexOf("の 3 つのときだけ");
      const rule = sys.slice(Math.max(0, at - 120), at + 20);
      for (const part of ["誤認識・読み違いの修正", "質問に答えが出たとき", "案の状態（検討中 / 却下）の切り替え"]) expect(rule, part).toContain(part);
    }));

  it.effect("それ以外の update は根拠を足すだけで、text を渡さない。本文を無条件に書き換える旧い指示は残らない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).toContain("text を渡さない");
      for (const old of ["ノードの本文を書き換え、根拠を足す", "言い直した結果の全文", "より的確な短い言い方"]) expect(sys, old).not.toContain(old);
    }));

  it.effect("「迷ったら update」は、同じ主張の繰り返し・言い換えに根拠を足す意味に限る。広い「迷ったら」は残らない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).toContain("同じ主張の繰り返し・言い換えで迷ったら");
      expect(sys).not.toContain("同じ話の中で迷ったら");
      expect(sys).not.toMatch(/新しいノードを増やすより既存ノードの update を選ぶ/);
    }));

  it.effect("質問とその答えを 1 つの要点にまとめ、答えが出たら本文を update で置き換える指示は残る", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).toContain("質問とその答えは 1 つの要点にまとめる");
      expect(sys).toContain("その要点の本文を update で置き換える");
    }));

  it.effect("兄弟の上限の文面は #172 の 1 か所のまま重ねて書かず、会議の種類の判定やモードの語は入らない", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(count(sys, "話し中の兄弟は、種別によらず 5 つまで")).toBe(1);
      expect(count(sys, "上限を守るための move はしない")).toBe(1);
      for (const word of ["講演モード", "モードを", "会議の種類を判定", "講演形式の場合"]) expect(sys, word).not.toContain(word);
    }));
});

describe("毎回のメッセージの議題の一覧", () => {
  const ev = ["r1"];
  // root > n1 議題「本の届け先」(38 分) > (n2 論点 > (n3 案, n4 論点[済み] > n5 案), n6 要点)
  //      > n7 議題「写真の振り返り」(41 分) > (n8 議題「写真: 船」(40 分) > (n9 論点 > n10 案, n11 要点), n12 議題「写真: 山」[済み] > n13 要点,
  //                                         n14 論点 > (n15 要点, n16 議題「並び順の候補」(41 分) > n17 要点))
  //      > n18 議題「予算」[済み] > n19 議題「社内報」(話し中のまま) > n20 要点
  const built = (() => {
    const step = (map: MeetingMap, ops: Op[], at: number) => {
      const r = applyOps(map, ops, KNOWN, { round: 1, at });
      expect(r.dropped).toEqual([]);
      return r.map;
    };
    const a = step(emptyMap("定例"), [
      { op: "add", ref: "t", parent: "root", kind: "議題", text: "本の届け先", evidence: ev },
      { op: "add", ref: "p", parent: "t", kind: "論点", text: "誰に配るか", evidence: ev },
      { op: "add", ref: "x", parent: "p", kind: "案", text: "全員に", evidence: ev },
      { op: "add", ref: "q", parent: "p", kind: "論点", text: "いつ配るか", evidence: ev },
      { op: "add", ref: "y", parent: "q", kind: "案", text: "来月", evidence: ev },
      { op: "add", ref: "k", parent: "t", kind: "要点", text: "部数は 500", evidence: ev },
    ], 2280);
    const b = step(a, [
      { op: "add", ref: "g", parent: "root", kind: "議題", text: "写真の振り返り", evidence: ev },
      { op: "add", ref: "s", parent: "g", kind: "議題", text: "写真: 船", evidence: ev },
      { op: "add", ref: "sp", parent: "s", kind: "論点", text: "どれを載せるか", evidence: ev },
      { op: "add", ref: "sa", parent: "sp", kind: "案", text: "夕焼けの船", evidence: ev },
      { op: "add", ref: "sk", parent: "s", kind: "要点", text: "撮影は朝", evidence: ev },
      { op: "add", ref: "m", parent: "g", kind: "議題", text: "写真: 山", evidence: ev },
      { op: "add", ref: "mk", parent: "m", kind: "要点", text: "雪が残っていた", evidence: ev },
    ], 2400);
    const c = step(b, [
      { op: "add", ref: "o", parent: "n7", kind: "論点", text: "全体の並び順", evidence: ev },
      { op: "add", ref: "ok", parent: "o", kind: "要点", text: "年代順が良い", evidence: ev },
      { op: "add", ref: "ot", parent: "o", kind: "議題", text: "並び順の候補", evidence: ev },
      { op: "add", ref: "otk", parent: "ot", kind: "要点", text: "地図順もある", evidence: ev },
    ], 2460);
    const d = step(c, [
      { op: "add", ref: "u", parent: "root", kind: "議題", text: "予算", evidence: ev },
      { op: "add", ref: "uc", parent: "u", kind: "議題", text: "社内報", evidence: ev },
      { op: "add", ref: "uk", parent: "uc", kind: "要点", text: "月次で出す", evidence: ev },
    ], 1800);
    return d;
  })();
  // 済みにする。根拠が足された反映（round 1）から 2 つ後の反映で閉じる
  const closed = (() => {
    const r = applyOps(built, ["n4", "n12", "n18"].map((node) => ({ op: "close" as const, node })), KNOWN, { round: 4, at: 9999 });
    expect(r.dropped).toEqual([]);
    return r.map;
  })();
  const listOf = (map: MeetingMap) => {
    const lines = buildPrompt(inputOf(map, 1)).split("\n");
    const start = lines.findIndex((l) => l.startsWith("## 議題の一覧"));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    return lines.slice(start, end === -1 ? undefined : end);
  };

  it("前提: 組んだマップの id が想定どおり（議題 n1・n7・n8・n12・n16・n18・n19、済みは n4・n12・n18）", () => {
    for (const [id, text] of [["n1", "本の届け先"], ["n7", "写真の振り返り"], ["n8", "写真: 船"], ["n12", "写真: 山"], ["n16", "並び順の候補"], ["n18", "予算"], ["n19", "社内報"]] as const) {
      expect(closed.nodes[id]!.kind).toBe("議題");
      expect(closed.nodes[id]!.text).toBe(text);
    }
    expect(["n4", "n12", "n18"].every((id) => closed.nodes[id]!.talkStatus === "済み")).toBe(true);
    expect(closed.nodes.n19!.talkStatus).toBeUndefined();
  });

  it("見出しに話し中の議題の数・済みの議題の数が出て、今の経過・ノード数・深さ・60 分の目安は出ない", () => {
    const prompt = buildPrompt(inputOf(closed, 1));
    const list = listOf(closed);

    expect(list[0]).toBe("## 議題の一覧（話し中 4・済み 2。済みと、済みの議題の下は省略）");
    expect(prompt).not.toContain("## マップの状態");
    expect(prompt).not.toMatch(/経過 \d+ 分|最大の深さ|60 分で 50/);
    expect(prompt.indexOf("## 議題の一覧")).toBeLessThan(prompt.indexOf("## 現在のマップ")); // 先頭の節
  });

  it("話し中の議題を木のまま字下げして出す。論点をはさんだ子の議題も、最も近い祖先の議題の下に字下げする", () => {
    const rows = listOf(closed).filter((l) => /^ *- n\d+ /.test(l));

    expect(rows.map((l) => l.match(/^( *)- (n\d+) /)!.slice(1, 3).join("|"))).toEqual(["|n1", "|n7", "  |n8", "  |n16"]);
  });

  it("各行は id・議題名・話し中の部分のノード数・最後に触れた分。子の議題の下と済みの論点の下は数えない（済みの論点自身は数える）", () => {
    const list = listOf(closed);

    // n1: n2・n3・n4（済みの論点自身）・n6 = 4。n5 は済みの論点の下なので数えない
    expect(list).toContain("- n1 本の届け先（話し中 4 ノード・最後に触れた 38 分）");
    // n8: n9・n10・n11 = 3
    expect(list).toContain("  - n8 写真: 船（話し中 3 ノード・最後に触れた 40 分）");
    // n16: n17 = 1
    expect(list).toContain("  - n16 並び順の候補（話し中 1 ノード・最後に触れた 41 分）");
  });

  it("子の議題を持つ議題の行に「まとまり・子の議題 話し中 N・済み M・まとまり自体の話し中 K ノード」。K は子の議題（話し中・済み）の下を数えない", () => {
    const list = listOf(closed);

    // n7 の子の議題: 話し中 n8・n16、済み n12。まとまり自体: n14・n15 = 2（n8・n12・n16 とその配下は数えない）
    expect(list).toContain("- n7 写真の振り返り（まとまり・子の議題 話し中 2・済み 1・まとまり自体の話し中 2 ノード・最後に触れた 41 分）");
  });

  it("済みの議題と、その下の議題（データ上は話し中のまま）は行に出ず、済みの件数にだけ数える。話し中の件数にも済みの件数にも、済みの親の下の議題は入らない", () => {
    const list = listOf(closed).join("\n");

    for (const hidden of ["n12", "n18", "n19", "写真: 山", "予算", "社内報", "雪が残っていた", "月次で出す"]) expect(list, hidden).not.toContain(hidden);
    expect(list).toContain("話し中 4・済み 2"); // n19 はどちらにも入らない
    // 一覧を作ってもデータの済みの状態は変わらない
    expect(closed.nodes.n18!.talkStatus).toBe("済み");
    expect(closed.nodes.n19!.talkStatus).toBeUndefined();
  });

  it("済みにする前は、済み 0・同じ議題が話し中として出る。一覧は呼ぶたびに今のマップから作り直される", () => {
    const before = listOf(built);

    expect(before[0]).toBe("## 議題の一覧（話し中 7・済み 0。済みと、済みの議題の下は省略）");
    for (const id of ["n12", "n18", "n19"]) expect(before.some((l) => new RegExp(`^ *- ${id} `).test(l))).toBe(true);
    // 済みにしたあとの一覧には出ない
    expect(listOf(closed).some((l) => /^ *- n12 /.test(l))).toBe(false);
  });

  it("済みの論点の下にある話し中の議題は、論点だけを済みにしても行・見出しの件数・親の子の議題件数に残る。親のノード数に済みの論点の配下は入らない", () => {
    const added = applyOps(emptyMap("定例"), [
      { op: "add", ref: "a", parent: "root", kind: "議題", text: "議題A", evidence: ev },
      { op: "add", ref: "p", parent: "a", kind: "論点", text: "論点P", evidence: ev },
      { op: "add", ref: "c", parent: "p", kind: "案", text: "案C", evidence: ev },
      { op: "add", ref: "b", parent: "p", kind: "議題", text: "議題B", evidence: ev },
      { op: "add", ref: "bk", parent: "b", kind: "要点", text: "要点K", evidence: ev },
    ], KNOWN, { round: 1, at: 600 });
    expect(added.dropped).toEqual([]);
    expect(["n1", "n2", "n3", "n4", "n5"].map((id) => added.map.nodes[id]!.kind)).toEqual(["議題", "論点", "案", "議題", "要点"]);
    const closedP = applyOps(added.map, [{ op: "close", node: "n2" }], KNOWN, { round: 3, at: 9999 });
    expect(closedP.dropped).toEqual([]);
    expect(closedP.map.nodes.n2!.talkStatus).toBe("済み");
    expect(closedP.map.nodes.n4!.talkStatus).toBeUndefined();

    // 済みにする前: A のまとまり自体は P・案 の 2 ノード
    expect(listOf(added.map)).toContain("- n1 議題A（まとまり・子の議題 話し中 1・済み 0・まとまり自体の話し中 2 ノード・最後に触れた 10 分）");
    const list = listOf(closedP.map);
    expect(list[0]).toBe("## 議題の一覧（話し中 2・済み 0。済みと、済みの議題の下は省略）");
    expect(list).toContain("- n1 議題A（まとまり・子の議題 話し中 1・済み 0・まとまり自体の話し中 1 ノード・最後に触れた 10 分）");
    expect(list).toContain("  - n4 議題B（話し中 1 ノード・最後に触れた 10 分）");
  });

  it("目安の数字が出る: 1 つの議題の話し中の部分は 15〜20 ノード・兄弟は種別によらず 5 つまで", () => {
    const list = listOf(closed).join("\n");

    expect(list).toContain("15〜20");
    expect(list).toContain("5 つまで");
  });

  it("話し中の議題が無いマップでは、一覧は（なし）で、目安は出る", () => {
    const list = listOf(emptyMap("定例"));

    expect(list[0]).toBe("## 議題の一覧（話し中 0・済み 0。済みと、済みの議題の下は省略）");
    expect(list).toContain("（なし）");
    expect(list.join("\n")).toContain("15〜20");
  });

  it("1 通目（マップ全体）でも、変更だけの回でも、同じ今のマップから作った一覧が載る", () => {
    const first = buildPrompt(inputOf(closed, 1));
    const second = buildPrompt(inputOf(closed, 1), built);

    expect(first).toContain("## 現在のマップ");
    expect(second).toContain("## 前回からのマップの変更");
    expect(second).not.toContain("## 現在のマップ");
    expect(listOf(closed).join("\n")).toContain("- n7 写真の振り返り（まとまり・子の議題 話し中 2・済み 1");
    const extract = (p: string) => p.slice(p.indexOf("## 議題の一覧"), p.indexOf("\n\n", p.indexOf("## 議題の一覧")));
    expect(extract(second)).toBe(extract(first));
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
      { round: 1, at: 0 },
    );

    const prompt = buildPrompt({ map, recent: [], fresh: [{ id: "r3", track: "相手", start: 3, end: 4, text: "x" }] });

    expect(prompt).toMatch(/^ {2}- n1 議題: ふりかえりのやり方$/m);
    expect(prompt).toMatch(/^ {4}- n2 要点: 毎週 15 分で回している$/m);
  });
});

describe("議題・論点の「済み」（close）の経路", () => {
  const known = new Set(["r1", "r2", "r3"]);
  const fresh = [{ id: "r4", track: "相手" as const, start: 4, end: 5, text: "x" }];

  it("buildPrompt のアウトラインは、済みの議題・論点の行にだけ「（済み）」を付ける", () => {
    const opened = applyOps(
      emptyMap("定例"),
      [
        { op: "add", ref: "a", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
        { op: "add", ref: "b", parent: "a", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
        { op: "add", ref: "c", parent: "root", kind: "議題", text: "予算", evidence: ["r3"] },
      ],
      known,
      { round: 1, at: 0 },
    ).map;
    // 根拠が足された反映の 2 つ後の反映で閉じる（直前の反映なら捨てられる）
    const closed = applyOps(opened, [{ op: "close", node: "n1" }, { op: "close", node: "n2" }], known, { round: 3, at: 0 });
    expect(closed.dropped).toEqual([]);

    const prompt = buildPrompt({ map: closed.map, recent: [], fresh });

    expect(prompt).toMatch(/^ {2}- n1 議題: 採用（済み）$/m);
    expect(prompt).toMatch(/^ {4}- n2 論点\(未決\): 面接は何回か（済み）$/m);
    expect(prompt).toMatch(/^ {2}- n3 議題: 予算$/m); // 話し中の行には付けない
    expect(count(prompt, "（済み）")).toBe(2);
  });

  it.effect("system プロンプトの差分操作に close の説明がある（会議の話が別へ移り戻る気配がないときだけ・迷うときは閉じない・根拠は持たない・自動で話し中に戻る）", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;

      expect(sys).toContain("close");
      for (const part of ["済み", "迷うときは閉じない", "根拠は持たない", "話し中に戻る", "開き直す操作は無い"]) expect(sys).toContain(part);
    }));
});

describe("済みの議題・論点を AI へ畳んで渡す", () => {
  const ev = ["r1"];
  // root > n1 議題 > (n2 論点 > (n3 案 > n4 論点 > n5 決定, n8 TODO), n6 課題, n7 要点, n9 議題 > n10 要点)、root > n11 議題 > n12 案
  const opened = (() => {
    const { map, dropped } = evolve(emptyMap("定例"), [
      { op: "add", ref: "a", parent: "root", kind: "議題", text: "採用", evidence: ev },
      { op: "add", ref: "b", parent: "a", kind: "論点", text: "面接は何回か", evidence: ev },
      { op: "add", ref: "c", parent: "b", kind: "案", text: "二回", evidence: ev },
      { op: "add", ref: "d", parent: "c", kind: "論点", text: "誰が面接官か", evidence: ev },
      { op: "add", ref: "e", parent: "d", kind: "決定", text: "部長と人事", evidence: ev },
      { op: "add", ref: "f", parent: "a", kind: "課題", text: "日程が合わない", evidence: ev },
      { op: "add", ref: "g", parent: "a", kind: "要点", text: "去年は三回だった", evidence: ev },
      { op: "add", ref: "h", parent: "b", kind: "TODO", text: "候補日を出す", evidence: ev },
      { op: "add", ref: "i", parent: "a", kind: "議題", text: "社内報", evidence: ev },
      { op: "add", ref: "j", parent: "i", kind: "要点", text: "月次で出す", evidence: ev },
      { op: "add", ref: "k", parent: "root", kind: "議題", text: "予算", evidence: ev },
      { op: "add", ref: "l", parent: "k", kind: "案", text: "増額", evidence: ev },
    ]);
    expect(dropped).toEqual([]);
    return map;
  })();
  // 根拠が足された反映の 2 つ後（round 3）で閉じ、その次（round 4）で ops を当てる
  const closeAt = (map: MeetingMap, nodes: string[]) => {
    const r = applyOps(map, nodes.map((node) => ({ op: "close" as const, node })), KNOWN, { round: 3, at: 0 });
    expect(r.dropped).toEqual([]);
    return r.map;
  };
  const apply = (map: MeetingMap, ops: Op[]) => {
    const r = applyOps(map, ops, KNOWN, { round: 4, at: 0 });
    expect(r.dropped).toEqual([]);
    return r.map;
  };
  // maps を順に 1 つの query へ送り、届いたメッセージを返す
  const sendAll = (maps: MeetingMap[]) =>
    Effect.gen(function* () {
      const { created, updater } = yield* setup();
      for (const [i, map] of maps.entries()) yield* updater.update(inputOf(map, i + 1));
      return texts(created[0]!);
    });
  const promptOf = (map: MeetingMap) => buildPrompt(inputOf(map, 1));
  const line = (message: string, id: string) => message.split("\n").filter((l) => new RegExp(`\\b${id}\\b`).test(l));
  const shown = (prompt: string, id: string) => new RegExp(`^ *- ${id} `, "m").test(prompt);

  it("全体のアウトライン: 済みの議題の配下は、論点・決定・TODO・子の議題の行だけを ID つき・元の木の深さの字下げで残し、案・課題・要点は省く（案の下の論点はたどる）", () => {
    const prompt = promptOf(closeAt(opened, ["n1"]));

    expect(prompt).toMatch(/^ {2}- n1 議題: 採用（済み）$/m);
    expect(prompt).toMatch(/^ {4}- n2 論点\(未決\): 面接は何回か$/m);
    expect(prompt).toMatch(/^ {6}- n8 TODO: 候補日を出す$/m);
    expect(prompt).toMatch(/^ {8}- n4 論点\(決定済み\): 誰が面接官か$/m); // 省いた案（n3）の段も字下げに数える
    expect(prompt).toMatch(/^ {10}- n5 決定: 部長と人事$/m);
    expect(prompt).toMatch(/^ {4}- n9 議題: 社内報$/m);
    for (const id of ["n3", "n6", "n7", "n10"]) expect(shown(prompt, id)).toBe(false);
    for (const body of ["二回", "日程が合わない", "去年は三回だった", "月次で出す"]) expect(prompt).not.toContain(body);
    expect(count(prompt, "（済み）")).toBe(1);
  });

  it("全体のアウトライン: 話し中の兄弟の議題の配下は畳まない", () => {
    const prompt = promptOf(closeAt(opened, ["n1"]));

    expect(prompt).toMatch(/^ {2}- n11 議題: 予算$/m);
    expect(prompt).toMatch(/^ {4}- n12 案: 増額$/m);
  });

  it("全体のアウトライン: 済みの論点だけを閉じたとき、畳むのはその配下だけで、兄弟や親は畳まない", () => {
    const prompt = promptOf(closeAt(opened, ["n2"]));

    expect(prompt).toMatch(/^ {4}- n2 論点\(未決\): 面接は何回か（済み）$/m);
    expect(prompt).toMatch(/^ {6}- n8 TODO: 候補日を出す$/m);
    expect(prompt).toMatch(/^ {8}- n4 論点\(決定済み\): 誰が面接官か$/m);
    expect(shown(prompt, "n3")).toBe(false);
    expect(prompt).not.toContain("二回");
    expect(prompt).toMatch(/^ {4}- n6 課題: 日程が合わない$/m);
    expect(prompt).toMatch(/^ {4}- n7 要点: 去年は三回だった$/m);
    expect(prompt).toMatch(/^ {6}- n10 要点: 月次で出す$/m);
    expect(count(prompt, "（済み）")).toBe(1);
  });

  it.effect("閉じた反映の次のメッセージに「済みにした」が載り、「（変更なし）」は載らない。その次の回で変わらなければ載らない", () =>
    Effect.gen(function* () {
      const closed = closeAt(opened, ["n1"]);
      const [, secondMessage, thirdMessage] = yield* sendAll([opened, closed, closed]);

      expect(line(secondMessage!, "n1")).toEqual(["- n1 済みにした"]);
      expect(secondMessage).not.toContain("（変更なし）");
      expect(thirdMessage).toContain("（変更なし）");
      expect(thirdMessage).not.toContain("済みにした");
    }));

  it.effect("1 回の反映で議題と論点を両方閉じると、両方に「済みにした」が載る。閉じていないノードには載らない", () =>
    Effect.gen(function* () {
      const [, message] = yield* sendAll([opened, closeAt(opened, ["n1", "n2"])]);

      expect(line(message!, "n1")).toEqual(["- n1 済みにした"]);
      expect(line(message!, "n2")).toEqual(["- n2 済みにした"]);
      expect(count(message!, "済みにした")).toBe(2);
    }));

  it.effect("開き直した反映の次のメッセージに「話し中に戻った。畳んでいた中身:」と、畳んでいた配下が全部（案・課題・要点も）載る。議題と論点が両方戻れば両方載る", () =>
    Effect.gen(function* () {
      const closed = closeAt(opened, ["n1", "n2"]);
      const reopened = apply(closed, [{ op: "add", ref: "x", parent: "n3", kind: "課題", text: "面接官が足りない", evidence: ["r2"] }]);
      expect(reopened.nodes.n1!.talkStatus).toBeUndefined();
      expect(reopened.nodes.n2!.talkStatus).toBeUndefined();

      const [first, message] = yield* sendAll([closed, reopened]);

      expect(first).not.toContain("二回"); // 1 通目は畳んだ形
      expect(line(message!, "n1")).toContain("- n1 話し中に戻った。畳んでいた中身:");
      expect(line(message!, "n2")).toContain("- n2 話し中に戻った。畳んでいた中身:");
      expect(message).not.toContain("済みにした");
      expect(message).not.toContain("（変更なし）");
      // 畳んでいた案・課題・要点が、字下げされた行で載る
      expect(message).toMatch(/^ +- n6 課題: 日程が合わない$/m);
      expect(message).toMatch(/^ +- n7 要点: 去年は三回だった$/m);
      expect(message).toMatch(/^ +- n10 要点: 月次で出す$/m);
      expect(message).toMatch(/^ +- n4 論点\(決定済み\): 誰が面接官か$/m);
      expect(message).toMatch(/^ +- n5 決定: 部長と人事$/m);
      // 論点（n2）の配下の案は、議題（n1）の中身と論点の中身の両方に出る
      expect(message!.split("\n").filter((l) => /^ +- n3 案: 二回$/.test(l))).toHaveLength(2);
      // 同じ反映で足したノードは、追加の行にも載る
      expect(line(message!, "n13").some((l) => l.includes("追加") && l.includes("面接官が足りない"))).toBe(true);
      // 開き直した議題・論点それぞれの展開部分にも、同じ反映で足した n13 が字下げされた行で載る
      const lines = message!.split("\n");
      const n1Head = lines.findIndex((l) => l.startsWith("- n1 話し中に戻った"));
      const n2Head = lines.findIndex((l) => l.startsWith("- n2 話し中に戻った"));
      expect(n1Head).toBeGreaterThanOrEqual(0);
      expect(n2Head).toBeGreaterThan(n1Head);
      const sectionEnd = lines.findIndex((l, i) => i > n2Head && /^\S/.test(l));
      const n1Section = lines.slice(n1Head + 1, n2Head);
      const n2Section = lines.slice(n2Head + 1, sectionEnd === -1 ? lines.length : sectionEnd);
      expect(n1Section.some((l) => /^ +- n13 課題: 面接官が足りない$/.test(l))).toBe(true);
      expect(n2Section.some((l) => /^ +- n13 課題: 面接官が足りない$/.test(l))).toBe(true);
    }));

  it.effect("畳んでいた中身は、開き直した議題の配下だけ。論点が戻らない議題の戻りでは、論点の中身は載らない", () =>
    Effect.gen(function* () {
      const closed = closeAt(opened, ["n1"]);
      const reopened = apply(closed, [{ op: "add", ref: "x", parent: "n6", kind: "課題", text: "調整役がいない", evidence: ["r2"] }]);
      expect(reopened.nodes.n1!.talkStatus).toBeUndefined();

      const [, message] = yield* sendAll([closed, reopened]);

      expect(line(message!, "n1")).toContain("- n1 話し中に戻った。畳んでいた中身:");
      expect(message).not.toMatch(/話し中に戻った[^\n]*n2|n2[^\n]*話し中に戻った/);
      expect(message).toMatch(/^ +- n3 案: 二回$/m);
    }));

  it.effect("済みの議題の下のノードを削除した反映の次のメッセージに、その削除が載る。削除では開き直さないので、「話し中に戻った」は載らない", () =>
    Effect.gen(function* () {
      const closed = closeAt(opened, ["n1"]);
      const deleted = apply(closed, [{ op: "delete", node: "n10" }, { op: "delete", node: "n7" }]);
      expect(deleted.nodes.n1!.talkStatus).toBe("済み");

      const [, message] = yield* sendAll([closed, deleted]);

      for (const id of ["n10", "n7"]) {
        const l = line(message!, id);
        expect(l).toHaveLength(1);
        expect(l[0]).toContain("削除（統合された場合は統合先に子と根拠が移った）");
      }
      expect(message).not.toContain("話し中に戻った");
      expect(message).not.toContain("済みにした");
      expect(message).not.toContain("（変更なし）");
    }));

  it.effect("system プロンプトに「# 済みの議題の見え方」が 1 回だけあり、畳んである・見えている id に add・update する・作り直さない、と書いてある", () =>
    Effect.gen(function* () {
      const sys = yield* systemPrompt;
      const section = "# 済みの議題の見え方";
      const body = "現在のマップで「（済み）」が付いた議題・論点は畳んである。配下の案・課題・要点は省いて見せている。そこへ話が戻ったら、見えている議題・論点の id に add・update する。同じ議題や論点を新しく作り直さない。";

      expect(count(sys, section)).toBe(1);
      expect(count(sys, body)).toBe(1);
      expect(sys.indexOf(body)).toBeGreaterThan(sys.indexOf(section));
      expect(sys.indexOf(section)).toBeGreaterThan(sys.indexOf(NOOP_SCOPE));
      expect(sys.indexOf(section)).toBeLessThan(sys.indexOf("# 会話の扱い"));
      expect(sys).toContain("話が戻ってきたら、畳まれていても見えている id にそのまま add・update する"); // 差分操作の close の行は残る
    }));
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
