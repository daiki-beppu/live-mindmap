import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { DiffUpdater, emptyMap, type DiffInput, type Remark } from "../src/core/index.ts";
import { localUpdaterLayer } from "../src/localDiffUpdater.ts";
import { classificationRequest, splitSentences, type Classification } from "../src/localPrompt.ts";

// Issue #1021: ローカルのモデルへのプロンプトも、直前の発言と新しい発言の文の行を、クラウドと同じ書式（話者つき）で出す。

const remark = (fields: Partial<Remark> & Pick<Remark, "id" | "start">): Remark => ({ track: "相手", end: fields.start + 1, text: "本文", ...fields });
const lineOf = (prompt: string, section: string) => prompt.split(`## ${section}`)[1]!.split("\n\n## ")[0]!.split("\n").filter(Boolean);

describe("classificationRequest: 発言の行に話者が出る", () => {
  it("判断軸があるローカル入力でも従来の分類要求だけを送り、関係づけを作らない", async () => {
    const requests: ReturnType<typeof classificationRequest>[] = [];
    const input = { map: emptyMap("定例"), recent: [], fresh: [remark({ id: "r1", start: 0, text: "試験導入を提案します" })], criteria: ["採用のしやすさ"] };
    const raw: Classification = { 議題: { id: "新しい議題", 題: "導入" }, 文: [{ 種類: "提案", text: "試験導入" }], 済み: "なし", 名前: [] };
    const output = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* DiffUpdater).update(input);
    }).pipe(Effect.provide(localUpdaterLayer({ katakana: () => Effect.succeed([]), classify: (request) => { requests.push(request); return Effect.succeed(raw); } }))));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toBe(classificationRequest(input.map, input.recent, splitSentences(input.fresh[0]!)).prompt);
    expect(output.ops.some((op) => op.op === "add" && op.kind === "案")).toBe(true);
    for (const op of output.ops) expect(op).not.toHaveProperty("criteria");
  });

  it("直前の発言の行は mm:ss と話者つき（今までの秒の生の値ではない）。自分・話者なし・ラベルあり", () => {
    const recent = [
      remark({ id: "r1", start: 194.9, text: "前の発言", speaker: "相手 A" }),
      remark({ id: "r2", start: 200, track: "自分", text: "うん", speaker: "自分" }),
      remark({ id: "r3", start: 201, text: "話者なし" }),
    ];

    const { prompt } = classificationRequest(emptyMap("定例"), recent, []);

    expect(lineOf(prompt, "直前の発言（処理済み・文脈用）")).toEqual([
      "r1 [03:14] 相手 A: 前の発言",
      "r2 [03:20] 自分: うん",
      "r3 [03:21] 相手: 話者なし",
    ]);
  });

  it("新しい発言の文の行は、番号の後に直前の発言と同じ形（ID [mm:ss] 話者: 文）。同じ発言の文は同じ話者", () => {
    const r4 = remark({ id: "r4", start: 194, text: "先に進めます。次に移ります。", speaker: "相手 B" });
    const r5 = remark({ id: "r5", start: 230, text: "お願いします", track: "自分", speaker: "自分" });

    const { prompt } = classificationRequest(emptyMap("定例"), [], [...splitSentences(r4), ...splitSentences(r5)]);

    expect(lineOf(prompt, "新しい発言（3 文）")).toEqual([
      "1. r4 [03:14] 相手 B: 先に進めます。",
      "2. r4 [03:14] 相手 B: 次に移ります。",
      "3. r5 [03:50] 自分: お願いします",
    ]);
  });

  // Issue #1026: ローカルのモデルへのプロンプトも、名前が付いたラベルの行は「相手 B（田中）」。第 4 引数が ラベル → 名前 の表
  it("speakerNames があれば、直前の発言の行と新しい発言の文の行の両方で、ラベルのある相手の話者が 相手 B（田中） になる。名前の無いラベル・話者なし・自分は今の形のまま", () => {
    const recent = [
      remark({ id: "r1", start: 194.9, text: "前の発言", speaker: "相手 B" }),
      remark({ id: "r2", start: 200, track: "自分", text: "うん", speaker: "自分" }),
      remark({ id: "r3", start: 201, text: "話者なし" }),
    ];
    const r4 = remark({ id: "r4", start: 230, text: "先に進めます。次に移ります。", speaker: "相手 B" });
    const r5 = remark({ id: "r5", start: 240, text: "別の人です", speaker: "相手 A" });

    const { prompt } = classificationRequest(emptyMap("定例"), recent, [...splitSentences(r4), ...splitSentences(r5)], new Map([["相手 B", "田中"]]));

    expect(lineOf(prompt, "直前の発言（処理済み・文脈用）")).toEqual([
      "r1 [03:14] 相手 B（田中）: 前の発言",
      "r2 [03:20] 自分: うん",
      "r3 [03:21] 相手: 話者なし",
    ]);
    expect(lineOf(prompt, "新しい発言（3 文）")).toEqual([
      "1. r4 [03:50] 相手 B（田中）: 先に進めます。",
      "2. r4 [03:50] 相手 B（田中）: 次に移ります。",
      "3. r5 [04:00] 相手 A: 別の人です",
    ]);
  });

  it("文は、元の発言（ID・話者・時刻）を持ち、文の本文だけが違う", () => {
    const original = remark({ id: "r7", start: 10, text: "一文目。二文目。", speaker: "相手 A" });

    const sentences = splitSentences(original);

    expect(sentences.map((s) => [s.remark, s.text])).toEqual([[original, "一文目。"], [original, "二文目。"]]);
  });
});

