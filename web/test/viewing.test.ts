import { describe, expect, it } from "vitest";
import { INITIAL_VIEWING, reduceViewing, type CameraCommand, type ViewingEvent, type ViewingState, type VisibleTree } from "../src/viewing.ts";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView, type HumanFolds } from "../src/folding.ts";
import { relocations } from "../src/relocation.ts";
import { evidenceOf } from "../src/evidence.ts";
import { foldingActions } from "./foldingActions.ts";

const tree = (currentTopic: string | undefined, changed: readonly string[] = []): VisibleTree => ({
  ids: ["root", "n1", "n2"],
  targets: { root: { x: 0, y: 0 }, n1: { x: 200, y: 0 }, n2: { x: 200, y: 80 } },
  parents: { root: null, n1: "root", n2: "root" },
  fold: null,
  changed,
  currentTopic,
});
const plainEscape: ViewingEvent = { type: "escape", meta: false, ctrl: false, alt: false };
const moved: ViewingEvent = { type: "userMoved" };
const reflect: ViewingEvent = { type: "reflect", replaced: {} };

// 同じ状態を出来事の列でつなぐ。
const run = (events: [ViewingEvent, VisibleTree][], from: ViewingState = INITIAL_VIEWING) => {
  let state = from;
  const commands: CameraCommand[] = [];
  for (const [event, t] of events) {
    const out = reduceViewing(state, event, t);
    state = out.state;
    commands.push(out.camera);
  }
  return { state, commands };
};

describe("reduceViewing: 人が動かすと自動のカメラが止まる", () => {
  it("最初は自動で、人が動かすと止まり（hold）、そのときの議題を覚える", () => {
    expect(INITIAL_VIEWING).toEqual({ mode: "auto" });
    const out = reduceViewing(INITIAL_VIEWING, moved, tree("n1"));
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
    expect(out.camera).toEqual({ type: "hold" });
  });

  it("止まっている間にまた動かしても止まったまま（議題は動かした時点の今の議題）", () => {
    const { state, commands } = run([[moved, tree("n1")], [moved, tree("n1")]]);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }]);
  });

  it("自動のままの反映は、今までどおり自動で寄せる（follow）", () => {
    const out = reduceViewing(INITIAL_VIEWING, reflect, tree("n1"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });
});

describe("reduceViewing: 反映と Esc での戻り", () => {
  it("今の議題が変わらない反映では、止まったまま（hold）。何度届いても戻らない", () => {
    const { state, commands } = run([[moved, tree("n1")], [reflect, tree("n1")], [reflect, tree("n1")]]);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }, { type: "hold" }]);
  });

  it("止まっている間に今の議題が変わる反映で、自動に戻り、寄せ直す（refocus）", () => {
    const { state, commands } = run([[moved, tree("n1")], [reflect, tree("n1")], [reflect, tree("n2")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }, { type: "refocus" }]);
  });

  it("今の議題がなくなる反映も、議題が変わったとして自動に戻る", () => {
    const { state, commands } = run([[moved, tree("n1")], [reflect, tree(undefined)]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "refocus" }]);
  });

  it("止まっている間の修飾なしの Esc で、自動に戻り、寄せ直す（refocus）", () => {
    const { state, commands } = run([[moved, tree("n1")], [plainEscape, tree("n1")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "refocus" }]);
  });

  it("戻った後はまた動かせば止まり、同じ議題の反映では戻らない（戻りは1回きりではない）", () => {
    const { state } = run([[moved, tree("n1")], [plainEscape, tree("n1")], [moved, tree("n1")], [reflect, tree("n1")]]);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
  });

  it("自動のときの Esc は何も変えず、自動で寄せる（follow）", () => {
    const out = reduceViewing(INITIAL_VIEWING, plainEscape, tree("n1"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });
});

describe("reduceViewing: ⌘・Ctrl・Option 付きの Esc は無視する", () => {
  const modifiers: [string, ViewingEvent][] = [
    ["meta", { type: "escape", meta: true, ctrl: false, alt: false }],
    ["ctrl", { type: "escape", meta: false, ctrl: true, alt: false }],
    ["alt", { type: "escape", meta: false, ctrl: false, alt: true }],
  ];

  for (const [name, event] of modifiers) {
    it(`${name} 付きの Esc では止まったまま（hold）。同じ状態から修飾なしの Esc なら戻る`, () => {
      const stopped = run([[moved, tree("n1")]]).state;
      const ignored = reduceViewing(stopped, event, tree("n1"));
      expect(ignored.state).toEqual({ mode: "manual", topic: "n1" });
      expect(ignored.camera).toEqual({ type: "hold" });
      // 対照: ガードがないと、この状態からは戻ってしまう
      const accepted = reduceViewing(stopped, plainEscape, tree("n1"));
      expect(accepted.state).toEqual({ mode: "auto" });
      expect(accepted.camera).toEqual({ type: "refocus" });
    });

    it(`${name} 付きの Esc は、自動のとき何も変えない（follow）`, () => {
      const out = reduceViewing(INITIAL_VIEWING, event, tree("n1"));
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "follow" });
    });
  }

  it("無視した後も、議題が変わる反映では戻る（無視で状態が壊れない）", () => {
    const { state, commands } = run([[moved, tree("n1")], [modifiers[0]![1], tree("n1")], [reflect, tree("n2")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }, { type: "refocus" }]);
  });
});

describe("reduceViewing: 純粋な関数", () => {
  it("入力の状態と木を書き換えず、新しいオブジェクトを返す", () => {
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
    const t = tree("n2");
    const snapshot = JSON.stringify(t);
    const out = reduceViewing(state, reflect, t);
    expect(out.state).not.toBe(state);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(JSON.stringify(t)).toBe(snapshot);
    const first = reduceViewing(INITIAL_VIEWING, moved, tree("n1"));
    expect(first.state).not.toBe(INITIAL_VIEWING);
    expect(INITIAL_VIEWING).toEqual({ mode: "auto" });
  });

  it("同じ入力なら同じ出力", () => {
    const state: ViewingState = { mode: "manual", topic: "n1" };
    expect(reduceViewing(state, reflect, tree("n2"))).toEqual(reduceViewing(state, reflect, tree("n2")));
  });
});

