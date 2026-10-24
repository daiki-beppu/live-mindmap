import { Context } from "effect";

// Console.log／Console.error が末尾に改行を足すので、改行で終わる文字列はその 1 つを外して渡す
export const withoutFinalNewline = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

export const StdoutIsTty = Context.Reference("live-mindmap/StdoutIsTty", {
  defaultValue: (): boolean => process.stdout.isTTY === true,
});
