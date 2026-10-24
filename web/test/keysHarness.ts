import { Effect, Fiber, Stream } from "effect";
import { vi } from "vitest";

type Listener = (event: FakeKeyEvent) => void;

export type FakeElement = {
  tagName: string;
  isContentEditable: boolean;
  classes: readonly string[];
  closest: (selector: string) => FakeElement | null;
  dispatchEvent: ReturnType<typeof vi.fn>;
};

export const element = (tag: string, classes: readonly string[] = [], isContentEditable = false): FakeElement => {
  const self: FakeElement = {
    tagName: tag.toUpperCase(),
    isContentEditable,
    classes,
    dispatchEvent: vi.fn(),
    closest: (selector) =>
      selector
        .split(",")
        .map((part) => part.trim())
        .some((part) => (part.startsWith(".") ? classes.includes(part.slice(1)) : part === "a[href]" ? tag === "a" : part === tag))
        ? self
        : null,
  };
  return self;
};

export type FakeKeyEvent = {
  type: "keydown";
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: FakeElement;
  composedPath: () => FakeElement[];
  preventDefault: ReturnType<typeof vi.fn>;
  stopImmediatePropagation: ReturnType<typeof vi.fn>;
};

export type KeyInit = Partial<Pick<FakeKeyEvent, "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "repeat" | "isComposing" | "defaultPrevented" | "target">>;

export const keydown = (init: KeyInit = {}): FakeKeyEvent => {
  const target = init.target ?? element("div");
  const event: FakeKeyEvent = {
    type: "keydown",
    key: "",
    code: "",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    ...init,
    target,
    composedPath: () => [target],
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
    stopImmediatePropagation: vi.fn(),
  };
  return event;
};

const KEY_NAMES: Readonly<Record<string, string>> = { Plus: "+", Space: " " };
export const eventOfBinding = (keys: string, over: KeyInit = {}): FakeKeyEvent => {
  const parts = keys.split("+");
  const name = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1);
  return keydown({
    key: KEY_NAMES[name] ?? name,
    shiftKey: modifiers.includes("Shift"),
    ctrlKey: modifiers.includes("Control"),
    metaKey: modifiers.includes("Meta"),
    altKey: modifiers.includes("Alt"),
    ...over,
  });
};

export type FakeDocument = {
  defaultView: unknown;
  addEventListener: (type: string, listener: Listener) => void;
  removeEventListener: (type: string, listener: Listener) => void;
  dispatchEvent: ReturnType<typeof vi.fn>;
  fire: (event: FakeKeyEvent) => void;
  listenerCount: (type: string) => number;
};

export const fakeDocument = (): FakeDocument => {
  const listeners = new Map<string, Set<Listener>>();
  const window = { document: undefined as unknown, navigator: { userAgent: "Macintosh" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() };
  const doc: FakeDocument = {
    defaultView: window,
    addEventListener: (type, listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener),
    removeEventListener: (type, listener) => void listeners.get(type)?.delete(listener),
    dispatchEvent: vi.fn(),
    fire: (event) => {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
  window.document = doc;
  return doc;
};

export const settleKeyEvents = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

export const pressEach = <A>(makeStream: (target: EventTarget) => Stream.Stream<A>, events: readonly FakeKeyEvent[]): Promise<{ perEvent: A[][]; doc: FakeDocument; listenersAfter: number }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doc = fakeDocument();
      const collected: A[] = [];
      const fiber = yield* Effect.forkChild(Stream.runForEach(makeStream(doc as unknown as EventTarget), (m) => Effect.sync(() => void collected.push(m))));
      yield* settleKeyEvents;
      const perEvent: A[][] = [];
      for (const event of events) {
        const before = collected.length;
        doc.fire(event);
        yield* settleKeyEvents;
        perEvent.push(collected.slice(before));
      }
      yield* Fiber.interrupt(fiber);
      return { perEvent, doc, listenersAfter: doc.listenerCount("keydown") };
    }),
  );
