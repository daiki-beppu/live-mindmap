// 日本語入力の道が、Dom.streamFromKeyBindings と同じ規則で表を照合する純粋な関数（streamFromKeyBindings の照合は内部にあって外から使えない）。
// key は大文字・小文字を区別しない（Space・Plus は名前）。修飾キーは Shift を含めて厳密に照合する
import type { HalfWidthKey } from "../../imeKey.ts";
import type { Binding } from "./table.ts";

const MODIFIERS = ["alt", "control", "meta", "shift"] as const;

const normalizeKey = (key: string): string => {
  if (key === " ") return key;
  const lower = key.trim().toLowerCase();
  return lower === "space" ? " " : lower === "plus" ? "+" : lower;
};

type Press = { key: string; alt: boolean; control: boolean; meta: boolean; shift: boolean };

const pressOf = (keys: string): Press => {
  const tokens = keys.split("+").map((token) => token.trim().toLowerCase());
  const key = tokens[tokens.length - 1] ?? "";
  const modifiers = tokens.slice(0, -1);
  const has = (name: (typeof MODIFIERS)[number]) => modifiers.includes(name);
  return { key: normalizeKey(key), alt: has("alt"), control: has("control"), meta: has("meta"), shift: has("shift") };
};

export function matchKey(bindings: readonly Binding[], input: HalfWidthKey): Binding | undefined {
  const key = normalizeKey(input.key);
  return bindings.find((binding) => {
    const press = pressOf(binding.keys);
    return press.key === key && press.alt === input.altKey && press.control === input.ctrlKey && press.meta === input.metaKey && press.shift === input.shiftKey;
  });
}
