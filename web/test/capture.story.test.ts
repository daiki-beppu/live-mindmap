import { Option } from "effect";
import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { init, update } from "../src/app/capture/main.ts";
import { Message } from "../src/app/capture/message.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";

// 撮影の Foldkit プログラム（Issue #827）の Story。表示面の実測の事実を流すと、表示面の欄が更新され、Command は出ない

const snapshot: Snapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    { id: "A", parent: "root", kind: "議題", text: "予算", evidence: ["r1"] },
  ],
  round: 1,
  changes: [],
  remarks: [],
};

describe("撮影の Story: 表示面の実測", () => {
  it("実測の前は、画面の大きさが無い", () => {
    expect(Option.isNone(init(snapshot).mapSurface.size)).toBe(true);
  });

  it("MeasuredMapSurface を流すと、画面の大きさと高さが表示面の欄に入り、Command は出ない", () => {
    // 解いていない Command が残ると story が失敗するので、Command が出ないことはここで確かめられる
    story(
      update,
      given(init(snapshot)),
      message(Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, A: 64 } }) })),
      model((m) => {
        expect(Option.getOrNull(m.mapSurface.size)).toEqual({ width: 800, height: 600 });
        expect(Option.isSome(m.mapSurface.size)).toBe(true);
      }),
    );
  });
});
