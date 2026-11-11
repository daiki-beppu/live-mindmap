import { Context } from "effect";

export const withoutFinalNewline = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

export const StdoutIsTty = Context.Reference("live-mindmap/StdoutIsTty", {
  defaultValue: (): boolean => process.stdout.isTTY === true,
});
