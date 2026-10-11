import { Schema } from "effect";
import { Item } from "./managedDepsProtocol.ts";

const descriptions = { claude: "Claude Agent SDK", chromium: "Chromium" };

export const describeDep = (item: typeof Item.Type): string =>
  `${item.name}（${descriptions[item.name]}${item.size === undefined ? "" : `、約 ${Math.round(item.size / 1_000_000)}MB`}）`;

export class StartupDepsMissing extends Schema.TaggedError<StartupDepsMissing>()("StartupDepsMissing", {
  items: Schema.Array(Item),
}) {
  override get message(): string {
    return [
      `開始しません。足りないもの: ${this.items.map(describeDep).join("、")}`,
      `入れるには: pnpm cli install ${this.items.map((item) => item.name).join(" ")}`,
      "利用者に確認してから入れてください",
    ].join("\n");
  }
}
