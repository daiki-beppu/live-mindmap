import { click, expect, given, Mount, role, scene, Subscription, text } from "foldkit/scene";
import { describe, it } from "vitest";
import { ObserveMap, ObserveSeekPointer } from "../src/prototype-foldkit/effects.ts";
import { Message } from "../src/prototype-foldkit/message.ts";
import { initModel, makeContext } from "../src/prototype-foldkit/model.ts";
import { makeUpdate } from "../src/prototype-foldkit/update.ts";
import { makeView } from "../src/prototype-foldkit/view.ts";

// 試作（Issue #736）の view の Scene。キー一覧の「ノードのクリック: 根拠を出す」「?: このキー一覧を開閉する」を、描いた木で見る（DOM は使わない）

const remark = (id: string, end: number, text: string) => ({ at: "x", type: "remark", remark: { id, track: "相手", start: end - 5, end, text } });
const add = (ref: string, parent: string, kind: string, text: string, evidence: string[]) => ({ op: "add", ref, parent, kind, text, evidence });
const diff = (fresh: string[], ops: unknown[]) => ({ at: "x", type: "diff", input: { recent: [], fresh, nodeCount: 0 }, ops, dropped: [] });
const events = [
  { at: "a", type: "start", title: "定例" },
  remark("r1", 10, "採用の話をします。"),
  diff(["r1"], [add("t1", "root", "議題", "採用", ["r1"])]),
  remark("r2", 30, "予算は来月決めます。"),
  diff(["r2"], [add("t2", "root", "議題", "予算", ["r2"])]),
];

const ctx = makeContext(events, false, true);
const app = { update: makeUpdate(ctx), view: makeView(ctx, undefined) };
const mounted = [Mount.resolve(ObserveMap, Message.ResizedMap({ width: 800, height: 600 })), Mount.resolve(ObserveSeekPointer, Message.PointedSeek({ value: null }))] as const;

describe("試作の view（マップ・根拠・キー一覧）", () => {
  it("ノードを押すと、右の列にその根拠の発言が出る", () => {
    scene(
      app,
      given(initModel(ctx)),
      ...mounted,
      expect(text("ノードを選ぶと、根拠の発言が出ます")).toExist(),
      click(role("button", { name: "予算" })),
      expect(text("予算は来月決めます。")).toExist(),
    );
  });

  it("? でキー一覧が開き、見返しの行（Space・K）も載る", () => {
    scene(
      app,
      given(initModel(ctx)),
      ...mounted,
      expect(text("? このキー一覧を開閉する")).not.toExist(),
      Subscription.emit(Message.PressedKeyList()),
      expect(text("? このキー一覧を開閉する")).toExist(),
      expect(text("Space・K 進める・止める")).toExist(),
    );
  });
});
