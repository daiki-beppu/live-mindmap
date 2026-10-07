import { describe, expect, it } from "vitest";
import { INITIAL_VIEWING, nextCameraOrder, reduceViewing, type CameraCommand, type CameraOrder, type ViewingEvent, type ViewingState, type VisibleTree } from "../src/viewing.ts";

const tree = (currentTopic: string | undefined): VisibleTree => ({
  ids: ["root", "n1", "n2"],
  targets: { root: { x: 0, y: 0 }, n1: { x: 200, y: 0 }, n2: { x: 200, y: 80 } },
  currentTopic,
});
const plainEscape: ViewingEvent = { type: "escape", meta: false, ctrl: false, alt: false };
const moved: ViewingEvent = { type: "userMoved" };
const reflect: ViewingEvent = { type: "reflect" };

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
