import { describe, expect, it } from "vitest";
import { INITIAL_VIEWING, foldToggle, nextCameraOrder, reduceViewing, type CameraCommand, type CameraOrder, type ViewingEvent, type ViewingState, type VisibleTree } from "../src/viewing.ts";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView } from "../src/folding.ts";
import { relocations } from "../src/relocation.ts";
import { evidenceOf } from "../src/evidence.ts";

const tree = (currentTopic: string | undefined): VisibleTree => ({
  ids: ["root", "n1", "n2"],
  targets: { root: { x: 0, y: 0 }, n1: { x: 200, y: 0 }, n2: { x: 200, y: 80 } },
  parents: { root: null, n1: "root", n2: "root" },
  foldState: {},
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

describe("reduceViewing: F で全体を見て、もう一度押すと全体を見る前に戻る", () => {
  it("自動で F を押すと全体を見る状態になり、全体を収める（fitAll）", () => {
    const out = reduceViewing(INITIAL_VIEWING, key("F"), tree("n1"));
    expect(out.state.mode).toBe("overview");
    expect(out.camera).toEqual({ type: "fitAll" });
  });

  it("自動 → F → F で自動に戻り、今の議題へ寄せ直す（refocus）", () => {
    const { state, commands } = run([[key("F"), tree("n1")], [key("F"), tree("n1")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "fitAll" }, { type: "refocus" }]);
  });

  it("人 → F → F で、止めた時点の議題の人の状態に戻り、前の倍率・位置へ戻す（restore）", () => {
    const { state, commands } = run([[key("F"), tree("n2")], [key("F"), tree("n2")]], { mode: "manual", topic: "n1" });
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(commands).toEqual([{ type: "fitAll" }, { type: "restore" }]);
  });

  it("戻った後にまた F を押せば、また全体を見る（1回きりではない）", () => {
    const { state, commands } = run([[key("F"), tree("n1")], [key("F"), tree("n1")], [key("F"), tree("n1")]]);
    expect(state.mode).toBe("overview");
    expect(commands.at(-1)).toEqual({ type: "fitAll" });
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
  const overview: ViewingState = { mode: "overview", topic: "n1", before: { mode: "manual", topic: "n1" } };
  const open = (s: ViewingState): ViewingState => ({ ...s, keyList: true });

  it.each([
    ["自動", INITIAL_VIEWING, "follow"],
    ["manual", manual, "hold"],
    ["overview", overview, "hold"],
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

  it("開いたまま F → F で戻っても、開いたまま。全体を見る前の状態（before）に keyList は入らない", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const toOverview = reduceViewing(open(manual), f, tree("n1"));
    expect(toOverview.state).toEqual(open({ mode: "overview", topic: "n1", before: { mode: "manual", topic: "n1" } }));
    const back = reduceViewing(toOverview.state, f, tree("n1"));
    expect(back.state).toEqual(open(manual));
    expect(back.camera).toEqual({ type: "restore" });
  });

  it("閉じた後の F → F では、before に古い開閉が戻らない", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const { state } = run([[help(), tree("n1")], [f, tree("n1")], [help(), tree("n1")], [f, tree("n1")]], manual);
    expect(state).toEqual(manual);
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

// SessionView.dispatch と同じく、出来事の列を reduceViewing に通し、指示を nextCameraOrder で積む。
// shownSeqAfter が true の出来事の後は、描画された（shownSeq が今の番号になる）ものとして扱う
const stackOrders = (
  events: { event: ViewingEvent; tree: VisibleTree; renderedAfter?: boolean }[],
  from: ViewingState,
  scope: "live" | "review" = "review",
) => {
  let state = from;
  let order: CameraOrder = { command: { type: "follow" }, seq: 0 };
  let shownSeq = 0;
  for (const { event, tree: t, renderedAfter } of events) {
    const out = reduceViewing(state, event, t, scope);
    state = out.state;
    order = nextCameraOrder(order, out.camera, shownSeq);
    if (renderedAfter) shownSeq = order.seq;
  }
  return { state, order };
};

describe("nextCameraOrder: 同じ更新内で、まだ描画されていない refocus を follow で上書きしない", () => {
  const refocusThenTimeMoved = (from: ViewingState, renderedBetween: boolean) =>
    stackOrders(
      [
        { event: reflect, tree: tree("n2"), renderedAfter: renderedBetween },
        { event: timeMoved, tree: tree("n2") },
      ],
      from,
    );
  const timeMovedThenReflect = (from: ViewingState, renderedBetween: boolean) =>
    stackOrders(
      [
        { event: timeMoved, tree: tree("n2"), renderedAfter: renderedBetween },
        { event: reflect, tree: tree("n2") },
      ],
      from,
    );

  for (const [name, from] of [["manual", manualN1], ["overview", overviewFrom(manualN1)]] as const) {
    it(`見返しの ${name} で議題が変わる反映の後に時刻が動いても、refocus が保たれる`, () => {
      const out = refocusThenTimeMoved(from, false);
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.order).toEqual({ command: { type: "refocus" }, seq: 1 });
    });

    it(`見返しの ${name} で時刻が動いた後に議題が変わる反映が来ても、refocus が保たれる`, () => {
      const out = timeMovedThenReflect(from, false);
      expect(out.order.command).toEqual({ type: "refocus" });
    });

    it(`間に描画をはさむと、後の follow が通常どおり置き換える（${name}）`, () => {
      expect(refocusThenTimeMoved(from, true).order).toEqual({ command: { type: "follow" }, seq: 2 });
    });
  }

  it("反映を伴わない時刻操作は、止めているとき refocus、自動のとき follow になる", () => {
    expect(stackOrders([{ event: timeMoved, tree: tree("n1") }], manualN1).order).toEqual({ command: { type: "refocus" }, seq: 1 });
    expect(stackOrders([{ event: timeMoved, tree: tree("n1") }], INITIAL_VIEWING).order).toEqual({ command: { type: "follow" }, seq: 1 });
  });

  it("描画前の refocus の後でも、follow 以外（人が動かす）は置き換える。timeMoved は refocus を保つ", () => {
    const moved1 = stackOrders([{ event: reflect, tree: tree("n2") }, { event: moved, tree: tree("n2") }], manualN1);
    expect(moved1.order).toEqual({ command: { type: "hold" }, seq: 2 });
    const kept = stackOrders([{ event: reflect, tree: tree("n2") }, { event: timeMoved, tree: tree("n2") }], manualN1);
    expect(kept.order).toEqual({ command: { type: "refocus" }, seq: 1 });
  });

  it("ライブでは、議題が変わらない限り時刻の出来事で指示が増えても状態は変わらない", () => {
    const out = stackOrders([{ event: timeMoved, tree: tree("n1") }], manualN1, "live");
    expect(out.state).toEqual(manualN1);
    expect(out.order.command).toEqual({ type: "hold" });
  });
});

describe("reduceViewing: E で右の列、C で字幕を出し入れする（カメラの状態とは独立）", () => {
  const toggle = (type: "side" | "captions", over: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type, meta: false, ctrl: false, alt: false, ...over });
  const manual: ViewingState = { mode: "manual", topic: "n1" };
  const overview: ViewingState = { mode: "overview", topic: "n1", before: { mode: "manual", topic: "n1" } };
  const cameras = [
    ["自動", INITIAL_VIEWING],
    ["manual", manual],
    ["overview", overview],
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

  it("隠したまま F → F で戻っても隠したまま。全体を見る前の状態（before）に印は入らず、戻った後に古い印が復活しない", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const start: ViewingState = { ...manual, sideHidden: true };
    const toOverview = reduceViewing(start, f, tree("n1")).state;
    expect(toOverview).toEqual({ mode: "overview", topic: "n1", before: { mode: "manual", topic: "n1" }, sideHidden: true });
    expect(reduceViewing(toOverview, f, tree("n1")).state).toEqual(start);
    // 全体を見ている間に出し直してから戻ると、出た状態で戻る
    const shownAgain = reduceViewing(toOverview, toggle("side"), tree("n1")).state;
    expect(reduceViewing(shownAgain, f, tree("n1")).state).toEqual(manual);
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
  foldState: {},
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
    const empty: VisibleTree = { ids: [], targets: {}, parents: {}, foldState: {}, currentTopic: undefined };
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
    const from: ViewingState = { mode: "overview", topic: "A", before: { mode: "auto" }, selection: { id: "A1", byKey: false } };
    const out = reduceViewing(from, arrow("down"), arrowTree("A"));
    expect(out.state).toEqual({ mode: "manual", topic: "A", selection: { id: "A2", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
    expect("before" in out.state).toBe(false);
  });

  it.each([
    ["自動", INITIAL_VIEWING, { type: "follow" }],
    ["manual", { mode: "manual", topic: "A" }, { type: "hold" }],
    ["overview", { mode: "overview", topic: "A", before: { mode: "auto" } }, { type: "hold" }],
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

  it("F で全体を見て、もう一度 F で戻っても選択は残る。全体を見る前の状態（before）には選択を入れない", () => {
    const overview = reduceViewing(sel, key("F"), arrowTree("A")).state;
    expect(overview).toEqual({ mode: "overview", topic: "A", before: { mode: "manual", topic: "A" }, selection: { id: "A1", byKey: true } });
    const back = reduceViewing(overview, key("F"), arrowTree("A")).state;
    expect(back).toEqual(sel);
    const fromAuto = reduceViewing(selected("A1", false), key("F"), arrowTree("A")).state;
    expect(fromAuto).toEqual({ mode: "overview", topic: "A", before: { mode: "auto" }, selection: { id: "A1", byKey: false } });
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
    ["overview", selected("A1", true, { mode: "overview", topic: "A", before: { mode: "auto" } })],
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
const NO_OPEN: ReadonlySet<string> = new Set();
const finished = { talkStatus: "済み" } as const;
const froot = fnode("root", null, "会議", []);

// 本番と同じく、畳む見せ方の結果から見えている木を組み立てる
const visibleOf = (snapshot: Snapshot, selectedId: string | null, opened: ReadonlySet<string> = NO_OPEN, humanFolded: ReadonlySet<string> = NO_OPEN): VisibleTree => {
  const view = foldView(snapshot, opened, selectedId, humanFolded);
  const shown = view.nodes;
  return {
    ids: shown.map((n) => n.id),
    targets: Object.fromEntries(shown.map((n, i) => [n.id, { x: n.parent === null ? 0 : 200, y: i * 50 }])),
    parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
    // 見せる議題・論点（まとめのノードを除く）が、畳まれているか開いているか
    foldState: Object.fromEntries(shown.filter((n) => (n.kind === "議題" || n.kind === "論点") && !view.summaries.has(n.id)).map((n) => [n.id, n.id in view.folds ? "folded" : "open"])),
    currentTopic: snapshot.currentTopic,
  };
};

describe("reduceViewing: Esc で選択を外した直後は、普段どおりに畳まれる", () => {
  // 済みの議題 A の下の論点 A1 を選んでいる間は A は開き、Esc で外れた次の描画で畳まれる
  const snapshot = fsnap([froot, fnode("A", "root", "議題", ["r1"], finished), fnode("A1", "A", "論点", ["r1"]), fnode("B", "root", "議題", ["r1"])], 4, "B");
  const sel = selected("A1", true, { mode: "manual", topic: "B" });

  it("選んでいる間は祖先 A が開いて A1 が見え、Esc の出力の selection（無い）を渡すと A1 は畳まれて見えない", () => {
    expect(foldView(snapshot, NO_OPEN, sel.selection?.id ?? null, NO_OPEN).nodes.map((n) => n.id)).toEqual(["root", "A", "A1", "B"]);
    const out = reduceViewing(sel, plainEscape, visibleOf(snapshot, "A1"));
    expect(out.state.selection).toBeUndefined();
    expect(foldView(snapshot, NO_OPEN, out.state.selection?.id ?? null, NO_OPEN).nodes.map((n) => n.id)).toEqual(["root", "A", "B"]);
  });

  it("修飾つきの Esc では選択が残るので、畳み方も変わらない", () => {
    const out = reduceViewing(sel, { ...plainEscape, meta: true } as ViewingEvent, visibleOf(snapshot, "A1"));
    expect(foldView(snapshot, NO_OPEN, out.state.selection?.id ?? null, NO_OPEN).nodes.map((n) => n.id)).toEqual(["root", "A", "A1", "B"]);
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
  const merged = fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1", "r2"]), fnode("X", "P1", "案", ["r2"])], 5, "A");
  const deleted = fsnap([froot, fnode("A", "root", "議題", ["r1"]), fnode("P1", "A", "論点", ["r1"])], 5, "A");

  const reflectFrom = (b: Snapshot, a: Snapshot, state: ViewingState, scope: "live" | "review" = "live") => {
    const replaced = relocations({ tree: visibleOf(b, null), snapshot: b, selectedId: state.selection?.id ?? null }, { tree: visibleOf(a, null), snapshot: a });
    return reduceViewing(state, { type: "reflect", replaced }, visibleOf(a, null), scope);
  };

  // 今の議題は B。人の畳み（A）で選択ノード P2 が前の木から隠れた状態で、反映が起きる。選択は移り先へ移り、根拠欄も移り先を出す
  const withB = (nodes: SnapshotNode[], round: number) => fsnap([...nodes, fnode("B", "root", "議題", ["r3"])], round, "B");
  const reflectHidden = (b: Snapshot, a: Snapshot) => {
    const folded = set("A");
    const state: ViewingState = { mode: "manual", topic: "B", humanFolded: folded, selection: { id: "P2", byKey: true } };
    const prevTree = visibleOf(b, "P2", NO_OPEN, folded);
    expect(prevTree.ids).not.toContain("P2");
    const replaced = relocations({ tree: prevTree, snapshot: b, selectedId: "P2" }, { tree: visibleOf(a, "P2", NO_OPEN, folded), snapshot: a });
    const out = reduceViewing(state, { type: "reflect", replaced }, visibleOf(a, "P2", NO_OPEN, folded));
    return { out, evidence: evidenceOf(a, out.state.selection?.id ?? "", NO_OPEN, folded) };
  };
  const hiddenBefore = withB(before.nodes, 4);

  it("人の畳みで隠れた選択ノードが削除されたら、残る祖先 A へ移り、根拠欄も A を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(deleted.nodes, 5));
    expect(out.state.selection).toEqual({ id: "A", byKey: true });
    expect(evidence?.node.id).toBe("A");
  });

  it("人の畳みで隠れた選択ノードが統合されたら、統合先 P1 へ移り、根拠欄も P1 を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(merged.nodes, 5));
    expect(out.state.selection).toEqual({ id: "P1", byKey: true });
    expect(evidence?.node.id).toBe("P1");
  });

  it("人の畳みで隠れた選択ノードが、巻き戻しで無い時点になったら、統合先ではなく祖先 A へ移り、根拠欄も A を出す", () => {
    const { out, evidence } = reflectHidden(hiddenBefore, withB(merged.nodes, 3));
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
    const overview: ViewingState = { mode: "overview", topic: "A", before: { mode: "auto" }, selection: { id: "P2", byKey: true } };
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
    const overview = reduceViewing({ mode: "overview", topic: "A", before: { mode: "auto" }, sideHidden: true, selection: { id: "A", byKey: false } }, z(), arrowTree("B"));
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
    const overview: ViewingState = { mode: "overview", topic: "A", before: { mode: "auto" } };
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

// ---- #320: 人による議題の開閉 ----

// root ─ A（済み）─ A1 / B（話し中）─ B1 / C（話し中）─ C1。今の議題を変えた 2 つのスナップショット
const hnodes = [
  froot,
  fnode("A", "root", "議題", ["r1"], finished),
  fnode("A1", "A", "論点", ["r1"]),
  fnode("B", "root", "議題", ["r1"]),
  fnode("B1", "B", "論点", ["r1"]),
  fnode("C", "root", "議題", ["r1"]),
  fnode("C1", "C", "論点", ["r1"]),
];
const curB = fsnap(hnodes, 4, "B");
const curC = fsnap(hnodes, 5, "C");
const curB1 = fsnap(hnodes, 6, "B1");
const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);
const enter = (mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type: "enter", meta: false, ctrl: false, alt: false, ...mods }) as ViewingEvent;
const foldDot = (id: string): ViewingEvent => ({ type: "foldDot", id }) as ViewingEvent;
const openedOf = (s: ViewingState): ReadonlySet<string> => s.humanOpened ?? NO_OPEN;
const foldedOf = (s: ViewingState): ReadonlySet<string> => s.humanFolded ?? NO_OPEN;
const shownIds = (snapshot: Snapshot, state: ViewingState) => foldView(snapshot, openedOf(state), state.selection?.id ?? null, foldedOf(state)).nodes.map((n) => n.id);
// 状態から、人の開閉の集合を除いたもの（カメラの状態・他の重ねる状態・選択だけ）
const noHuman = (s: ViewingState): ViewingState => {
  const { humanOpened: _o, humanFolded: _f, ...rest } = s;
  return rest;
};
// 選択つきの状態で、今の描画の見えている木を渡して出来事を処理する
const press = (state: ViewingState, event: ViewingEvent, snapshot: Snapshot, scope: "live" | "review" = "live") =>
  reduceViewing(state, event, visibleOf(snapshot, state.selection?.id ?? null, openedOf(state), foldedOf(state)), scope);

describe("foldToggle: 開く・畳むの向きと、効かないノード", () => {
  const t = visibleOf(curB, null);
  it("畳まれている議題は開く（open）、開いている議題・論点は畳む（fold）", () => {
    expect(t.foldState["A"]).toBe("folded");
    expect(foldToggle(t, "A")).toBe("open");
    expect(foldToggle(t, "C")).toBe("fold");
    expect(foldToggle(t, "C1")).toBe("fold");
  });

  it("今の議題とその祖先、見えていないノード、議題・論点でないノードは null", () => {
    expect(foldToggle(t, "B")).toBeNull();
    expect(foldToggle(t, "root")).toBeNull();
    expect(foldToggle(t, "A1")).toBeNull(); // 畳まれて見えていない
    expect(foldToggle(t, "gone")).toBeNull();
    const deep = visibleOf(curB1, null);
    expect(foldToggle(deep, "B")).toBeNull();
    expect(foldToggle(deep, "B1")).toBeNull();
    expect(foldToggle(deep, "C")).toBe("fold");
    const withDecision = visibleOf(fsnap([...hnodes, fnode("D1", "C1", "決定", ["r1"])], 6, "B"), null);
    expect(withDecision.ids).toContain("D1");
    expect(foldToggle(withDecision, "D1")).toBeNull();
  });
});

describe("reduceViewing: Enter と丸で、人が議題・論点を開く・畳む", () => {
  it("畳まれている選んだ議題を Enter で開くと、人が開いた集合に入る（人が畳んだ集合は置かない）。開いた議題の中が見える", () => {
    const from = selected("A", true);
    expect(shownIds(curB, from)).toEqual(["root", "A", "B", "B1", "C", "C1"]);
    const out = press(from, enter(), curB);
    expect([...openedOf(out.state)]).toEqual(["A"]);
    expect("humanFolded" in out.state).toBe(false);
    expect(out.state.selection).toEqual({ id: "A", byKey: true });
    expect(shownIds(curB, out.state)).toEqual(["root", "A", "A1", "B", "B1", "C", "C1"]);
  });

  it("開いている選んだ議題を Enter で畳むと、人が畳んだ集合に入る（人が開いた集合は置かない）。畳んだ議題の中は見えない", () => {
    const out = press(selected("C", true), enter(), curB);
    expect([...foldedOf(out.state)]).toEqual(["C"]);
    expect("humanOpened" in out.state).toBe(false);
    expect(shownIds(curB, out.state)).toEqual(["root", "A", "B", "B1", "C"]);
  });

  it("論点も Enter で畳める", () => {
    const out = press(selected("C1", true), enter(), curB);
    expect([...foldedOf(out.state)]).toEqual(["C1"]);
  });

  it("クリックで選んだノードにも Enter が効く（選び方は byKey のまま）", () => {
    const out = press(selected("C", false), enter(), curB);
    expect([...foldedOf(out.state)]).toEqual(["C"]);
    expect(out.state.selection).toEqual({ id: "C", byKey: false });
  });

  it("開いて、また Enter で畳み、また Enter で開く。開く・畳むは同じノードで入れ替わる（両方には入らない）", () => {
    let state = selected("A", true);
    state = press(state, enter(), curB).state;
    expect([[...openedOf(state)], [...foldedOf(state)]]).toEqual([["A"], []]);
    state = press(state, enter(), curB).state;
    expect([[...openedOf(state)], [...foldedOf(state)]]).toEqual([[], ["A"]]);
    expect("humanOpened" in state).toBe(false);
    state = press(state, enter(), curB).state;
    expect([[...openedOf(state)], [...foldedOf(state)]]).toEqual([["A"], []]);
    expect("humanFolded" in state).toBe(false);
  });

  it("別のノードの開閉は、すでにある開閉に足される", () => {
    let state = press(selected("A", true), enter(), curB).state;
    state = { ...state, selection: { id: "C", byKey: true } };
    state = press(state, enter(), curB).state;
    expect([[...openedOf(state)], [...foldedOf(state)]]).toEqual([["A"], ["C"]]);
  });

  it("丸（foldDot）は、選んでいるノードに関わらず、押した議題を開く・畳む。選択は変えない", () => {
    const from = selected("B1", true);
    const folded = press(from, foldDot("C"), curB);
    expect([...foldedOf(folded.state)]).toEqual(["C"]);
    expect(folded.state.selection).toEqual({ id: "B1", byKey: true });
    const opened = press(from, foldDot("A"), curB);
    expect([...openedOf(opened.state)]).toEqual(["A"]);
    expect(opened.state.selection).toEqual({ id: "B1", byKey: true });
  });

  it("丸は、選んでいないとき（selection なし）でも効く", () => {
    expect([...foldedOf(press(INITIAL_VIEWING, foldDot("C"), curB).state)]).toEqual(["C"]);
  });
});

describe("reduceViewing: Enter・丸が効かないとき", () => {
  const unchanged = (from: ViewingState, event: ViewingEvent, snapshot: Snapshot) => {
    const out = press(from, event, snapshot);
    expect(out.state).toEqual(from);
    expect(out.camera).toEqual(from.mode === "auto" ? { type: "follow" } : { type: "hold" });
  };

  it("⌘・Ctrl・Option のどれか付きの Enter は何もしない（対照: 修飾なしなら畳む）", () => {
    const from = selected("C", true, { mode: "manual", topic: "B" });
    for (const mods of [{ meta: true }, { ctrl: true }, { alt: true }]) unchanged(from, enter(mods), curB);
    expect([...foldedOf(press(from, enter(), curB).state)]).toEqual(["C"]);
  });

  it("選んでいないときの Enter は何もしない", () => {
    unchanged(INITIAL_VIEWING, enter(), curB);
    unchanged({ mode: "manual", topic: "B" }, enter(), curB);
  });

  it("選んだノードが今の木に無い・畳まれた中で見えないときの Enter・丸は何もしない（対照: 見えているノードは畳める）", () => {
    unchanged(selected("gone", true), enter(), curB);
    // A は畳まれていて A1 は見えない（A1 を選ぶと A が開くので、選んでいない木で渡す）
    const hidden = selected("A1", true);
    expect(reduceViewing(hidden, enter(), visibleOf(curB, null), "live")).toEqual({ state: hidden, camera: { type: "follow" } });
    unchanged(INITIAL_VIEWING, foldDot("gone"), curB);
    expect([...foldedOf(press(selected("C1", true), enter(), curB).state)]).toEqual(["C1"]);
  });

  it("「議題 N 件」（run:X）を選んだ Enter・丸は何もしない（開くのは別の仕事）", () => {
    const runs = fsnap([froot, fnode("A", "root", "議題", ["r1"], finished), fnode("A1", "A", "論点", ["r1"]), fnode("D", "root", "議題", ["r1"], finished), fnode("B", "root", "議題", ["r1"])], 4, "B");
    expect(visibleOf(runs, "run:A").ids).toEqual(["root", "run:A", "B"]);
    unchanged(selected("run:A", true), enter(), runs);
    unchanged(INITIAL_VIEWING, foldDot("run:A"), runs);
  });

  it("決定・TODO などの議題・論点でないノードの Enter・丸は何もしない", () => {
    const withDecision = fsnap([...hnodes, fnode("D1", "C1", "決定", ["r1"])], 6, "B");
    unchanged(selected("D1", true), enter(), withDecision);
    unchanged(INITIAL_VIEWING, foldDot("D1"), withDecision);
    unchanged(selected("root", true), enter(), withDecision);
  });

  it("今の議題には効かない: Enter も丸も何もしない（対照: 同じ木の隣の議題 C は畳める）", () => {
    unchanged(selected("B", true), enter(), curB);
    unchanged(INITIAL_VIEWING, foldDot("B"), curB);
    expect([...foldedOf(press(selected("C", true), enter(), curB).state)]).toEqual(["C"]);
    expect([...foldedOf(press(INITIAL_VIEWING, foldDot("C"), curB).state)]).toEqual(["C"]);
  });

  it("今の議題の祖先（会議のルート・上の議題・論点）にも効かない", () => {
    unchanged(selected("root", true), enter(), curB);
    unchanged(selected("B", true), enter(), curB1);
    unchanged(INITIAL_VIEWING, foldDot("B"), curB1);
    unchanged(selected("B1", true), enter(), curB1);
    expect([...foldedOf(press(selected("C", true), enter(), curB1).state)]).toEqual(["C"]);
  });

  it("効かない Enter では、すでにある人の開閉も変わらない", () => {
    const from: ViewingState = { mode: "auto", humanOpened: set("A"), humanFolded: set("C"), selection: { id: "B", byKey: true } };
    unchanged(from, enter(), curB);
  });
});

describe("reduceViewing: 人が畳んだ議題に変化が当たって今の議題になると、人の畳みは解ける", () => {
  const folded: ViewingState = { mode: "auto", humanFolded: set("C") };

  it("自動のとき: 今の議題が C になる反映で、C の人の畳みが解け、後で C が今の議題でなくなっても C は畳まれない", () => {
    let state = press(INITIAL_VIEWING, foldDot("C"), curB).state;
    expect(shownIds(curB, state)).toEqual(["root", "A", "B", "B1", "C"]);
    state = reduceViewing(state, reflect, visibleOf(curC, null, openedOf(state), foldedOf(state))).state;
    expect("humanFolded" in state).toBe(false);
    expect(state).toEqual({ mode: "auto" });
    state = reduceViewing(state, reflect, visibleOf(curB, null)).state;
    expect(shownIds(curB, state)).toEqual(["root", "A", "B", "B1", "C", "C1"]);
  });

  it("対照: 別の議題が今の議題になる反映では、C の人の畳みは残る", () => {
    const state = reduceViewing(folded, reflect, visibleOf(curB, null, NO_OPEN, set("C"))).state;
    expect([...foldedOf(state)]).toEqual(["C"]);
  });

  it("止めているとき（今の議題が変わって自動に戻る反映）でも解ける。モードは自動に戻る", () => {
    const from: ViewingState = { mode: "manual", topic: "B", humanFolded: set("C") };
    const out = reduceViewing(from, reflect, visibleOf(curC, null, NO_OPEN, set("C")));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("止めていて今の議題が変わらない反映の経路でも、今の議題が人の畳んだ議題なら解ける（モードは止めたまま）", () => {
    const from: ViewingState = { mode: "manual", topic: "C", humanFolded: set("C") };
    const out = reduceViewing(from, reflect, visibleOf(curC, null, NO_OPEN, set("C")));
    expect(out.state).toEqual({ mode: "manual", topic: "C" });
    const overview: ViewingState = { mode: "overview", topic: "C", before: { mode: "auto" }, humanFolded: set("C") };
    expect(reduceViewing(overview, reflect, visibleOf(curC, null, NO_OPEN, set("C"))).state).toEqual({ mode: "overview", topic: "C", before: { mode: "auto" } });
  });

  it("統合などで選択が移る反映（replaced あり）でも解け、選択も移る", () => {
    const from: ViewingState = { mode: "auto", humanFolded: set("C"), selection: { id: "X", byKey: true } };
    const out = reduceViewing(from, { type: "reflect", replaced: { X: "Y" } }, visibleOf(curC, null, NO_OPEN, set("C")));
    expect(out.state).toEqual({ mode: "auto", selection: { id: "Y", byKey: true } });
  });

  it("今の議題になった C だけが解ける。ほかの人の畳み・人が開いたものは残る", () => {
    const from: ViewingState = { mode: "auto", humanFolded: set("A", "C"), humanOpened: set("B") };
    const out = reduceViewing(from, reflect, visibleOf(curC, null, set("B"), set("A", "C")));
    expect([...foldedOf(out.state)]).toEqual(["A"]);
    expect([...openedOf(out.state)]).toEqual(["B"]);
  });

  it("人が開いたものは、今の議題になっても解けない", () => {
    const from: ViewingState = { mode: "auto", humanOpened: set("A") };
    const out = reduceViewing(from, reflect, visibleOf(fsnap(hnodes, 6, "A"), null, set("A")));
    expect([...openedOf(out.state)]).toEqual(["A"]);
  });
});

describe("reduceViewing: Esc で人の開閉が全部解け、その場で普段どおりに畳まれる", () => {
  const both: ViewingState = { mode: "manual", topic: "B", humanOpened: set("A"), humanFolded: set("C"), selection: { id: "C", byKey: true }, sideHidden: true };

  it("修飾なしの Esc で、開いた・畳んだの両方と選択が外れ、カメラの状態は今までどおり戻る。ほかの重ねる状態は残る", () => {
    const out = press(both, plainEscape, curB);
    expect(out.state).toEqual({ mode: "auto", sideHidden: true });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("自動のときの Esc でも解ける", () => {
    const out = press({ mode: "auto", humanOpened: set("A"), humanFolded: set("C") }, plainEscape, curB);
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });

  it("Esc の出力を畳む見せ方に渡すと、普段どおりに畳まれる（人が開いた済みの A は畳まれ、人が畳んだ C は開く）", () => {
    expect(shownIds(curB, both)).toEqual(["root", "A", "A1", "B", "B1", "C"]);
    const out = press(both, plainEscape, curB);
    expect(shownIds(curB, out.state)).toEqual(["root", "A", "B", "B1", "C", "C1"]);
  });

  it("キー一覧が開いているときの Esc は一覧を閉じるだけで、人の開閉は残る", () => {
    const out = press({ ...both, keyList: true }, plainEscape, curB);
    expect(out.state).toEqual(both);
  });

  it("⌘・Ctrl・Option 付きの Esc では解けない", () => {
    for (const mods of [{ meta: true }, { ctrl: true }, { alt: true }]) {
      const out = press(both, { ...plainEscape, ...mods } as ViewingEvent, curB);
      expect([...openedOf(out.state)]).toEqual(["A"]);
      expect([...foldedOf(out.state)]).toEqual(["C"]);
    }
  });

  it("人の開閉だけで選択が無くても、Esc で解ける", () => {
    const out = press({ mode: "auto", humanFolded: set("C") }, plainEscape, curB);
    expect(out.state).toEqual({ mode: "auto" });
  });
});

describe("reduceViewing: 人の開閉は他の出来事で変わらず、今の議題が変わっても残る", () => {
  const from: ViewingState = { mode: "auto", humanOpened: set("A"), humanFolded: set("C") };
  const sets = (s: ViewingState) => [[...openedOf(s)], [...foldedOf(s)]];

  it("反映（今の議題が C 以外へ変わる）・触らず 10 秒・動かす・倍率キー・列と字幕・キー一覧・選択を重ねても、同じ状態の上で残る", () => {
    const t = visibleOf(curB, null, set("A"), set("C"));
    const events: ViewingEvent[] = [
      reflect,
      { type: "idle" },
      moved,
      { type: "key", key: "=", meta: false, ctrl: false, alt: false },
      { type: "side", meta: false, ctrl: false, alt: false },
      { type: "captions", meta: false, ctrl: false, alt: false },
      { type: "keyList", meta: false, ctrl: false, alt: false },
      { type: "keyList", meta: false, ctrl: false, alt: false },
      click("B"),
      arrow("down"),
      { type: "edgeDot", id: "B1" },
      reflect,
    ];
    const { state } = run(events.map((e): [ViewingEvent, VisibleTree] => [e, t]), from);
    expect(sets(state)).toEqual([["A"], ["C"]]);
  });

  it("今の議題が B から A、A から B へ変わる反映を重ねても、A を開いた・C を畳んだは残る", () => {
    const toA = visibleOf(fsnap(hnodes, 6, "A"), null, set("A"), set("C"));
    const toB = visibleOf(curB, null, set("A"), set("C"));
    const { state } = run([[reflect, toA], [reflect, toB], [reflect, toA]], from);
    expect(sets(state)).toEqual([["A"], ["C"]]);
  });

  it("見返しで時刻を動かして自動に戻っても残る", () => {
    const out = reduceViewing({ ...from, mode: "manual", topic: "B" } as ViewingState, { type: "timeMoved" }, visibleOf(curB, null, set("A"), set("C")), "review");
    expect(out.state).toEqual({ mode: "auto", humanOpened: set("A"), humanFolded: set("C") });
  });

  it("F → F の全体表示でも残り、全体を見る前の状態（before）には人の開閉を入れない", () => {
    const t = visibleOf(curB, null, set("A"), set("C"));
    const ov = reduceViewing(from, { type: "key", key: "F", meta: false, ctrl: false, alt: false }, t);
    expect(ov.state).toEqual({ mode: "overview", topic: "B", before: { mode: "auto" }, humanOpened: set("A"), humanFolded: set("C") });
    const back = reduceViewing(ov.state, { type: "key", key: "F", meta: false, ctrl: false, alt: false }, t);
    expect(back.state).toEqual({ mode: "auto", humanOpened: set("A"), humanFolded: set("C") });
  });

  it("済みの判定・話し中への戻りは、出来事として届く反映の木が変わるだけで、人の開閉は変わらない", () => {
    // A が話し中に戻り、C が済みになる。反映ごとに見える木が変わっても、人の開閉の集合はそのまま
    const flipped = fsnap(
      hnodes.map((n) => {
        if (n.id === "A") { const { talkStatus: _t, ...rest } = n; return rest; }
        return n.id === "C" ? { ...n, talkStatus: "済み" as const } : n;
      }),
      7,
      "B",
    );
    const { state } = run([[reflect, visibleOf(flipped, null, set("A"), set("C"))], [reflect, visibleOf(curB, null, set("A"), set("C"))]], from);
    expect(sets(state)).toEqual([["A"], ["C"]]);
    // 人が開いた A は、済みでも話し中でも畳まれず、人が畳んだ C は、済みでも話し中でも畳まれたまま
    for (const snapshot of [curB, flipped]) {
      expect(shownIds(snapshot, state)).toContain("A1");
      expect(shownIds(snapshot, state)).not.toContain("C1");
    }
  });
});

describe("reduceViewing: 開閉そのものは自動のカメラを止めも戻しもせず、位置を保つ指示（keepNode）を出す", () => {
  it("止めているとき: モードも覚えた議題も変えず、そのノードの位置を保つ指示（keepNode）を出す", () => {
    const from = selected("C", true, { mode: "manual", topic: "B" });
    const out = press(from, enter(), curB);
    expect(out.camera).toEqual({ type: "keepNode", id: "C" });
    expect(out.state).toEqual({ mode: "manual", topic: "B", selection: { id: "C", byKey: true }, humanFolded: set("C") });
  });

  it("全体を見ているとき: モードも before も変えず、位置を保つ指示（keepNode）を出す（全体への収め直しはしない）", () => {
    const from = selected("A", true, { mode: "overview", topic: "B", before: { mode: "manual", topic: "B" } });
    const out = press(from, enter(), curB);
    expect(out.camera).toEqual({ type: "keepNode", id: "A" });
    expect(out.state).toEqual({ mode: "overview", topic: "B", before: { mode: "manual", topic: "B" }, selection: { id: "A", byKey: true }, humanOpened: set("A") });
  });

  it("丸でも同じ（止めているとき keepNode、押したノードの ID）", () => {
    const out = press({ mode: "manual", topic: "B" }, foldDot("C"), curB);
    expect(out.camera).toEqual({ type: "keepNode", id: "C" });
    expect(noHuman(out.state)).toEqual({ mode: "manual", topic: "B" });
  });

  it("自動のとき: 自動のままで、今の議題へ寄り直す（refocus）。keepNode は出さない", () => {
    const out = press(selected("C", true), enter(), curB);
    expect(out.camera).toEqual({ type: "refocus" });
    expect(out.state.mode).toBe("auto");
    expect(press(INITIAL_VIEWING, foldDot("A"), curB).camera).toEqual({ type: "refocus" });
  });

  it("見返しでも、止めているときに開閉しても自動へ戻らず keepNode を出す（開閉は『触った』ことにならずモードを変えない）", () => {
    const out = press(selected("C", true, { mode: "manual", topic: "B" }), enter(), curB, "review");
    expect(out.state.mode).toBe("manual");
    expect(out.camera).toEqual({ type: "keepNode", id: "C" });
  });
});

describe("reduceViewing: 人の開閉でも入力を書き換えない", () => {
  it("enter・foldDot・escape・reflect は、入力の状態・木・集合を書き換えず、新しい状態を返す", () => {
    const opened = set("A");
    const folded = set("C");
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "B", humanOpened: opened, humanFolded: folded, selection: Object.freeze({ id: "A1", byKey: true }) }) as ViewingState;
    const t = visibleOf(curB, "A1", opened, folded);
    const before = JSON.stringify(t);
    for (const event of [enter(), foldDot("A"), foldDot("C"), plainEscape, reflect]) {
      reduceViewing(state, event, t);
    }
    expect([...opened]).toEqual(["A"]);
    expect([...folded]).toEqual(["C"]);
    expect(state.selection).toEqual({ id: "A1", byKey: true });
    expect(JSON.stringify(t)).toBe(before);
  });
});
