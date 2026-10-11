import { Schema } from "effect";
import { Item } from "./managedDepsProtocol.ts";
import { HELPER_BUILD_COMMAND } from "./helperPath.ts";

const descriptions = { claude: "Claude Agent SDK", chromium: "Chromium", cloudflared: "cloudflared", "speech-ja": "日本語の音声認識モデル", helper: "ヘルパーのビルド", microphone: "マイクの許可", "screen-capture": "画面収録の許可" };

export const describeDep = (item: typeof Item.Type): string =>
  `${item.name}（${descriptions[item.name]}${item.size === undefined ? "" : `、約 ${Math.round(item.size / 1_000_000)}MB`}）`;

export class StartupDepsMissing extends Schema.TaggedError<StartupDepsMissing>()("StartupDepsMissing", {
  items: Schema.Array(Item),
}) {
  override get message(): string {
    const managed = this.items.filter((item) => item.name === "claude" || item.name === "chromium" || item.name === "speech-ja");
    return [
      `開始しません。足りないもの: ${this.items.map(describeDep).join("、")}`,
      ...(managed.length === 0 ? [] : [`入れるには: pnpm cli install ${managed.map((item) => item.name).join(" ")}`]),
      ...(this.items.some((item) => item.name === "helper") ? [`入れるには: ${HELPER_BUILD_COMMAND}`] : []),
      "利用者に確認してから入れてください",
    ].join("\n");
  }
}
