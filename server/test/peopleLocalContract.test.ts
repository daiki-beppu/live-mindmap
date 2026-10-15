import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { type DiffInput, DiffUpdater, emptyMap } from "../src/core/index.ts";
import { localUpdaterLayer } from "../src/localDiffUpdater.ts";
import { classificationRequest, type Classification } from "../src/localPrompt.ts";

// Issue #1023: TODO の担当の話者の、ローカルの分類の契約。
// Claude 側（peopleContract.test.ts）と分けて置く。1 つのファイルが claudePrompt と localPrompt の両方を読むと、
// fallow が両方の SYSTEM を重複した export として数える。

describe("ローカルの分類の契約", () => {
  const request = (sentences = ["やります。"]) => classificationRequest(emptyMap("定例"), [], sentences.map((text) => ({ remark: { id: "r1", track: "相手" as const, start: 0, end: 1, text }, text })));

  it("作業の JSON Schema に、担当の話者が必須の文字列として出る（担当・期限と同じ形）", () => {
    const schema = JSON.stringify(request().jsonSchema);
    expect(schema).toContain("担当の話者");
    const found = (function walk(node: unknown): { required: string[] } | undefined {
      if (Array.isArray(node)) return node.map(walk).find(Boolean);
      if (node && typeof node === "object") {
        const o = node as { properties?: Record<string, unknown>; required?: string[] };
        if (o.properties && "担当の話者" in o.properties) return { required: o.required ?? [] };
        return Object.values(o).map(walk).find(Boolean);
      }
      return undefined;
    })(request().jsonSchema);
    expect(found?.required).toEqual(expect.arrayContaining(["担当", "担当の話者", "期限"]));
  });

  const opsOf = (work: { 担当: string; 担当の話者: string; 期限: string }) => {
    const raw: Classification = { 議題: { id: "新しい議題", 題: "採用" }, 文: [{ 種類: "作業", text: "求人票を直す", ...work }], 済み: "なし" };
    const input: DiffInput = { map: emptyMap("定例"), recent: [], fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "私がやります。", speaker: "相手 A" }] };
    return Effect.runPromise(Effect.gen(function* () {
      const updater = yield* DiffUpdater;
      return (yield* updater.update(input)).ops.find((op) => op.op === "add" && op.kind === "TODO")!;
    }).pipe(Effect.provide(localUpdaterLayer({ katakana: () => Effect.succeed([]), classify: () => Effect.succeed(raw) }))));
  };

  it("担当の話者が書かれていれば TODO の add の assigneeSpeaker になる。名前が空なら assignee は付かない", async () => {
    const op = await opsOf({ 担当: "", 担当の話者: "相手 A", 期限: "" });
    expect(op).toMatchObject({ assigneeSpeaker: "相手 A" });
    expect(op).not.toHaveProperty("assignee");
  });

  it("担当の話者が空・「なし」などなら assigneeSpeaker は付けない", async () => {
    for (const none of ["", "なし", "不明", "  "]) {
      expect(await opsOf({ 担当: "田中", 担当の話者: none, 期限: "" }), none).not.toHaveProperty("assigneeSpeaker");
    }
  });

  it("名前があるときも名前の assignee は今までどおり付く", async () => {
    expect(await opsOf({ 担当: "田中", 担当の話者: "", 期限: "来週" })).toMatchObject({ assignee: "田中", due: "来週" });
  });
});
