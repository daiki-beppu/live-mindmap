import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MapNode } from "../src/core/map.ts";
import { SnapshotNode } from "../src/core/snapshot.ts";
import { JsonExport, exportFiles, toJsonExport } from "../src/core/export.ts";

const supplement = () => ({ id: "n3", parent: "n2", kind: "補足", text: "話された用語の意味", evidence: ["r1"], origin: "会議の外" });

describe("補足ノードの Schema", () => {
  it.each(["会議の中", "会議の外"])("%s の補足を書き出し、JSONの再読込とMarkdown・Drawnixでも出どころを保つ", (origin) => {
    const node = Schema.decodeUnknownSync(SnapshotNode)({ ...supplement(), origin });
    const snapshot = { nodes: [
      { id: "root", parent: null, kind: "会議" as const, text: "定例", evidence: [] },
      { id: "n2", parent: "root", kind: "要点" as const, text: "用語を話した", evidence: ["r1"] }, node,
    ], round: 1, changes: [], remarks: [] };
    const exp = toJsonExport(snapshot, [{ id: "r1", track: "相手", text: "用語", start: 0, end: 1 }]);
    const files = exportFiles(exp);
    const restored = Schema.decodeUnknownSync(Schema.fromJsonString(JsonExport))(files["map.json"]);
    expect(restored.root.children[0]!.children[0]).toMatchObject({ kind: "補足", origin, evidence: [{ id: "r1", text: "用語" }] });
    expect(files["map.md"]).toContain(`話された用語の意味（${origin}）`);
    expect(files["map.drawnix"]).toContain(`（${origin}）`);
  });

  it.each(["会議の中", "会議の外"])("%s の出どころと根拠をマップと画面のデータに保持する", (origin) => {
    const input = { ...supplement(), origin };
    const node = Schema.decodeUnknownSync(MapNode)(input);
    expect(node).toEqual(input);
    expect(Schema.decodeUnknownSync(SnapshotNode)(node)).toEqual(input);
  });

  it.each([
    { ...supplement(), origin: undefined },
    { ...supplement(), origin: "不明" },
    { ...supplement(), evidence: [] },
  ])("出どころがない・未知の出どころ・根拠がない補足は受け付けない: %j", (input) => {
    expect(() => Schema.decodeUnknownSync(MapNode)(input)).toThrow();
    expect(() => Schema.decodeUnknownSync(SnapshotNode)(input)).toThrow();
  });
});
