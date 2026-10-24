import { readFileSync } from "node:fs";
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { chatgpt } from "e2e/oauth/chatgpt";

const fullCount = (JSON.parse(readFileSync(new URL("fixtures/meeting.json", import.meta.url), "utf8")) as { events: unknown[] }).events.length;

const target = (name: string, events: number, log: string) => ({
  name,
  engine: web(),
  app: {
    url: "http://127.0.0.1:0",
    command: {
      executable: process.execPath,
      args: ["scripts/serve.ts", "--web-port", "{port}", "--events", String(events)],
      log,
    },
  },
});

export default {
  agents: { default: { model: chatgpt("gpt-6-luna") } },
  targets: [target("web", 4, ".e2e/logs/app.log"), target("web-full", fullCount, ".e2e/logs/app-full.log")],
} satisfies E2EConfig;
