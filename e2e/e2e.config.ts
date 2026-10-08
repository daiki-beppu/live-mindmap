import { readFileSync } from "node:fs";
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { chatgpt } from "e2e/oauth/chatgpt";

// target は 2 つ。web は smoke（台本の先頭 3 件）、web-full は台本の全件。同じ会議中のテストが両方で動く。
const fullCount = (JSON.parse(readFileSync(new URL("fixtures/meeting.json", import.meta.url), "utf8")) as { events: unknown[] }).events.length;

const target = (name: string, events: number, log: string) => ({
  name,
  engine: web(),
  app: {
    // ポートは runner が空きポートを選び、{port} に入れる。server のポートは serve.ts が別に空きポートを選び、run-info に書く
    url: "http://127.0.0.1:0",
    command: {
      executable: process.execPath,
      args: ["scripts/serve.ts", "--web-port", "{port}", "--events", String(events)],
      log,
    },
  },
});

// 記録（agent.act の replay cache を作る）だけ ChatGPT のサブスクを使う（`pnpm exec e2e login openai`）。
// 記録が一致するステップは cache から再生し、モデルを呼ばない。名前・指示文・params を変えたステップは `--strict-cache` でもモデルを呼ぶので、変えたら記録し直す。API キーは置かない。
export default {
  agents: { default: { model: chatgpt("gpt-6-luna") } },
  targets: [target("web", 3, ".e2e/logs/app.log"), target("web-full", fullCount, ".e2e/logs/app-full.log")],
} satisfies E2EConfig;
