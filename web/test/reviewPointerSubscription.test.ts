import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { makeSubscriptions } from "../src/app/review/subscription.ts";
import { Message } from "../src/app/review/message.ts";
import { plainApp, plainContext, stateAt } from "./reviewHarness.ts";

const subscriptions = makeSubscriptions(plainContext);
const surface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });

type Dependencies = { isPressing?: boolean; maybeDependencies?: { _tag: string; value?: { isPressing?: boolean } } };
const isPressing = (dependencies: Dependencies): boolean => (dependencies.maybeDependencies === undefined ? dependencies.isPressing : dependencies.maybeDependencies.value?.isPressing) === true;
const pressing = (model: ReturnType<typeof stateAt>): string[] =>
  Object.entries(subscriptions)
    .filter(([, entry]) => isPressing(entry.modelToDependencies(model) as Dependencies))
    .map(([name]) => name);

describe("見返しの表示面のポインタの Subscription", () => {
  it("何も無い所を押した間だけ、表示面のポインタの Subscription が開く（スライダーを押した間の文書の pointerup とは別）", () => {
    const start = stateAt(plainContext, 100);
    expect(pressing(start)).toEqual([]);
    const pressed = plainApp.update(start, surface(MapSurfaceMessage.PressedMapSurface({ clientX: 100, clientY: 100, button: 0, ctrlKey: false, insideNoPan: false }))).model;
    expect(pressing(pressed)).toHaveLength(1);
    expect(pressing(pressed)).not.toContain("sliderRelease");
    const released = plainApp.update(pressed, surface(MapSurfaceMessage.ReleasedPointer())).model;
    expect(pressing(released)).toEqual([]);
  });

  it("スライダーを押している間は、表示面のポインタの Subscription を開かない", () => {
    const pressedSlider = plainApp.update(stateAt(plainContext, 100), Message.PressedSliderPointer()).model;
    expect(pressing(pressedSlider)).toEqual(["sliderRelease"]);
  });

  const motionActive = (model: ReturnType<typeof stateAt>): boolean => {
    const dependencies = subscriptions.mapSurfaceAnimationFrame!.modelToDependencies(model) as { maybeDependencies?: { value?: { isActive?: boolean } } };
    return dependencies.maybeDependencies?.value?.isActive === true;
  };

  it("補間している間（motion が Some）だけ、表示面の animationFrame の Subscription が開き、Tick 合計 500 の後に閉じる", () => {
    const measured = plainApp.update(stateAt(plainContext, 100), surface(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, n1: 40, n2: 40, n3: 40 } }))).model;
    expect(motionActive(measured)).toBe(false);
    const moved = plainApp.update(measured, Message.ClickedNext()).model;
    expect(Option.isSome(moved.mapSurface.motion)).toBe(true);
    expect(motionActive(moved)).toBe(true);
    const half = plainApp.update(moved, surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 250 }))).model;
    expect(motionActive(half)).toBe(true);
    const done = plainApp.update(half, surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 250 }))).model;
    expect(motionActive(done)).toBe(false);
  });
});