// Issue #1026: localUpdaterLayer（Apple Intelligence もここを通る）が DiffInput.speakerNames を classificationRequest へ渡す。受け渡しが欠けると名前がローカルのモデルに届かない
describe("localUpdaterLayer: DiffInput.speakerNames の受け渡し", () => {
  const run = (speakerNames: DiffInput["speakerNames"]) => {
    const prompts: string[] = [];
    const layer = localUpdaterLayer({
      classify: (request) => Effect.sync(() => {
        prompts.push(request.prompt);
        return { 議題: { id: "新しい議題", 題: "" }, 文: [{ text: "x", 種類: "なし" }], 済み: "なし", 名前: [] } as unknown as Classification;
      }),
      katakana: () => Effect.succeed([]),
    });
    const input: DiffInput = {
      map: emptyMap("定例"),
      recent: [remark({ id: "r1", start: 1, speaker: "相手 B", text: "前" })],
      fresh: [remark({ id: "r2", start: 5, speaker: "相手 B", text: "今" })],
      ...(speakerNames === undefined ? {} : { speakerNames }),
    };
    return Effect.runPromise(Effect.flatMap(DiffUpdater, (updater) => updater.update(input)).pipe(Effect.provide(layer))).then(() => prompts[0]!);
  };

  it("名前があれば、直前の発言も新しい発言も 相手 B（田中）。無ければ今の形", async () => {
    const named = await run(new Map([["相手 B", "田中"]]));
    expect(lineOf(named, "直前の発言（処理済み・文脈用）")).toEqual(["r1 [00:01] 相手 B（田中）: 前"]);
    expect(lineOf(named, "新しい発言（1 文）")).toEqual(["1. r2 [00:05] 相手 B（田中）: 今"]);
    expect(lineOf(await run(undefined), "新しい発言（1 文）")).toEqual(["1. r2 [00:05] 相手 B: 今"]);
  });
});

// Issue #1027: 分類経路の名前。スキーマに必須の名前の配列が出て、分類結果の名前は DiffOutput.names になる（空なら付かない）
describe("分類経路の名前", () => {
  const name = { label: "相手 B", name: "田中", evidence: "r2", basis: "名乗り" } as const;
  const classification = (名前: Classification["名前"]) => ({ 議題: { id: "新しい議題", 題: "" }, 文: [{ 種類: "なし" }], 済み: "なし", 名前 }) as unknown as Classification;
  const run = (text: string, replies: Classification["名前"][]) => {
    let n = 0;
    const layer = localUpdaterLayer({ classify: () => Effect.sync(() => classification(replies[n++] ?? [])), katakana: () => Effect.succeed([]) });
    const input: DiffInput = { map: emptyMap("定例"), recent: [], fresh: [remark({ id: "r2", start: 5, speaker: "相手 B", text })] };
    return Effect.runPromise(Effect.flatMap(DiffUpdater, (updater) => updater.update(input)).pipe(Effect.provide(layer)));
  };

  it("JSON Schema の最上位で名前が必須の配列になり、項目は label・name・evidence・basis（2値）", () => {
    const schema = classificationRequest(emptyMap("定例"), [], [{ remark: remark({ id: "r1", start: 0 }), text: "x" }]).jsonSchema as unknown as {
      required: string[]; properties: Record<string, { type: string; items: { required: string[]; properties: { basis: { enum: string[] } } } }>;
    };
    expect(schema.required).toContain("名前");
    expect(schema.properties["名前"]!.type).toBe("array");
    expect(schema.properties["名前"]!.items.required).toEqual(["label", "name", "evidence", "basis"]);
    expect(schema.properties["名前"]!.items.properties.basis.enum).toEqual(["名乗り", "呼びかけへの応答"]);
  });

  it("分類結果の名前は names として返り、空なら names は付かない", async () => {
    expect((await run("田中です。", [[name]])).names).toEqual([name]);
    expect(await run("田中です。", [[]])).not.toHaveProperty("names");
  });

  it("4文の発言（分類が2回）では、全チャンクの名前をつなげる（どちらのチャンクの名前も落ちない）", async () => {
    const text = "一。二。三。田中です。";
    expect((await run(text, [[], [name]])).names).toEqual([name]);
    expect((await run(text, [[name], []])).names).toEqual([name]);
  });
});
