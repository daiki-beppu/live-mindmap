import { Schema } from "effect";
import { expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { init, Stored, toStored, update } from "../src/app/mapSurface/main.ts";
import { Message } from "../src/app/mapSurface/message.ts";

it.each(["live", "review"] as const)("画面に保持する部分を取り出し、外部の3フィールド以外の値を保つ（%s）", (mode) => {
  const snapshot: Snapshot = {
    nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }],
    round: 1,
    changes: [],
    remarks: [],
  };
  const surface = {
    ...update(init(snapshot, mode, true), Message.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 64 } })).model,
    speakerNames: { speaker1: "田中" },
  };
  const before = { ...surface };

  const stored = toStored(surface);

  expect(Schema.is(Stored)(stored)).toBe(true);
  expect(stored).not.toHaveProperty("mode");
  expect(stored).not.toHaveProperty("snapshot");
  expect(stored).not.toHaveProperty("speakerNames");
  expect({ ...stored, mode, snapshot, speakerNames: surface.speakerNames }).toEqual(before);
  expect(surface).toEqual(before);
});