type Key = Extract<ViewingEvent, { type: "key" }>["key"];
const key = (k: Key, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({
  type: "key",
  key: k,
  meta: false,
  ctrl: false,
  alt: false,
  ...mods,
});

describe("reduceViewing: キーは人の操作として止め、各指示を出す", () => {
  const cases: [Key, CameraCommand][] = [
    ["=", { type: "zoomBy", factor: 1.25 }],
    ["-", { type: "zoomBy", factor: 1 / 1.25 }],
    ["0", { type: "zoomTo", zoom: 1 }],
    ["Shift+ArrowRight", { type: "pan", dx: 1, dy: 0 }],
    ["Shift+ArrowLeft", { type: "pan", dx: -1, dy: 0 }],
    ["Shift+ArrowDown", { type: "pan", dx: 0, dy: 1 }],
    ["Shift+ArrowUp", { type: "pan", dx: 0, dy: -1 }],
  ];

  for (const [k, command] of cases) {
    it(`${k}: 自動から止まり（議題を覚える）、${command.type} を出す`, () => {
      const out = reduceViewing(INITIAL_VIEWING, key(k), tree("n1"));
      expect(out.state).toEqual({ mode: "manual", topic: "n1" });
      expect(out.camera).toEqual(command);
    });

    it(`${k}: 止まっている間は、その時点の今の議題で止まったまま`, () => {
      const out = reduceViewing({ mode: "manual", topic: "n1" }, key(k), tree("n2"));
      expect(out.state).toEqual({ mode: "manual", topic: "n2" });
      expect(out.camera).toEqual(command);
    });

    it(`${k}: 全体を見ている間に押しても止まった状態になる`, () => {
      const overview = run([[key("F"), tree("n1")]]).state;
      expect(overview.mode).toBe("overview");
      const out = reduceViewing(overview, key(k), tree("n1"));
      expect(out.state).toEqual({ mode: "manual", topic: "n1" });
      expect(out.camera).toEqual(command);
    });
  }
});

describe("reduceViewing: ⌘・Ctrl・Option 付きのキーは無視する", () => {
  const keys: Key[] = ["=", "-", "0", "F", "Shift+ArrowRight"];
  const mods: [string, Partial<{ meta: boolean; ctrl: boolean; alt: boolean }>][] = [
    ["meta", { meta: true }],
    ["ctrl", { ctrl: true }],
    ["alt", { alt: true }],
  ];

  for (const k of keys) {
    for (const [name, m] of mods) {
      it(`${name} 付きの ${k}: 自動では何も変えず follow`, () => {
        const out = reduceViewing(INITIAL_VIEWING, key(k, m), tree("n1"));
        expect(out.state).toEqual({ mode: "auto" });
        expect(out.camera).toEqual({ type: "follow" });
      });

      it(`${name} 付きの ${k}: 止まっている間は変えず hold。修飾なしなら変わる（対照）`, () => {
        const stopped: ViewingState = { mode: "manual", topic: "n1" };
        const ignored = reduceViewing(stopped, key(k, m), tree("n2"));
        expect(ignored.state).toEqual(stopped);
        expect(ignored.camera).toEqual({ type: "hold" });
        expect(reduceViewing(stopped, key(k), tree("n2")).camera).not.toEqual({ type: "hold" });
      });
    }
  }

  it("全体を見ている間の修飾付きの F は無視し、状態を変えず hold", () => {
    const overview = run([[key("F"), tree("n1")]]).state;
    const out = reduceViewing(overview, key("F", { meta: true }), tree("n1"));
    expect(out.state).toEqual(overview);
    expect(out.camera).toEqual({ type: "hold" });
  });
});

describe("reduceViewing: F で全体を見て、もう一度押すと最後の反映で変わったところへ寄る", () => {
  const changedTree = tree("n1", ["n2"]);

  it("自動で F を押すと全体を見る状態になり（前の状態は覚えない）、全体を収める（fitAll）", () => {
    const out = reduceViewing(INITIAL_VIEWING, key("F"), changedTree);
    expect(out.state).toEqual({ mode: "overview", topic: "n1" });
    expect(out.camera).toEqual({ type: "fitAll" });
  });

  it("止めているとき F を押しても全体を見る状態になり、全体を収める（fitAll）", () => {
    const out = reduceViewing({ mode: "manual", topic: "n2" }, key("F"), changedTree);
    expect(out.state).toEqual({ mode: "overview", topic: "n1" });
    expect(out.camera).toEqual({ type: "fitAll" });
  });

  it("自動 → F → F で、差分を見る状態（今の議題を覚える）になり、変わったノードへ寄る（fitChanged）", () => {
    const { state, commands } = run([[key("F"), changedTree], [key("F"), changedTree]]);
    expect(state).toEqual({ mode: "diff", topic: "n1" });
    expect(commands).toEqual([{ type: "fitAll" }, { type: "fitChanged" }]);
  });

  it("人 → F → F でも同じ（止めていた位置へ戻る restore は出ない・止めた状態にも戻らない）", () => {
    const { state, commands } = run([[key("F"), changedTree], [key("F"), changedTree]], { mode: "manual", topic: "n2" });
    expect(state).toEqual({ mode: "diff", topic: "n1" });
    expect(commands).toEqual([{ type: "fitAll" }, { type: "fitChanged" }]);
  });

  it("差分を見る状態が覚える議題は、2 回目の F を押した時点の今の議題", () => {
    const { state } = run([[key("F"), tree("n1", ["n2"])], [key("F"), tree("n2", ["n1"])]]);
    expect(state).toEqual({ mode: "diff", topic: "n2" });
  });

  it("最後の反映で変わったノードが無いときの 2 回目の F は、自動に戻り今の議題へ寄せ直す（refocus）。前が自動でも人でも同じ", () => {
    for (const from of [INITIAL_VIEWING, { mode: "manual", topic: "n2" } as ViewingState]) {
      const { state, commands } = run([[key("F"), tree("n1")], [key("F"), tree("n1")]], from);
      expect(state).toEqual({ mode: "auto" });
      expect(commands).toEqual([{ type: "fitAll" }, { type: "refocus" }]);
    }
  });

  it("全体を見る前に変化が無くても、2 回目の F を押した時点の変化で決まる（変化があれば diff）", () => {
    const { state, commands } = run([[key("F"), tree("n1")], [key("F"), changedTree]]);
    expect(state).toEqual({ mode: "diff", topic: "n1" });
    expect(commands.at(-1)).toEqual({ type: "fitChanged" });
  });

  it("差分を見ているとき F を押すと、全体を見る（1 回目と同じ。fitAll）", () => {
    const diff: ViewingState = { mode: "diff", topic: "n1" };
    const out = reduceViewing(diff, key("F"), changedTree);
    expect(out.state).toEqual({ mode: "overview", topic: "n1" });
    expect(out.camera).toEqual({ type: "fitAll" });
  });

  it("F を繰り返すと 全体 → 差分 → 全体 → 差分 と巡る（1回きりではない）", () => {
    const { state, commands } = run([1, 2, 3, 4].map((): [ViewingEvent, VisibleTree] => [key("F"), changedTree]));
    expect(state).toEqual({ mode: "diff", topic: "n1" });
    expect(commands).toEqual([{ type: "fitAll" }, { type: "fitChanged" }, { type: "fitAll" }, { type: "fitChanged" }]);
  });

  it("差分を見ている間の修飾付きの F は無視し、状態を変えず hold", () => {
    const diff: ViewingState = { mode: "diff", topic: "n1" };
    for (const mod of ["meta", "ctrl", "alt"] as const) {
      const out = reduceViewing(diff, key("F", { [mod]: true }), changedTree);
      expect(out.state).toEqual(diff);
      expect(out.camera).toEqual({ type: "hold" });
    }
  });
});

describe("reduceViewing: 差分を見ている間の Esc・人の操作・反映", () => {
  const diff: ViewingState = { mode: "diff", topic: "n1" };
  const changedTree = (topic: string | undefined) => tree(topic, ["n2"]);

  it("修飾なしの Esc で自動に戻り、今の議題へ寄せ直す（refocus）", () => {
    const out = reduceViewing(diff, plainEscape, changedTree("n1"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("修飾付きの Esc は無視し、差分を見たまま hold", () => {
    const out = reduceViewing(diff, { type: "escape", meta: true, ctrl: false, alt: false }, changedTree("n1"));
    expect(out.state).toEqual(diff);
    expect(out.camera).toEqual({ type: "hold" });
  });

  it("人が動かす（userMoved）と止まった状態になり、動かさない（hold）", () => {
    const out = reduceViewing(diff, moved, changedTree("n2"));
    expect(out.state).toEqual({ mode: "manual", topic: "n2" });
    expect(out.camera).toEqual({ type: "hold" });
  });

  it.each(["=", "Shift+ArrowRight"] as const)("%s を押すと止まった状態になる", (k) => {
    const out = reduceViewing(diff, key(k), changedTree("n1"));
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
  });

  it("縁の点を押すと止まった状態になり、そのノードへ寄る", () => {
    const out = reduceViewing(diff, { type: "edgeDot", id: "n2" }, changedTree("n1"));
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
    expect(out.camera).toEqual({ type: "focusNode", id: "n2" });
  });

  it("今の議題が同じで変化がある反映は、差分を見たまま変わったノードへ寄り直す（fitChanged）。何度届いても戻らない", () => {
    const { state, commands } = run([[reflect, changedTree("n1")], [reflect, changedTree("n1")]], diff);
    expect(state).toEqual(diff);
    expect(commands).toEqual([{ type: "fitChanged" }, { type: "fitChanged" }]);
  });

  it("今の議題が同じで変化が無い反映は、差分を見たまま動かさない（hold。fitChanged でも follow でもない）", () => {
    const { state, commands } = run([[reflect, tree("n1")], [reflect, tree("n1")]], diff);
    expect(state).toEqual(diff);
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }]);
  });

  it("今の議題が変わる反映で、自動に戻り寄せ直す（refocus）。変化があってもなくても同じ", () => {
    for (const t of [changedTree("n2"), tree("n2")]) {
      const out = reduceViewing(diff, reflect, t);
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    }
  });

  it("今の議題がなくなる反映も、議題が変わったとして自動に戻る", () => {
    const out = reduceViewing(diff, reflect, changedTree(undefined));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("触らずに 10 秒たっても変えず hold（ライブ・見返しとも。戻るのは止めている間だけ）", () => {
    for (const scope of ["live", "review"] as const) {
      const out = reduceViewing(diff, { type: "idle" }, changedTree("n1"), scope);
      expect(out.state).toEqual(diff);
      expect(out.camera).toEqual({ type: "hold" });
    }
  });

  it("入力の状態と木を書き換えない", () => {
    const frozen: ViewingState = Object.freeze({ mode: "diff", topic: "n1" });
    const t = changedTree("n1");
    const snapshot = JSON.stringify(t);
    reduceViewing(frozen, key("F"), t);
    reduceViewing(frozen, reflect, t);
    expect(frozen).toEqual({ mode: "diff", topic: "n1" });
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

describe("reduceViewing: 全体を見ている間の反映・Esc", () => {
  const overviewOf = (from: ViewingState = INITIAL_VIEWING) => run([[key("F"), tree("n1")]], from).state;

  it("議題が同じままの反映では全体を見たまま、収め直す（fitAll）。何度届いても戻らない", () => {
    const { state, commands } = run([[reflect, tree("n1")], [reflect, tree("n1")]], overviewOf());
    expect(state.mode).toBe("overview");
    expect(commands).toEqual([{ type: "fitAll" }, { type: "fitAll" }]);
  });

  it("今の議題が変わる反映で、自動に戻り寄せ直す（refocus）。前が人でも自動", () => {
    for (const from of [INITIAL_VIEWING, { mode: "manual", topic: "n1" } as ViewingState]) {
      const out = reduceViewing(overviewOf(from), reflect, tree("n2"));
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    }
  });

  it("今の議題がなくなる反映も、議題が変わったとして自動に戻る", () => {
    const out = reduceViewing(overviewOf(), reflect, tree(undefined));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("修飾なしの Esc で自動に戻り、寄せ直す（refocus）。前が人でも自動", () => {
    for (const from of [INITIAL_VIEWING, { mode: "manual", topic: "n1" } as ViewingState]) {
      const out = reduceViewing(overviewOf(from), plainEscape, tree("n1"));
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    }
  });

  it("修飾付きの Esc は無視し、全体を見たまま hold", () => {
    const overview = overviewOf();
    const out = reduceViewing(overview, { type: "escape", meta: true, ctrl: false, alt: false }, tree("n1"));
    expect(out.state).toEqual(overview);
    expect(out.camera).toEqual({ type: "hold" });
  });

  it("人が動かすと止まった状態になり、動かさない（hold）", () => {
    const out = reduceViewing(overviewOf(), moved, tree("n1"));
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
    expect(out.camera).toEqual({ type: "hold" });
  });
});

describe("reduceViewing: キーでも入力を書き換えない", () => {
  it("全体を見る状態から F を押しても、入力の状態と木は変わらない", () => {
    const overview = run([[key("F"), tree("n1")]], { mode: "manual", topic: "n1" }).state;
    const frozen = structuredClone(overview);
    const t = tree("n1");
    const snapshot = JSON.stringify(t);
    reduceViewing(overview, key("F"), t);
    expect(overview).toEqual(frozen);
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

const dot = (id: string): ViewingEvent => ({ type: "edgeDot", id });

describe("reduceViewing: 縁の点を押すと、そのノードへ寄り、人の状態のままになる", () => {
  it("止めているとき、そのノードへ寄る指示（focusNode）が出て、止めたまま（議題は今の議題）", () => {
    const out = reduceViewing({ mode: "manual", topic: "n1" }, dot("n2"), tree("n1"));
    expect(out.camera).toEqual({ type: "focusNode", id: "n2" });
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
  });

  it("全体を見ているときに押しても、止めた状態になり、そのノードへ寄る", () => {
    const overview = run([[key("F"), tree("n1")]]).state;
    expect(overview.mode).toBe("overview");
    const out = reduceViewing(overview, dot("n2"), tree("n1"));
    expect(out.camera).toEqual({ type: "focusNode", id: "n2" });
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
  });

  it("寄った後、議題が同じ反映が届いても止めたまま動かさない（hold）。議題が変われば自動に戻る（対照）", () => {
    const { state, commands } = run([[dot("n2"), tree("n1")], [reflect, tree("n1")], [reflect, tree("n1")]], { mode: "manual", topic: "n1" });
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(commands).toEqual([{ type: "focusNode", id: "n2" }, { type: "hold" }, { type: "hold" }]);
    const changed = run([[dot("n2"), tree("n1")], [reflect, tree("n2")]], { mode: "manual", topic: "n1" });
    expect(changed.state).toEqual({ mode: "auto" });
    expect(changed.commands[1]).toEqual({ type: "refocus" });
  });

  it("見えていないノードの点は、状態を変えず動かさない（hold）。見えているノードなら寄る（対照）", () => {
    const manual: ViewingState = { mode: "manual", topic: "n1" };
    const gone = reduceViewing(manual, dot("gone"), tree("n1"));
    expect(gone.state).toEqual(manual);
    expect(gone.camera).toEqual({ type: "hold" });
    expect(reduceViewing(manual, dot("n2"), tree("n1")).camera).toEqual({ type: "focusNode", id: "n2" });
  });

  it("入力の状態と木を書き換えず、同じ入力なら同じ出力", () => {
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
    const t = tree("n1");
    const snapshot = JSON.stringify(t);
    const out = reduceViewing(state, dot("n2"), t);
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
    expect(out.camera).toEqual({ type: "focusNode", id: "n2" });
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(JSON.stringify(t)).toBe(snapshot);
    expect(reduceViewing(state, dot("n2"), t)).toEqual(out);
  });
});

describe("reduceViewing: ? のキー一覧の開閉", () => {
  const help = (over: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type: "keyList", meta: false, ctrl: false, alt: false, ...over });
  const manual: ViewingState = { mode: "manual", topic: "n1" };
  const overview: ViewingState = { mode: "overview", topic: "n1" };
  const diff: ViewingState = { mode: "diff", topic: "n1" };
  const open = (s: ViewingState): ViewingState => ({ ...s, keyList: true });

  it.each([
    ["自動", INITIAL_VIEWING, "follow"],
    ["manual", manual, "hold"],
    ["overview", overview, "hold"],
    ["diff", diff, "hold"],
  ] as const)("%s のとき ? で開き、カメラの状態は変えず何もしない指示。もう一度で閉じて元の状態に戻る", (_name, from, cmd) => {
    const opened = reduceViewing(from, help(), tree("n1"));
    expect(opened.state).toEqual(open(from));
    expect(opened.camera).toEqual({ type: cmd });
    const closed = reduceViewing(opened.state, help(), tree("n1"));
    expect(closed.state).toEqual(from);
    expect("keyList" in closed.state).toBe(false);
    expect(closed.camera).toEqual({ type: cmd });
  });

  it.each(["meta", "ctrl", "alt"] as const)("%s 付きの ? は無視する（閉じていても開いていても状態は同じ）", (mod) => {
    const closedOut = reduceViewing(manual, help({ [mod]: true }), tree("n1"));
    expect(closedOut.state).toEqual(manual);
    expect(closedOut.camera).toEqual({ type: "hold" });
    const openState = open(manual);
    const openOut = reduceViewing(openState, help({ [mod]: true }), tree("n1"));
    expect(openOut.state).toEqual(openState);
    expect(openOut.camera).toEqual({ type: "hold" });
    expect(reduceViewing(INITIAL_VIEWING, help({ [mod]: true }), tree("n1"))).toEqual({ state: INITIAL_VIEWING, camera: { type: "follow" } });
  });

  it("開いている間の Esc は一覧を閉じるだけ（manual のまま・hold）。次の Esc で自動に戻り refocus", () => {
    const first = reduceViewing(open(manual), plainEscape, tree("n1"));
    expect(first.state).toEqual(manual);
    expect("keyList" in first.state).toBe(false);
    expect(first.camera).toEqual({ type: "hold" });
    const second = reduceViewing(first.state, plainEscape, tree("n1"));
    expect(second.state).toEqual({ mode: "auto" });
    expect(second.camera).toEqual({ type: "refocus" });
  });

  it("overview で開いている間の Esc も閉じるだけ。次の Esc で自動に戻る", () => {
    const first = reduceViewing(open(overview), plainEscape, tree("n1"));
    expect(first.state).toEqual(overview);
    expect(first.camera).toEqual({ type: "hold" });
    expect(reduceViewing(first.state, plainEscape, tree("n1"))).toEqual({ state: { mode: "auto" }, camera: { type: "refocus" } });
  });

  it("自動で開いている間の Esc は閉じるだけ（follow）", () => {
    const out = reduceViewing(open(INITIAL_VIEWING), plainEscape, tree("n1"));
    expect(out.state).toEqual({ mode: "auto" });
    expect("keyList" in out.state).toBe(false);
    expect(out.camera).toEqual({ type: "follow" });
  });

  it("修飾キー付きの Esc では閉じない", () => {
    for (const mod of ["meta", "ctrl", "alt"] as const) {
      const out = reduceViewing(open(manual), { ...plainEscape, [mod]: true }, tree("n1"));
      expect(out.state).toEqual(open(manual));
      expect(out.camera).toEqual({ type: "hold" });
    }
  });

  it("開いたままになる: 同じ議題の反映・議題が変わる反映・人の操作・キー・縁の点", () => {
    const base = open(manual);
    expect(reduceViewing(base, reflect, tree("n1"))).toEqual({ state: base, camera: { type: "hold" } });
    const changed = reduceViewing(base, reflect, tree("n2"));
    expect(changed.state).toEqual(open(INITIAL_VIEWING));
    expect(changed.camera).toEqual({ type: "refocus" });
    expect(reduceViewing(open(INITIAL_VIEWING), moved, tree("n1")).state).toEqual(open(manual));
    expect(reduceViewing(base, { type: "key", key: "=", meta: false, ctrl: false, alt: false }, tree("n1")).state).toEqual(base);
    expect(reduceViewing(base, { type: "edgeDot", id: "n2" }, tree("n1")).state).toEqual(base);
  });

  it("開いたまま F → F で差分を見る状態に入っても、開いたまま（keyList は覚える議題の側に入らない）", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const changed = tree("n1", ["n2"]);
    const toOverview = reduceViewing(open(manual), f, changed);
    expect(toOverview.state).toEqual(open({ mode: "overview", topic: "n1" }));
    const toDiff = reduceViewing(toOverview.state, f, changed);
    expect(toDiff.state).toEqual(open({ mode: "diff", topic: "n1" }));
    expect(toDiff.camera).toEqual({ type: "fitChanged" });
  });

  it("閉じた後の F → F では、差分を見る状態に古い開閉が残らない", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const t = tree("n1", ["n2"]);
    const { state } = run([[help(), t], [f, t], [help(), t], [f, t]], manual);
    expect(state).toEqual({ mode: "diff", topic: "n1" });
    expect("keyList" in state).toBe(false);
  });

  it("入力の状態を書き換えない", () => {
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
    const out = reduceViewing(state, help(), tree("n1"));
    expect(out.state).toEqual(open(manual));
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    const frozenOpen: ViewingState = Object.freeze({ mode: "manual", topic: "n1", keyList: true });
    expect(reduceViewing(frozenOpen, plainEscape, tree("n1")).state).toEqual(manual);
    expect(frozenOpen).toEqual(open(manual));
  });
});

const idle: ViewingEvent = { type: "idle" };
const timeMoved: ViewingEvent = { type: "timeMoved" };
const bothEvents: [string, ViewingEvent][] = [["触らずに 10 秒たった", idle], ["時刻を動かした", timeMoved]];

// 見返し（"review"）かライブかを渡して、出来事の列を同じ状態につなぐ。
const runIn = (scope: "live" | "review", events: [ViewingEvent, VisibleTree][], from: ViewingState = INITIAL_VIEWING) => {
  let state = from;
  const commands: CameraCommand[] = [];
  for (const [event, t] of events) {
    const out = reduceViewing(state, event, t, scope);
    state = out.state;
    commands.push(out.camera);
  }
  return { state, commands };
};

const manualN1: ViewingState = { mode: "manual", topic: "n1" };
const overviewFrom = (from: ViewingState) => run([[key("F"), tree("n1")]], from).state;

describe("reduceViewing: 見返しでは、触らずに 10 秒たつか時刻を動かすと自動に戻る", () => {
  for (const [name, event] of bothEvents) {
    it(`見返しで止めているとき、${name}と自動に戻り、寄せ直す（refocus）`, () => {
      const out = reduceViewing(manualN1, event, tree("n1"), "review");
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    });
  }

  it("見返しで全体を見ているとき、時刻を動かすと自動に戻り、寄せ直す。前が自動でも人でも同じ", () => {
    for (const from of [INITIAL_VIEWING, manualN1]) {
      const overview = overviewFrom(from);
      expect(overview.mode).toBe("overview");
      const out = reduceViewing(overview, timeMoved, tree("n1"), "review");
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    }
  });

  it("見返しで全体を見ているとき、触らずに 10 秒たっても何も変えない（hold）。対照として時刻なら戻る", () => {
    const overview = overviewFrom(INITIAL_VIEWING);
    const out = reduceViewing(overview, idle, tree("n1"), "review");
    expect(out.state).toEqual(overview);
    expect(out.camera).toEqual({ type: "hold" });
    expect(reduceViewing(overview, timeMoved, tree("n1"), "review").state).toEqual({ mode: "auto" });
  });

  it("止まる → 触らず戻る → また止まる → 時刻で戻る（戻りは1回きりではない）", () => {
    const { state, commands } = runIn("review", [[moved, tree("n1")], [idle, tree("n1")], [moved, tree("n1")], [timeMoved, tree("n1")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "refocus" }, { type: "hold" }, { type: "refocus" }]);
  });

  it("戻った後に人が動かすと、また止まる", () => {
    const { state } = runIn("review", [[moved, tree("n1")], [timeMoved, tree("n1")], [moved, tree("n1")]]);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
  });
});

describe("reduceViewing: ライブでは時間でも時刻でも戻らない", () => {
  const states: [string, ViewingState][] = [
    ["止めている", manualN1],
    ["全体を見ている", overviewFrom(INITIAL_VIEWING)],
  ];
  for (const [eventName, event] of bothEvents) {
    for (const [stateName, from] of states) {
      it(`${stateName}とき、${eventName}でも変えず hold（scope 省略・"live" 明示とも）。見返しなら戻る（対照）`, () => {
        const omitted = reduceViewing(from, event, tree("n1"));
        const explicit = reduceViewing(from, event, tree("n1"), "live");
        for (const out of [omitted, explicit]) {
          expect(out.state).toEqual(from);
          expect(out.camera).toEqual({ type: "hold" });
        }
        if (!(stateName === "全体を見ている" && event.type === "idle")) {
          expect(reduceViewing(from, event, tree("n1"), "review").state).toEqual({ mode: "auto" });
        }
      });
    }
  }
});

describe("reduceViewing: 自動のときは、2 つの出来事で何も変わらない", () => {
  for (const scope of ["live", "review"] as const) {
    for (const [name, event] of bothEvents) {
      it(`${scope}: ${name}でも自動のまま、自動で寄せる（follow）`, () => {
        const out = reduceViewing(INITIAL_VIEWING, event, tree("n1"), scope);
        expect(out.state).toEqual({ mode: "auto" });
        expect(out.camera).toEqual({ type: "follow" });
      });
    }
  }
});

describe("reduceViewing: 新しい出来事でも入力を書き換えない", () => {
  it("止めている状態に適用しても、入力の状態と木は変わらず、同じ入力なら同じ出力", () => {
    for (const [, event] of bothEvents) {
      const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
      const t = tree("n1");
      const snapshot = JSON.stringify(t);
      const out = reduceViewing(state, event, t, "review");
      expect(state).toEqual({ mode: "manual", topic: "n1" });
      expect(JSON.stringify(t)).toBe(snapshot);
      expect(reduceViewing(state, event, t, "review")).toEqual(out);
    }
  });
});

describe("reduceViewing: E で右の列、C で字幕を出し入れする（カメラの状態とは独立）", () => {
  const toggle = (type: "side" | "captions", over: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type, meta: false, ctrl: false, alt: false, ...over });
  const manual: ViewingState = { mode: "manual", topic: "n1" };
  const overview: ViewingState = { mode: "overview", topic: "n1" };
  const diff: ViewingState = { mode: "diff", topic: "n1" };
  const cameras = [
    ["自動", INITIAL_VIEWING],
    ["manual", manual],
    ["overview", overview],
    ["diff", diff],
  ] as const;
  const FLAG = { side: "sideHidden", captions: "captionsHidden" } as const;
  const hidden = (s: ViewingState, type: "side" | "captions"): ViewingState => ({ ...s, [FLAG[type]]: true });

  it("初めは両方とも出している（隠す印を持たない）", () => {
    expect("sideHidden" in INITIAL_VIEWING).toBe(false);
    expect("captionsHidden" in INITIAL_VIEWING).toBe(false);
  });

  for (const type of ["side", "captions"] as const) {
    it.each(cameras)(`${type}: %s のとき、押すと隠れ、もう一度で出て元の状態に戻る（印が残らない）`, (_name, from) => {
      const hide = reduceViewing(from, toggle(type), tree("n1"));
      expect(hide.state).toEqual(hidden(from, type));
      const show = reduceViewing(hide.state, toggle(type), tree("n1"));
      expect(show.state).toEqual(from);
      expect(FLAG[type] in show.state).toBe(false);
    });

    it.each(["meta", "ctrl", "alt"] as const)(`${type}: %s 付きでは、出ていても隠れていても状態を変えない`, (mod) => {
      for (const [, from] of cameras) {
        expect(reduceViewing(from, toggle(type, { [mod]: true }), tree("n1")).state).toEqual(from);
        const h = hidden(from, type);
        expect(reduceViewing(h, toggle(type, { [mod]: true }), tree("n1")).state).toEqual(h);
      }
    });
  }

  it("E と C は互いの出し入れに触らない", () => {
    const sideHidden = reduceViewing(manual, toggle("side"), tree("n1")).state;
    const both = reduceViewing(sideHidden, toggle("captions"), tree("n1")).state;
    expect(both).toEqual({ ...manual, sideHidden: true, captionsHidden: true });
    expect(reduceViewing(both, toggle("side"), tree("n1")).state).toEqual({ ...manual, captionsHidden: true });
    expect(reduceViewing(both, toggle("captions"), tree("n1")).state).toEqual({ ...manual, sideHidden: true });
  });

  it("キー一覧を開いたままでも、開閉は変えずに出し入れできる", () => {
    const opened: ViewingState = { ...manual, keyList: true };
    expect(reduceViewing(opened, toggle("side"), tree("n1")).state).toEqual({ ...opened, sideHidden: true });
    expect(reduceViewing(opened, toggle("captions"), tree("n1")).state).toEqual({ ...opened, captionsHidden: true });
  });

  it("キー一覧の開閉と Esc は、隠している印を変えない", () => {
    const h: ViewingState = { ...manual, sideHidden: true, captionsHidden: true };
    const help: ViewingEvent = { type: "keyList", meta: false, ctrl: false, alt: false };
    const opened = reduceViewing(h, help, tree("n1")).state;
    expect(opened).toEqual({ ...h, keyList: true });
    expect(reduceViewing(opened, help, tree("n1")).state).toEqual(h);
    expect(reduceViewing(opened, plainEscape, tree("n1")).state).toEqual(h);
  });

  it("Esc（manual なら自動へ戻る Esc も、修飾付きも）では出し入れが変わらない", () => {
    for (const [, from] of cameras) {
      const h: ViewingState = { ...from, sideHidden: true, captionsHidden: true };
      const out = reduceViewing(h, plainEscape, tree("n1"));
      expect(out.state.sideHidden).toBe(true);
      expect(out.state.captionsHidden).toBe(true);
      const mod = reduceViewing(h, { ...plainEscape, meta: true }, tree("n1"));
      expect(mod.state).toEqual(h);
    }
    expect(reduceViewing({ ...manual, sideHidden: true }, plainEscape, tree("n1")).state).toEqual({ mode: "auto", sideHidden: true });
  });

  it("カメラの状態を変える出来事（人の操作・反映・縁の点・キー・見返しの idle / timeMoved）でも出し入れは変わらない", () => {
    const h = (s: ViewingState): ViewingState => ({ ...s, sideHidden: true, captionsHidden: true });
    const keep = (state: ViewingState, event: ViewingEvent, t: VisibleTree, scope: "live" | "review" = "live") => {
      const out = reduceViewing(state, event, t, scope).state;
      expect(out.sideHidden).toBe(true);
      expect(out.captionsHidden).toBe(true);
      return out;
    };
    keep(h(INITIAL_VIEWING), moved, tree("n1"));
    keep(h(INITIAL_VIEWING), reflect, tree("n1"));
    keep(h(manual), reflect, tree("n2")); // 議題が変わって自動へ戻る
    keep(h(manual), { type: "edgeDot", id: "n2" }, tree("n1"));
    keep(h(INITIAL_VIEWING), { type: "key", key: "=", meta: false, ctrl: false, alt: false }, tree("n1"));
    keep(h(manual), { type: "idle" }, tree("n1"), "review");
    keep(h(manual), { type: "timeMoved" }, tree("n1"), "review");
    keep(h(overview), { type: "timeMoved" }, tree("n1"), "review");
  });

  it("隠したまま F → F で差分を見る状態に入っても隠したまま。全体を見ている間に出し直してから入ると、出た状態になる", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const changed = tree("n1", ["n2"]);
    const start: ViewingState = { ...manual, sideHidden: true };
    const toOverview = reduceViewing(start, f, changed).state;
    expect(toOverview).toEqual({ mode: "overview", topic: "n1", sideHidden: true });
    expect(reduceViewing(toOverview, f, changed).state).toEqual({ mode: "diff", topic: "n1", sideHidden: true });
    const shownAgain = reduceViewing(toOverview, toggle("side"), changed).state;
    expect(reduceViewing(shownAgain, f, changed).state).toEqual({ mode: "diff", topic: "n1" });
  });

  it.each(cameras)("E / C はカメラの状態（%s）を変えない", (_name, from) => {
    for (const type of ["side", "captions"] as const) {
      const out = reduceViewing(from, toggle(type), tree("n1")).state;
      const { sideHidden: _s, captionsHidden: _c, ...camera } = out;
      expect(camera).toEqual(from);
    }
  });

  it.each(cameras)("E は %s のとき、寄せ直す指示（follow・refocus・fitAll）を出さず、列で切れる分だけずらす指示（shiftIntoView）を出す。出す・隠すの両方で同じ", (_name, from) => {
    const hide = reduceViewing(from, toggle("side"), tree("n1"));
    expect(hide.camera).toEqual({ type: "shiftIntoView" });
    const show = reduceViewing(hide.state, toggle("side"), tree("n1"));
    expect(show.camera).toEqual({ type: "shiftIntoView" });
    for (const c of [hide.camera, show.camera]) expect(["follow", "refocus", "fitAll"]).not.toContain(c.type);
  });

  it.each([
    ["自動", INITIAL_VIEWING, "follow"],
    ["manual", manual, "hold"],
    ["overview", overview, "hold"],
    ["diff", diff, "hold"],
  ] as const)("C は %s のとき、マップの大きさが変わらないので何もしない指示（%s の既定）。寄せ直す指示は出さない", (_name, from, cmd) => {
    const out = reduceViewing(from, toggle("captions"), tree("n1"));
    expect(out.camera).toEqual({ type: cmd });
    expect(["refocus", "fitAll", "shiftIntoView"]).not.toContain(out.camera.type);
  });

  it.each(["meta", "ctrl", "alt"] as const)("%s 付きの E は列を動かさないので、ずらす指示も寄せ直す指示も出さない", (mod) => {
    for (const [, from] of cameras) {
      const out = reduceViewing(from, toggle("side", { [mod]: true }), tree("n1"));
      expect(["follow", "hold"]).toContain(out.camera.type);
    }
  });

  it("入力の状態を書き換えない", () => {
    for (const type of ["side", "captions"] as const) {
      const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
      const out = reduceViewing(state, toggle(type), tree("n1"));
      expect(state).toEqual({ mode: "manual", topic: "n1" });
      expect(out.state).toEqual(hidden(manual, type));
      const frozenHidden: ViewingState = Object.freeze({ mode: "manual", topic: "n1", [FLAG[type]]: true });
      expect(reduceViewing(frozenHidden, toggle(type), tree("n1")).state).toEqual(manual);
      expect(frozenHidden).toEqual(hidden(manual, type));
    }
  });
});

// 矢印での選択用の木。深さ 2 の同じ段は y 順に A1(0) < A2(100) < B1(200) で、A1・A2 は A の子、B1 は B の子（親をまたぐ）。
// 子への移りは y の近さで決まる: root(150) の子は B(200) が A(0) より近く、A(80) の子は A2(100) が A1(0) より近い
const arrowTree = (currentTopic: string | undefined, over: Partial<VisibleTree> = {}): VisibleTree => ({
  ids: ["root", "A", "B", "A1", "A2", "B1"],
  targets: {
    root: { x: 0, y: 150 },
    A: { x: 200, y: 80 },
    B: { x: 200, y: 200 },
    A1: { x: 400, y: 0 },
    A2: { x: 400, y: 100 },
    B1: { x: 400, y: 200 },
  },
  parents: { root: null, A: "root", B: "root", A1: "A", A2: "A", B1: "B" },
  fold: null,
  changed: [],
  currentTopic,
  ...over,
});
const arrow = (dir: "left" | "right" | "up" | "down", mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({
  type: "arrow",
  dir,
  meta: false,
  ctrl: false,
  alt: false,
  ...mods,
});
const click = (id: string): ViewingEvent => ({ type: "select", id });
const selectionOf = (s: ViewingState) => s.selection;
// 選んだ状態を、カメラの状態を指定して作る（byKey は選び方）
const selected = (id: string, byKey: boolean, camera: ViewingState = INITIAL_VIEWING): ViewingState => ({ ...camera, selection: { id, byKey } });

describe("reduceViewing: 矢印の移り先（見せるノードの中で、目標の位置で測る）", () => {
  it.each([
    ["A2", "down", "B1"],
    ["B1", "up", "A2"],
    ["A1", "down", "A2"],
    ["A2", "up", "A1"],
    ["A", "down", "B"],
    ["B", "up", "A"],
  ] as const)("%s で %s を押すと同じ深さの %s へ（親をまたぐ）", (from, dir, to) => {
    const out = reduceViewing(selected(from, true), arrow(dir), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: to, byKey: true });
  });

  it.each([
    ["A1", "up"],
    ["B1", "down"],
    ["A", "up"],
    ["B", "down"],
  ] as const)("端の %s で %s を押しても動かない（回り込まない）", (from, dir) => {
    const out = reduceViewing(selected(from, true), arrow(dir), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: from, byKey: true });
  });

  it("同じ深さが 1 つだけのルートは、上下で動かない", () => {
    for (const dir of ["up", "down"] as const) {
      expect(selectionOf(reduceViewing(selected("root", true), arrow(dir), arrowTree("A")).state)?.id).toBe("root");
    }
  });

  it("→ は、子のうち目標の位置の y が今のノードに一番近い子へ（先頭の子ではない）", () => {
    expect(selectionOf(reduceViewing(selected("root", true), arrow("right"), arrowTree("A")).state)?.id).toBe("B"); // root(150): A は 150、B は 50
    expect(selectionOf(reduceViewing(selected("A", true), arrow("right"), arrowTree("A")).state)?.id).toBe("A2"); // A(80): A1 は 80、A2 は 20
    expect(selectionOf(reduceViewing(selected("B", true), arrow("right"), arrowTree("A")).state)?.id).toBe("B1");
  });

  it("→ は、見せるノードにない子（畳んだ中）には入らない。子が見えなければ動かない", () => {
    const t = arrowTree("A", { ids: ["root", "A", "B"] });
    expect(selectionOf(reduceViewing(selected("A", true), arrow("right"), t).state)?.id).toBe("A");
  });

  it("← は親へ。ルートでは動かない", () => {
    expect(selectionOf(reduceViewing(selected("A2", true), arrow("left"), arrowTree("A")).state)?.id).toBe("A");
    expect(selectionOf(reduceViewing(selected("A", true), arrow("left"), arrowTree("A")).state)?.id).toBe("root");
    expect(selectionOf(reduceViewing(selected("root", true), arrow("left"), arrowTree("A")).state)?.id).toBe("root");
  });

  it("端で動かないときも、キーで選んだこと（byKey）とカメラの停止は同じ", () => {
    const out = reduceViewing(selected("A1", false), arrow("up"), arrowTree("A"));
    expect(out.state).toEqual({ mode: "manual", topic: "A", selection: { id: "A1", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A1" });
  });
});

describe("reduceViewing: 選んでいないとき、または選んだノードが見えないときの矢印は、今の議題を選ぶだけ", () => {
  it.each(["left", "right", "up", "down"] as const)("未選択で %s を押すと、その向きには動かず今の議題を選ぶ", (dir) => {
    const out = reduceViewing(INITIAL_VIEWING, arrow(dir), arrowTree("A2"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
  });

  it("今の議題が無ければ、ルートを選ぶ", () => {
    for (const dir of ["left", "right", "up", "down"] as const) {
      expect(selectionOf(reduceViewing(INITIAL_VIEWING, arrow(dir), arrowTree(undefined)).state)).toEqual({ id: "root", byKey: true });
    }
  });

  it("今の議題が見せるノードに無いときも、ルートを選ぶ", () => {
    expect(selectionOf(reduceViewing(INITIAL_VIEWING, arrow("down"), arrowTree("gone")).state)?.id).toBe("root");
  });

  it("選んだノードが見せるノードに無い（消えた・畳んだ中）ときも、動かず今の議題を選ぶ", () => {
    const out = reduceViewing(selected("gone", false), arrow("right"), arrowTree("A2"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
    const hiddenChild = arrowTree("B", { ids: ["root", "A", "B", "B1"] });
    expect(selectionOf(reduceViewing(selected("A1", true), arrow("up"), hiddenChild).state)?.id).toBe("B");
  });

  it("ルートが今の議題でなく、選んだノードが見えないとき、ルートではなく今の議題を選ぶ", () => {
    expect(selectionOf(reduceViewing(selected("gone", true), arrow("left"), arrowTree("B1")).state)?.id).toBe("B1");
  });

  it("選べるノードが何もないときは、何も変えない", () => {
    const empty: VisibleTree = { ids: [], targets: {}, parents: {}, fold: null, changed: [], currentTopic: undefined };
    const out = reduceViewing(INITIAL_VIEWING, arrow("down"), empty);
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });
});

describe("reduceViewing: ⌘・Ctrl・Option 付きの矢印では何も変わらない", () => {
  for (const mod of ["meta", "ctrl", "alt"] as const) {
    it(`${mod} 付きの矢印は、選択もカメラも変えない（自動は follow、止めているときは hold）`, () => {
      const auto = selected("A1", true);
      const manual: ViewingState = { mode: "manual", topic: "A", selection: { id: "A1", byKey: true } };
      for (const dir of ["left", "right", "up", "down"] as const) {
        const a = reduceViewing(auto, arrow(dir, { [mod]: true }), arrowTree("A"));
        expect(a.state).toEqual(auto);
        expect(a.camera).toEqual({ type: "follow" });
        const m = reduceViewing(manual, arrow(dir, { [mod]: true }), arrowTree("A"));
        expect(m.state).toEqual(manual);
        expect(m.camera).toEqual({ type: "hold" });
      }
      const none = reduceViewing(INITIAL_VIEWING, arrow("down", { [mod]: true }), arrowTree("A"));
      expect(none.state).toEqual({ mode: "auto" });
    });
  }
});

describe("reduceViewing: キーで選ぶとカメラが止まり、クリックで選んでも止まらない", () => {
  it("自動のときの矢印は、人の状態（今の議題を覚える）に移り、選んだノードを画面に入れる指示を出す", () => {
    const out = reduceViewing(INITIAL_VIEWING, arrow("down"), arrowTree("A2"));
    expect(out.state).toEqual({ mode: "manual", topic: "A2", selection: { id: "A2", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
  });

  it("止めているときの矢印は、止めたまま。覚える議題は今の議題に更新する", () => {
    const from: ViewingState = { mode: "manual", topic: "A", selection: { id: "A1", byKey: true } };
    const out = reduceViewing(from, arrow("down"), arrowTree("B"));
    expect(out.state).toEqual({ mode: "manual", topic: "B", selection: { id: "A2", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
  });

  it("全体を見ている間の矢印も、人の状態に移る（全体を見る前の状態は捨てる）", () => {
    const from: ViewingState = { mode: "overview", topic: "A", selection: { id: "A1", byKey: false } };
    const out = reduceViewing(from, arrow("down"), arrowTree("A"));
    expect(out.state).toEqual({ mode: "manual", topic: "A", selection: { id: "A2", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
    expect("before" in out.state).toBe(false);
  });

  it.each([
    ["自動", INITIAL_VIEWING, { type: "follow" }],
    ["manual", { mode: "manual", topic: "A" }, { type: "hold" }],
    ["overview", { mode: "overview", topic: "A" }, { type: "hold" }],
  ] as const)("クリックで選ぶと、%s のカメラの状態を変えず、指示は今までどおり（動かさない）", (_name, camera, expected) => {
    const out = reduceViewing(camera as ViewingState, click("A1"), arrowTree("A"));
    expect(out.state).toEqual({ ...camera, selection: { id: "A1", byKey: false } });
    expect(out.camera).toEqual(expected);
  });

  it("クリックで選び直すと、キーで選んだ印（byKey）は外れ、選び直した ID になる", () => {
    const out = reduceViewing(selected("A1", true, { mode: "manual", topic: "A" }), click("B"), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: "B", byKey: false });
  });

  it("クリックで選んだノードから、矢印で続けられる（クリックのあとの矢印は選んだノードから動く）", () => {
    const { state, commands } = run([[click("A1"), arrowTree("A")], [arrow("down"), arrowTree("A")]]);
    expect(selectionOf(state)).toEqual({ id: "A2", byKey: true });
    expect(state.mode).toBe("manual");
    expect(commands).toEqual([{ type: "follow" }, { type: "revealNode", id: "A2" }]);
  });

  it("キーで選んで止めたあと、クリックで選んでも止まったまま（クリックで自動に戻らない）", () => {
    const { state } = run([[arrow("down"), arrowTree("A")], [click("B"), arrowTree("A")]]);
    expect(state).toEqual({ mode: "manual", topic: "A", selection: { id: "B", byKey: false } });
  });
});

describe("reduceViewing: 選択は右の列の出し入れに触らない", () => {
  it("右の列を隠していても、クリックでもキーでも隠したまま（列を出さない）", () => {
    const hidden: ViewingState = { mode: "auto", sideHidden: true };
    expect(reduceViewing(hidden, click("A1"), arrowTree("A")).state).toEqual({ ...hidden, selection: { id: "A1", byKey: false } });
    expect(reduceViewing(hidden, arrow("down"), arrowTree("A")).state).toEqual({ mode: "manual", topic: "A", sideHidden: true, selection: { id: "A", byKey: true } });
  });

  it("E で出し入れしても、選択は残る", () => {
    const side: ViewingEvent = { type: "side", meta: false, ctrl: false, alt: false };
    const sel = selected("A1", true, { mode: "manual", topic: "A" });
    const hide = reduceViewing(sel, side, arrowTree("A"));
    expect(hide.state).toEqual({ ...sel, sideHidden: true });
    expect(reduceViewing(hide.state, side, arrowTree("A")).state).toEqual(sel);
  });

  it("C と ? でも、選択は残る", () => {
    const sel = selected("A1", true, { mode: "manual", topic: "A" });
    const captions = reduceViewing(sel, { type: "captions", meta: false, ctrl: false, alt: false }, arrowTree("A")).state;
    expect(captions).toEqual({ ...sel, captionsHidden: true });
    const help = reduceViewing(sel, { type: "keyList", meta: false, ctrl: false, alt: false }, arrowTree("A")).state;
    expect(help).toEqual({ ...sel, keyList: true });
    expect(reduceViewing(help, { type: "keyList", meta: false, ctrl: false, alt: false }, arrowTree("A")).state).toEqual(sel);
  });
});

describe("reduceViewing: 選択は他の出来事では外れず、今の議題が変わって自動に戻っても残る", () => {
  const sel = selected("A1", true, { mode: "manual", topic: "A" });

  it("今の議題が変わる反映で自動に戻り（refocus）、選択は残る", () => {
    const { state, commands } = run([[reflect, arrowTree("B")]], sel);
    expect(state).toEqual({ mode: "auto", selection: { id: "A1", byKey: true } });
    expect(commands).toEqual([{ type: "refocus" }]);
  });

  it("同じ状態の上で、矢印 → 議題が変わる反映（自動に戻る）→ 次の矢印、と続けても、選択から続きカメラは選んだノードへ戻る", () => {
    const { state, commands } = run([
      [arrow("down"), arrowTree("A")], // 今の議題 A を選ぶ（manual, topic A）
      [arrow("right"), arrowTree("A")], // A → A2
      [reflect, arrowTree("B")], // 議題が B に変わり自動に戻る。選択 A2 は残る
      [arrow("down"), arrowTree("B")], // A2 → B1。画面の外なら寄せるのは revealNode
    ]);
    expect(commands).toEqual([
      { type: "revealNode", id: "A" },
      { type: "revealNode", id: "A2" },
      { type: "refocus" },
      { type: "revealNode", id: "B1" },
    ]);
    expect(state).toEqual({ mode: "manual", topic: "B", selection: { id: "B1", byKey: true } });
  });

  it("自動に戻った直後の矢印は、今の議題ではなく選んだノードから動く", () => {
    const back = run([[reflect, arrowTree("B")]], sel).state;
    const out = reduceViewing(back, arrow("down"), arrowTree("B"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });
    expect(out.state.mode).toBe("manual");
  });

  it("同じ議題の反映・人の操作・縁の点でも選択は残る", () => {
    expect(selectionOf(reduceViewing(sel, reflect, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    expect(selectionOf(reduceViewing(sel, moved, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    const dot = reduceViewing(sel, { type: "edgeDot", id: "B" }, arrowTree("A")).state;
    expect(selectionOf(dot)).toEqual({ id: "A1", byKey: true });
    expect(dot.mode).toBe("manual");
  });

  it("キー（倍率・Shift+矢印の移動）でも選択は残る", () => {
    for (const k of ["=", "-", "0", "Shift+ArrowLeft", "Shift+ArrowDown"] as const) {
      expect(selectionOf(reduceViewing(sel, key(k), arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    }
  });

  it("F で全体を見て、もう一度 F で差分を見る状態に入っても選択は残る。変化が無くて自動に戻っても残る", () => {
    const changedTree = arrowTree("A", { changed: ["B"] });
    const overview = reduceViewing(sel, key("F"), changedTree).state;
    expect(overview).toEqual({ mode: "overview", topic: "A", selection: { id: "A1", byKey: true } });
    expect(reduceViewing(overview, key("F"), changedTree).state).toEqual({ mode: "diff", topic: "A", selection: { id: "A1", byKey: true } });
    const fromAuto = reduceViewing(selected("A1", false), key("F"), arrowTree("A")).state;
    expect(fromAuto).toEqual({ mode: "overview", topic: "A", selection: { id: "A1", byKey: false } });
    expect(reduceViewing(fromAuto, key("F"), arrowTree("A")).state).toEqual(selected("A1", false));
  });

  it("全体を見ている間の反映でも選択は残る", () => {
    const overview = reduceViewing(sel, key("F"), arrowTree("A")).state;
    expect(selectionOf(reduceViewing(overview, reflect, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    expect(selectionOf(reduceViewing(overview, reflect, arrowTree("B")).state)).toEqual({ id: "A1", byKey: true });
  });

  it("見返しの idle・timeMoved で自動に戻っても、選択は残る", () => {
    const idleBack = reduceViewing(sel, { type: "idle" }, arrowTree("A"), "review");
    expect(idleBack.state).toEqual({ mode: "auto", selection: { id: "A1", byKey: true } });
    expect(idleBack.camera).toEqual({ type: "refocus" });
    const moveBack = reduceViewing(sel, { type: "timeMoved" }, arrowTree("A"), "review");
    expect(moveBack.state).toEqual({ mode: "auto", selection: { id: "A1", byKey: true } });
    const overview = reduceViewing(sel, key("F"), arrowTree("A")).state;
    expect(reduceViewing(overview, { type: "timeMoved" }, arrowTree("A"), "review").state).toEqual({ mode: "auto", selection: { id: "A1", byKey: true } });
  });

  it("選んでいないときは selection のフィールドを置かない（全ての出来事で）", () => {
    for (const event of [reflect, moved, plainEscape, key("="), { type: "idle" } as ViewingEvent]) {
      expect("selection" in reduceViewing(INITIAL_VIEWING, event, arrowTree("A")).state).toBe(false);
    }
  });
});

describe("reduceViewing: 選択は Esc でだけ外れる", () => {
  it.each([
    ["自動", selected("A1", false)],
    ["manual", selected("A1", true, { mode: "manual", topic: "A" })],
    ["overview", selected("A1", true, { mode: "overview", topic: "A" })],
  ] as const)("%s のとき、修飾なしの Esc で選択が外れる", (_name, from) => {
    const out = reduceViewing(from, plainEscape, arrowTree("A"));
    expect("selection" in out.state).toBe(false);
    expect(out.state).toEqual({ mode: "auto" });
  });

  it("自動のときの Esc は、選択だけを外し、カメラは今までどおり（follow）", () => {
    const out = reduceViewing(selected("A1", false), plainEscape, arrowTree("A"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });

  it("止めているときの Esc は、自動に戻して寄せ直し（refocus）、選択も外す", () => {
    const out = reduceViewing(selected("A1", true, { mode: "manual", topic: "A" }), plainEscape, arrowTree("A"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("キー一覧が開いているときの Esc は、一覧を閉じるだけで選択は残る。次の Esc で外れる", () => {
    const opened: ViewingState = { mode: "manual", topic: "A", keyList: true, selection: { id: "A1", byKey: true } };
    const closed = reduceViewing(opened, plainEscape, arrowTree("A"));
    expect(closed.state).toEqual({ mode: "manual", topic: "A", selection: { id: "A1", byKey: true } });
    expect(reduceViewing(closed.state, plainEscape, arrowTree("A")).state).toEqual({ mode: "auto" });
  });

  it.each(["meta", "ctrl", "alt"] as const)("%s 付きの Esc では選択が残る", (mod) => {
    const from = selected("A1", true, { mode: "manual", topic: "A" });
    expect(reduceViewing(from, { ...plainEscape, [mod]: true }, arrowTree("A")).state).toEqual(from);
    const auto = selected("A1", false);
    expect(reduceViewing(auto, { ...plainEscape, [mod]: true }, arrowTree("A")).state).toEqual(auto);
  });

  it("Esc で外したあとの矢印は、未選択と同じく今の議題を選ぶだけ", () => {
    const { state } = run([[arrow("down"), arrowTree("A")], [arrow("down"), arrowTree("A")], [plainEscape, arrowTree("A")], [arrow("down"), arrowTree("A2")]]);
    expect(selectionOf(state)).toEqual({ id: "A2", byKey: true });
  });

  it("Esc で右の列の出し入れや字幕は変わらない", () => {
    const from: ViewingState = { mode: "manual", topic: "A", sideHidden: true, captionsHidden: true, selection: { id: "A1", byKey: true } };
    expect(reduceViewing(from, plainEscape, arrowTree("A")).state).toEqual({ mode: "auto", sideHidden: true, captionsHidden: true });
  });
});

describe("reduceViewing: 選択でも入力を書き換えない", () => {
  it("select・arrow・escape は、入力の状態と木を書き換えず、新しいオブジェクトを返す", () => {
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "A", selection: Object.freeze({ id: "A1", byKey: true }) });
    const t = arrowTree("A");
    const before = JSON.stringify(t);
    for (const event of [click("B"), arrow("down"), arrow("right"), plainEscape]) {
      reduceViewing(state, event, t);
    }
    expect(state).toEqual({ mode: "manual", topic: "A", selection: { id: "A1", byKey: true } });
    expect(JSON.stringify(t)).toBe(before);
  });
});

// ---- #319: 選択と畳む見せ方のつなぎ ----

const fnode = (id: string, parent: string | null, kind: SnapshotNode["kind"], evidence: string[], extra: Partial<SnapshotNode> = {}): SnapshotNode => ({
  id,
  parent,
  kind,
  text: id,
  evidence,
  ...extra,
});
const fsnap = (nodes: SnapshotNode[], round: number, currentTopic?: string): Snapshot => ({
  nodes,
  round,
  changes: [],
  remarks: [],
  now: 10,
  ...(currentTopic !== undefined ? { currentTopic } : {}),
});
const finished = { talkStatus: "済み" } as const;
const froot = fnode("root", null, "会議", []);

// 本番と同じく、畳む見せ方の結果から見えている木を組み立てる
const visibleOf = (
  snapshot: Snapshot,
  selectedId: string | null,
  human: HumanFolds | undefined = undefined,
): VisibleTree => {
  const view = foldView(snapshot, human, selectedId);
  const shown = view.nodes;
  return {
    ids: shown.map((n) => n.id),
    targets: Object.fromEntries(shown.map((n, i) => [n.id, { x: n.parent === null ? 0 : 200, y: i * 50 }])),
    parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
    fold: view,
    changed: [],
    currentTopic: snapshot.currentTopic,
  };
};

describe("reduceViewing: Esc で選択を外した直後は、普段どおりに畳まれる", () => {
  // 済みの議題 A の下の論点 A1 を選んでいる間は A は開き、Esc で外れた次の描画で畳まれる
  const snapshot = fsnap([froot, fnode("A", "root", "議題", ["r1"], finished), fnode("A1", "A", "論点", ["r1"]), fnode("B", "root", "議題", ["r1"])], 4, "B");
  const sel = selected("A1", true, { mode: "manual", topic: "B" });

  it("選んでいる間は祖先 A が開いて A1 が見え、Esc の出力の selection（無い）を渡すと A1 は畳まれて見えない", () => {
    expect(foldView(snapshot, undefined, sel.selection?.id ?? null).nodes.map((n) => n.id)).toEqual(["root", "A", "A1", "B"]);
    const out = reduceViewing(sel, plainEscape, visibleOf(snapshot, "A1"));
    expect(out.state.selection).toBeUndefined();
    expect(foldView(snapshot, undefined, out.state.selection?.id ?? null).nodes.map((n) => n.id)).toEqual(["root", "A", "B"]);
  });

  it("修飾つきの Esc では選択が残るので、畳み方も変わらない", () => {
    const out = reduceViewing(sel, { ...plainEscape, meta: true } as ViewingEvent, visibleOf(snapshot, "A1"));
    expect(foldView(snapshot, undefined, out.state.selection?.id ?? null).nodes.map((n) => n.id)).toEqual(["root", "A", "A1", "B"]);
  });
});

describe("reduceViewing: 畳んだ議題・「議題 N 件」では → で中へ入らない", () => {
  const nodes = [
    froot,
    fnode("A", "root", "議題", ["r1"], finished),
    fnode("A1", "A", "論点", ["r1"]),
    fnode("B", "root", "議題", ["r1"], finished),
    fnode("B1", "B", "論点", ["r1"]),
    fnode("C", "root", "議題", ["r1"]),
    fnode("C1", "C", "論点", ["r1"], finished),
    fnode("C1a", "C1", "決定", ["r1"]),
  ];
  const snapshot = fsnap(nodes, 4, "C");

  it("「議題 N 件」（run:A）を選んで → を押しても、同じ run:A のまま（中身は見せるノードに無い）", () => {
    const t = visibleOf(snapshot, "run:A");
    expect(t.ids).toEqual(["root", "run:A", "C", "C1"]);
    const out = reduceViewing(selected("run:A", true), arrow("right"), t);
    expect(selectionOf(out.state)).toEqual({ id: "run:A", byKey: true });
  });

  it("畳んだ議題（まとめに入らない単独のもの）を選んで → を押しても、同じ議題のまま", () => {
    const single = fsnap([froot, fnode("A", "root", "議題", ["r1"], finished), fnode("A1", "A", "論点", ["r1"]), fnode("C", "root", "議題", ["r1"])], 4, "C");
    const t = visibleOf(single, "A");
    expect(t.ids).toEqual(["root", "A", "C"]);
    expect(selectionOf(reduceViewing(selected("A", true), arrow("right"), t).state)).toEqual({ id: "A", byKey: true });
  });

  it("畳んだ論点を選んで → を押しても動かない", () => {
    const t = visibleOf(snapshot, "C1");
    expect(t.ids).toContain("C1");
    expect(t.ids).not.toContain("C1a");
    expect(selectionOf(reduceViewing(selected("C1", true), arrow("right"), t).state)).toEqual({ id: "C1", byKey: true });
  });

  it("「議題 N 件」へは、同じ深さの矢印（↑）で選べる", () => {
    const t = visibleOf(snapshot, null);
    expect(selectionOf(reduceViewing(selected("C", true), arrow("up"), t).state)).toEqual({ id: "run:A", byKey: true });
  });
});

describe("reduceViewing: 選んだノードが統合・削除・時刻の巻き戻しで消えたら、選択を移す", () => {
  const before = fsnap(
    [
      froot,
      fnode("A", "root", "議題", ["r1"]),
      fnode("P1", "A", "論点", ["r1"]),
      fnode("P2", "A", "論点", ["r2"]),
      fnode("X", "P2", "案", ["r2"]),
    ],
    4,
    "A",
  );
  const merged: Snapshot = {
    ...fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1", "r2"]), fnode("X", "P1", "案", ["r2"])], 5, "A"),
    changes: [{ change: "統合", node: "P1", kind: "論点", text: "P1", from: ["P2"], round: 5, at: 10 }],
  };
  const deleted = fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1"])], 5, "A");

  const reflectFrom = (b: Snapshot, a: Snapshot, state: ViewingState, scope: "live" | "review" = "live") => {
    const replaced = relocations({ tree: visibleOf(b, null), snapshot: b, selectedId: state.selection?.id ?? null }, { tree: visibleOf(a, null), snapshot: a });
    return reduceViewing(state, { type: "reflect", replaced }, visibleOf(a, null), scope);
  };

  // 今の議題は B。人の畳み（A）で選択ノード P2 が前の木から隠れた状態で、反映が起きる。選択は移り先へ移り、根拠欄も移り先を出す
  const withB = (nodes: SnapshotNode[], round: number, changes: Snapshot["changes"] = []): Snapshot => ({ ...fsnap([...nodes, fnode("B", "root", "議題", ["r3"])], round, "B"), changes });
  const reflectHidden = (b: Snapshot, a: Snapshot) => {
    const humanFolds = foldingActions(b, [{ type: "toggle", id: "A" }]).human;
    const state: ViewingState = { mode: "manual", topic: "B", humanFolds, selection: { id: "P2", byKey: true } };
    const prevTree = visibleOf(b, "P2", humanFolds);
    expect(prevTree.ids).not.toContain("P2");
    const replaced = relocations({ tree: prevTree, snapshot: b, selectedId: "P2" }, { tree: visibleOf(a, "P2", humanFolds), snapshot: a });
    const out = reduceViewing(state, { type: "reflect", replaced }, visibleOf(a, "P2", humanFolds));
    return { out, evidence: evidenceOf(a, out.state.selection?.id ?? "", humanFolds) };
  };
  const hiddenBefore = withB(before.nodes, 4);

  it("人の畳みで隠れた選択ノードが削除されたら、残る祖先 A へ移り、根拠欄も A を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(deleted.nodes, 5));
    expect(out.state.selection).toEqual({ id: "A", byKey: true });
    expect(evidence?.node.id).toBe("A");
  });

  it("人の畳みで隠れた選択ノードが統合されたら、統合先 P1 へ移り、根拠欄も P1 を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(merged.nodes, 5, merged.changes));
    expect(out.state.selection).toEqual({ id: "P1", byKey: true });
    expect(evidence?.node.id).toBe("P1");
  });

  it("人の畳みで隠れた選択ノードが、巻き戻しで無い時点になったら、統合先ではなく祖先 A へ移り、根拠欄も A を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(merged.nodes, 3, merged.changes));
    expect(out.state.selection).toEqual({ id: "A", byKey: true });
    expect(evidence?.node.id).toBe("A");
  });

  it("統合されたら、残った統合先のノードへ移る。byKey とカメラの状態・指示は変わらない", () => {
    for (const byKey of [true, false]) {
      const state = selected("P2", byKey, { mode: "manual", topic: "A" });
      const out = reflectFrom(before, merged, state);
      const plain = reduceViewing(state, reflect, visibleOf(merged, null));
      expect(out.state).toEqual({ mode: "manual", topic: "A", selection: { id: "P1", byKey } });
      expect(out.camera).toEqual(plain.camera);
    }
  });

  it("削除されたら、親へ移る。子もまとめて消えたノードを選んでいても、残っている親へ", () => {
    expect(reflectFrom(before, deleted, selected("P2", true, { mode: "manual", topic: "A" })).state.selection).toEqual({ id: "A", byKey: true });
    expect(reflectFrom(before, deleted, selected("X", false, { mode: "manual", topic: "A" })).state.selection).toEqual({ id: "A", byKey: false });
  });

  it("自動のカメラのときも、移すのは選択だけ（follow のまま、モードは自動）", () => {
    const out = reflectFrom(before, deleted, selected("P2", true));
    expect(out.state).toEqual({ mode: "auto", selection: { id: "A", byKey: true } });
    expect(out.camera).toEqual({ type: "follow" });
  });

  it("全体を見ている間も、カメラの状態は変えず選択だけ移る", () => {
    const overview: ViewingState = { mode: "overview", topic: "A", selection: { id: "P2", byKey: true } };
    const out = reflectFrom(before, deleted, overview);
    expect(out.state).toEqual({ ...overview, selection: { id: "A", byKey: true } });
    expect(out.camera).toEqual({ type: "fitAll" });
  });

  it("消えていないノードを選んでいるときは、ほかのノードが消えても選択はそのまま", () => {
    const state = selected("P1", true, { mode: "manual", topic: "A" });
    expect(reflectFrom(before, deleted, state).state).toEqual(state);
  });

  it("選択が無いときは、ノードが消えても選択は付かない", () => {
    const out = reflectFrom(before, deleted, { mode: "manual", topic: "A" });
    expect(out.state).toEqual({ mode: "manual", topic: "A" });
  });

  it("移した後は、キー一覧などほかの重ねる状態も残る", () => {
    const state: ViewingState = { mode: "manual", topic: "A", keyList: true, sideHidden: true, selection: { id: "P2", byKey: true } };
    expect(reflectFrom(before, deleted, state).state).toEqual({ ...state, selection: { id: "A", byKey: true } });
  });

  it("見返しで時刻を戻して選んだノードがまだ無い時点になったら、その時点にある、いちばん近い祖先へ移る", () => {
    const later = fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1"]), fnode("P3", "A", "論点", ["r3"]), fnode("Y", "P3", "案", ["r3"])], 5, "A");
    const earlier = fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1", "r3"])], 3, "A");
    const state = selected("Y", true, { mode: "manual", topic: "A" });
    const out = reflectFrom(later, earlier, state, "review");
    expect(out.state).toEqual({ mode: "manual", topic: "A", selection: { id: "A", byKey: true } });
    expect(out.camera).toEqual(reduceViewing(state, reflect, visibleOf(earlier, null), "review").camera);
  });

  it("移り先を求める入力（replaced）を書き換えない", () => {
    const replaced = Object.freeze({ P2: "P1" });
    const state = Object.freeze({ mode: "manual", topic: "A", selection: Object.freeze({ id: "P2", byKey: true }) }) as ViewingState;
    const out = reduceViewing(state, { type: "reflect", replaced }, arrowTree("A"));
    expect(out.state).not.toBe(state);
    expect(state.selection).toEqual({ id: "P2", byKey: true });
    expect(replaced).toEqual({ P2: "P1" });
  });
});

describe("reduceViewing: Z で選んだノードと子孫が収まるまで寄る", () => {
  const z = (mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}) => key("Z", mods);

  it("選んでいるとき: 人の操作として止まり（今の議題を覚える）、そのノードの部分木へ寄る指示を出す。選択は変えない", () => {
    for (const byKey of [true, false]) {
      const out = reduceViewing(selected("A", byKey), z(), arrowTree("B"));
      expect(out.state).toEqual({ mode: "manual", topic: "B", selection: { id: "A", byKey } });
      expect(out.camera).toEqual({ type: "fitSubtree", id: "A" });
    }
  });

  it("止まっているとき・全体を見ているときも、manual（今の議題）に移る。重ねる状態は残る", () => {
    const manual = reduceViewing({ mode: "manual", topic: "A", keyList: true, selection: { id: "A2", byKey: true } }, z(), arrowTree("B"));
    expect(manual.state).toEqual({ mode: "manual", topic: "B", keyList: true, selection: { id: "A2", byKey: true } });
    expect(manual.camera).toEqual({ type: "fitSubtree", id: "A2" });
    const overview = reduceViewing({ mode: "overview", topic: "A", sideHidden: true, selection: { id: "A", byKey: false } }, z(), arrowTree("B"));
    expect(overview.state).toEqual({ mode: "manual", topic: "B", sideHidden: true, selection: { id: "A", byKey: false } });
    expect(overview.camera).toEqual({ type: "fitSubtree", id: "A" });
  });

  it("「議題 N 件」を選んでいても寄れる", () => {
    const t = arrowTree("A", { ids: ["root", "run:B", "A"], parents: { root: null, "run:B": "root", A: "root" }, targets: { root: { x: 0, y: 0 }, "run:B": { x: 200, y: 0 }, A: { x: 200, y: 50 } } });
    expect(reduceViewing(selected("run:B", true), z(), t).camera).toEqual({ type: "fitSubtree", id: "run:B" });
  });

  it("何も選んでいないときは、状態もカメラも変えない（自動なら follow、止まっているなら hold）", () => {
    const auto = reduceViewing(INITIAL_VIEWING, z(), arrowTree("A"));
    expect(auto).toEqual({ state: INITIAL_VIEWING, camera: { type: "follow" } });
    const manual: ViewingState = { mode: "manual", topic: "A", keyList: true };
    expect(reduceViewing(manual, z(), arrowTree("A"))).toEqual({ state: manual, camera: { type: "hold" } });
    const overview: ViewingState = { mode: "overview", topic: "A" };
    expect(reduceViewing(overview, z(), arrowTree("A"))).toEqual({ state: overview, camera: { type: "hold" } });
  });

  it("選んだノードが見せるノードに無いときは、何もしない", () => {
    const manual: ViewingState = { mode: "manual", topic: "A", selection: { id: "gone", byKey: true } };
    expect(reduceViewing(manual, z(), arrowTree("A"))).toEqual({ state: manual, camera: { type: "hold" } });
  });

  it.each([{ meta: true }, { ctrl: true }, { alt: true }])("修飾キー %o つきの Z は無視する", (mods) => {
    const sel = selected("A", true);
    expect(reduceViewing(sel, z(mods), arrowTree("A"))).toEqual({ state: sel, camera: { type: "follow" } });
    const manual = selected("A", true, { mode: "manual", topic: "A" });
    expect(reduceViewing(manual, z(mods), arrowTree("A"))).toEqual({ state: manual, camera: { type: "hold" } });
  });

  it("Z の後に Esc で、選択が外れ自動に戻る（同じ状態の続き）", () => {
    const { state, commands } = run([[arrow("down"), arrowTree("A")], [z(), arrowTree("A")], [plainEscape, arrowTree("A")]]);
    expect(commands.map((c) => c.type)).toEqual(["revealNode", "fitSubtree", "refocus"]);
    expect(state).toEqual({ mode: "auto" });
  });

  it("入力の状態と木を書き換えない", () => {
    const state: ViewingState = Object.freeze({ mode: "auto", selection: Object.freeze({ id: "A", byKey: true }) });
    const t = arrowTree("A");
    const before = JSON.stringify(t);
    const out = reduceViewing(state, z(), t);
    expect(out.state).not.toBe(state);
    expect(state).toEqual({ mode: "auto", selection: { id: "A", byKey: true } });
    expect(JSON.stringify(t)).toBe(before);
  });
});

const hnodes = [froot, fnode("A", "root", "議題", ["r1"], finished), fnode("A1", "A", "論点", ["r1"]), fnode("B", "root", "議題", ["r1"]), fnode("C", "root", "議題", ["r1"]), fnode("C1", "C", "論点", ["r1"])];
const curB = fsnap(hnodes, 4, "B");
const runsSnap = fsnap([froot, fnode("A", "root", "議題", ["r1"], finished), fnode("D", "root", "議題", ["r1"], finished), fnode("B", "root", "議題", ["r1"])], 4, "B");
const enter = (mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type: "enter", meta: false, ctrl: false, alt: false, ...mods });
const press = (state: ViewingState, event: ViewingEvent, snapshot: Snapshot = curB) => reduceViewing(state, event, visibleOf(snapshot, state.selection?.id ?? null, state.humanFolds));
const cameraAndSelection = (state: ViewingState) => {
  const { humanFolds: _human, ...rest } = state;
  return rest;
};

describe("reduceViewing: 開閉の結果を選択とカメラへ反映する", () => {
  it.each([true, false])("子孫を畳んだ議題へ選択を移し、byKey=%s を保つ", (byKey) => {
    const out = press(selected("C1", byKey, { mode: "manual", topic: "B" }), { type: "foldDot", id: "C" });
    expect(out.state.selection).toEqual({ id: "C", byKey });
    expect(out.camera).toEqual({ type: "keepNode", id: "C" });
  });

  it("Enter は選択の byKey を変えず、自動のカメラは refocus を返す", () => {
    const out = press(selected("A", false), enter());
    expect(cameraAndSelection(out.state)).toEqual({ mode: "auto", selection: { id: "A", byKey: false } });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it.each(["manual", "overview", "diff"] as const)("%s での開閉はモードと議題を保ち keepNode を返す", (mode) => {
    const out = press({ mode, topic: "B", sideHidden: true, selection: { id: "A", byKey: true } }, enter());
    expect(cameraAndSelection(out.state)).toEqual({ mode, topic: "B", sideHidden: true, selection: { id: "A", byKey: true } });
    expect(out.camera).toEqual({ type: "keepNode", id: "A" });
  });

  it("丸で別の枝を開いても選択を変えず、選択なしの丸でも選択を付けない", () => {
    expect(press(selected("B", true), { type: "foldDot", id: "A" }).state.selection).toEqual({ id: "B", byKey: true });
    expect(press(INITIAL_VIEWING, { type: "foldDot", id: "A" }).state.selection).toBeUndefined();
  });

  it("修飾付き Enter と選択なしの Enter は idle と同じ", () => {
    for (const mods of [{ meta: true }, { ctrl: true }, { alt: true }]) {
      const from = selected("A", true);
      expect(press(from, enter(mods))).toEqual(press(from, { type: "idle" }));
    }
    expect(press(INITIAL_VIEWING, enter())).toEqual(press(INITIAL_VIEWING, { type: "idle" }));
  });

  it("効かない丸と fold のない木では選択とカメラを変えない", () => {
    for (const id of ["B", "root", "A1", "gone"]) expect(press(INITIAL_VIEWING, { type: "foldDot", id })).toEqual(press(INITIAL_VIEWING, { type: "idle" }));
    expect(reduceViewing(selected("A", true), enter(), { ...visibleOf(curB, "A"), fold: null })).toEqual({ state: selected("A", true), camera: { type: "follow" } });
  });

  it.each([true, false])("まとめを解くと先頭へ選択を移し、byKey=%s を保つ", (byKey) => {
    const out = press(selected("run:A", byKey), enter(), runsSnap);
    expect(out.state.selection).toEqual({ id: "A", byKey });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("選択なしでまとめの丸を押すと先頭を選び、手動のカメラはまとめの位置を保つ", () => {
    const out = press({ mode: "manual", topic: "B" }, { type: "foldDot", id: "run:A" }, runsSnap);
    expect(out.state.selection).toEqual({ id: "A", byKey: false });
    expect(out.camera).toEqual({ type: "keepNode", id: "run:A" });
  });

  it("pointChange は id だけで、対象を選び manual と focusNode を返す", () => {
    for (const mode of ["auto", "manual", "overview", "diff"] as const) {
      const from: ViewingState = mode === "auto" ? { mode } : { mode, topic: "B" };
      const out = press({ ...from, sideHidden: true }, { type: "pointChange", id: "A" });
      expect(cameraAndSelection(out.state)).toEqual({ mode: "manual", topic: "B", sideHidden: true, selection: { id: "A", byKey: false } });
      expect(out.camera).toEqual({ type: "focusNode", id: "A" });
    }
  });

  it("存在しない ID の pointChange は select と同じ選択・カメラになる", () => {
    for (const from of [INITIAL_VIEWING, { mode: "manual", topic: "B" } satisfies ViewingState]) {
      const pointed = press(from, { type: "pointChange", id: "gone" });
      const selected = press(from, { type: "select", id: "gone" });
      expect(pointed.state).toEqual(selected.state);
      expect(pointed.camera).toEqual(selected.camera);
    }
  });

  it("reflect は選択の付け替えとカメラのモードを保つ", () => {
    const humanFolds = foldingActions(curB, [{ type: "toggle", id: "C" }]).human;
    const from: ViewingState = { mode: "manual", topic: "B", humanFolds, selection: { id: "old", byKey: true } };
    const next = { ...curB, currentTopic: "C" };
    const out = press(from, { type: "reflect", replaced: { old: "C" } }, next);
    expect(cameraAndSelection(out.state)).toEqual({ mode: "auto", selection: { id: "C", byKey: true } });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("Esc は人の欄と選択を落とし、キー一覧が開いていれば先に一覧だけ閉じる", () => {
    const humanFolds = foldingActions(runsSnap, [{ type: "toggle", id: "run:A" }]).human;
    const from: ViewingState = { mode: "manual", topic: "B", humanFolds, sideHidden: true, selection: { id: "A", byKey: true } };
    const out = press(from, plainEscape, runsSnap);
    expect(out.state).toEqual({ mode: "auto", sideHidden: true });
    expect(out.camera).toEqual({ type: "refocus" });
    expect(press({ ...from, keyList: true }, plainEscape, runsSnap).state).toEqual(from);
    for (const mods of [{ meta: true }, { ctrl: true }, { alt: true }]) expect(press(from, { ...plainEscape, ...mods }, runsSnap).state).toEqual(from);
  });

  it("他の出来事を連続しても、人の開閉による表示を保つ", () => {
    const humanFolds = foldingActions(curB, [{ type: "toggle", id: "A" }, { type: "toggle", id: "C" }]).human;
    let state: ViewingState = { mode: "auto", humanFolds };
    const events: ViewingEvent[] = [{ type: "idle" }, { type: "userMoved" }, key("="), key("F"), key("F"), { type: "side", meta: false, ctrl: false, alt: false }, { type: "captions", meta: false, ctrl: false, alt: false }, { type: "keyList", meta: false, ctrl: false, alt: false }, arrow("down"), { type: "edgeDot", id: "B" }, { type: "select", id: "B" }, { type: "timeMoved" }, { type: "deselect" }];
    for (const event of events) {
      state = press(state, event).state;
      expect(foldView(curB, state.humanFolds, null).nodes.map((n) => n.id)).toEqual(["root", "A", "A1", "B", "C"]);
    }
  });

  it("開閉・point・Esc・reflect は入力の状態・木・出来事を変更しない", () => {
    const humanFolds = foldingActions(curB, [{ type: "toggle", id: "A" }]).human;
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "B", humanFolds, selection: { id: "A1", byKey: true } });
    const t = visibleOf(curB, "A1", humanFolds);
    const before = structuredClone({ state, t });
    for (const event of [enter(), { type: "foldDot", id: "A" }, { type: "pointChange", id: "C" }, plainEscape, reflect] satisfies ViewingEvent[]) {
      const input = structuredClone(event);
      reduceViewing(state, event, t);
      expect(event).toEqual(input);
    }
    expect({ state, t }).toEqual(before);
    expect(foldView(curB, humanFolds, "A1")).toEqual(t.fold);
  });
});

describe("reduceViewing: deselect は選択だけを外す", () => {
  it.each(["auto", "manual", "overview"] as const)("%s のモードと重ねる状態を保ち、カメラを動かさない", (mode) => {
    const humanFolds = foldingActions(curB, [{ type: "toggle", id: "A" }]).human;
    const camera: ViewingState = mode === "auto" ? { mode } : { mode, topic: "B" };
    const from: ViewingState = { ...camera, humanFolds, sideHidden: true, captionsHidden: true, keyList: true, selection: { id: "A1", byKey: true } };
    const out = press(from, { type: "deselect" });
    expect(cameraAndSelection(out.state)).toEqual({ mode, ...(mode === "auto" ? {} : { topic: "B" }), sideHidden: true, captionsHidden: true, keyList: true });
    expect(out.camera).toEqual({ type: mode === "auto" ? "follow" : "hold" });
    expect(foldView(curB, out.state.humanFolds, null).openness["A"]).toEqual({ state: "open", byHuman: true });
  });
});
