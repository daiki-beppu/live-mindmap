import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import { Message } from "../src/prototype-foldkit/message.ts";
import { initModel, makeContext, type Model } from "../src/prototype-foldkit/model.ts";
import { makeUpdate } from "../src/prototype-foldkit/update.ts";

// 試作（Issue #736）の update の Story。キー一覧（KeyList.tsx）の「F: 全体を見る・もう一度で戻る」「スクロール: 縦横に移動する」と、
// 見返しの「人が動かした後、触らずに 10 秒で自動に戻る」（SessionView.tsx）を、今の画面と同じ規則で満たすかを見る

const remark = (id: string, end: number, text: string) => ({ at: "x", type: "remark", remark: { id, track: "相手", start: end - 5, end, text } });
const add = (ref: string, parent: string, kind: string, text: string, evidence: string[]) => ({ op: "add", ref, parent, kind, text, evidence });
const diff = (fresh: string[], ops: unknown[]) => ({ at: "x", type: "diff", input: { recent: [], fresh, nodeCount: 0 }, ops, dropped: [] });
const events = [
  { at: "a", type: "start", title: "定例" },
  remark("r1", 10, "採用の話をします。"),
  diff(["r1"], [add("t1", "root", "議題", "採用", ["r1"])]),
  remark("r2", 30, "予算です。"),
  diff(["r2"], [add("t2", "root", "議題", "予算", ["r2"]), add("p1", "t2", "論点", "上限をどうするか", ["r2"])]),
];

const ctx = makeContext(events, false, true);
const update = makeUpdate(ctx);
const sized = (m: Model) => update(m, Message.ResizedMap({ width: 800, height: 600 })).model;

describe("試作の update（見る状態とカメラ）", () => {
  it("F で全体を見て、もう一度の F で全体を見る前の倍率・位置へ戻る", () => {
    const start = sized(initModel(ctx));
    story(
      update,
      given(start),
      message(Message.PressedViewKey({ key: "F" })),
      model((m) => {
        expect(m.viewing.mode).toBe("overview");
        expect(m.viewport).not.toEqual(start.viewport);
      }),
      message(Message.PressedViewKey({ key: "F" })),
      model((m) => {
        expect(m.viewing.mode).toBe("auto");
        expect(m.viewport).toEqual(start.viewport);
      }),
    );
  });

  it("スクロールで動かすと止まり（自動のカメラを止める）、触らずに 10 秒たつと今の議題へ戻る", () => {
    const start = sized(initModel(ctx));
    story(
      update,
      given(start),
      message(Message.Wheeled({ dx: 40, dy: 100, deltaMode: 0, shift: false, meta: false, ctrl: false, alt: false, x: 10, y: 10, at: 0 })),
      model((m) => {
        expect(m.viewing.mode).toBe("manual");
        expect(m.viewport).toEqual({ ...start.viewport, x: start.viewport.x - 20, y: start.viewport.y - 50 });
      }),
      message(Message.Idled()),
      model((m) => {
        expect(m.viewing.mode).toBe("auto");
        expect(m.viewport).toEqual(start.viewport);
      }),
    );
  });
});
