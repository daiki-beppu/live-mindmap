// 使い捨て（issue #380 の計測用）。差分更新を OpenAI 互換の chat completions へ送る。
// messages を足していき、LOCAL_LLM_RENEW 回ごとに会話を捨てて全体から送り直す（ADR 0006 の形をまねる）。
// 1 回ごとの時間・トークン・失敗を LOCAL_LLM_METRICS の jsonl に追記する。
import { appendFileSync } from "node:fs";
import { Effect, Layer, Schema } from "effect";
import { DiffOutput, DiffUpdater, type DiffInput, type MeetingMap, type ScreenChange } from "./core/index.ts";
import { buildPrompt, OUTPUT_SCHEMA, SYSTEM } from "./claude.ts";

const env = process.env;
const URL_ = env.LOCAL_LLM_URL!;
const MODEL = env.LOCAL_LLM_MODEL ?? "local";
const RENEW = Number(env.LOCAL_LLM_RENEW ?? 14);
const METRICS = env.LOCAL_LLM_METRICS;
const EXTRA = JSON.parse(env.LOCAL_LLM_EXTRA_BODY ?? "{}");
const IMAGES = env.LOCAL_LLM_IMAGES !== "0";
const SUFFIX = env.LOCAL_LLM_SYSTEM_SUFFIX ?? "";
const TIMEOUT_MS = Number(env.LOCAL_LLM_TIMEOUT_MS ?? 300_000);

class LocalLlmFailed extends Schema.TaggedError<LocalLlmFailed>()("LocalLlmFailed", { message: Schema.String }) {}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Msg = { role: "system" | "user" | "assistant"; content: string | Part[] };

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const screenParts = (screens: readonly ScreenChange[]): Part[] =>
  screens.flatMap((s): Part[] =>
    s.image === null
      ? [{ type: "text", text: `## 共有画面：なし（[${fmt(s.start)}] から）` }]
      : [
          { type: "text", text: `## 共有画面 [${fmt(s.start)}] から` },
          ...(IMAGES ? [{ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${Buffer.from(s.image.bytes).toString("base64")}` } }] : []),
        ],
  );

const record = (row: object) => { if (METRICS) appendFileSync(METRICS, JSON.stringify(row) + "\n"); };

export const OpenAiCompatDiffUpdater = {
  layer: Layer.sync(DiffUpdater, () => {
    let messages: Msg[] = [];
    let calls = 0;
    let sent: MeetingMap | undefined;
    let seq = 0;
    const update = (input: DiffInput) =>
      Effect.tryPromise({
        try: async () => {
          if (calls >= RENEW) { messages = []; calls = 0; sent = undefined; }
          const fresh = sent === undefined;
          if (fresh) messages = [{ role: "system", content: SYSTEM + SUFFIX }];
          const prompt = buildPrompt(input, sent);
          const parts = [...(fresh ? screenParts(input.previousScreens ?? []) : []), ...screenParts(input.screens ?? [])];
          const user: Msg = { role: "user", content: parts.length ? [...parts, { type: "text", text: prompt }] : prompt };
          const body = {
            model: MODEL, messages: [...messages, user], temperature: 0.2,
            response_format: { type: "json_schema", json_schema: { name: "diff", strict: true, schema: OUTPUT_SCHEMA } },
            ...EXTRA,
          };
          const t0 = performance.now();
          const id = ++seq;
          let ok = false;
          try {
            const res = await fetch(`${URL_}/chat/completions`, {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const json: any = await res.json();
            const ms = Math.round(performance.now() - t0);
            if (!res.ok) { record({ id, ms, fresh, calls, error: "http", status: res.status, detail: JSON.stringify(json).slice(0, 300) }); throw new Error(`HTTP ${res.status}`); }
            const text: string = json.choices?.[0]?.message?.content ?? "";
            const usage = json.usage ?? {};
            const timings = json.timings ?? {};
            let parsed: unknown;
            try { parsed = JSON.parse(text); } catch { record({ id, ms, fresh, calls, error: "json", finish: json.choices?.[0]?.finish_reason, usage, timings }); throw new Error("JSON が読めない"); }
            const decoded = Schema.decodeUnknownExit(DiffOutput)(parsed);
            if (decoded._tag === "Failure") { record({ id, ms, fresh, calls, error: "schema", usage, timings }); throw new Error("スキーマ違反"); }
            record({ id, ms, fresh, calls, ops: (decoded.value as any).ops?.length, kinds: (decoded.value as any).ops?.map((o: any) => o.op), usage, timings, images: parts.filter((p) => p.type === "image_url").length });
            messages = [...messages, user, { role: "assistant", content: text }];
            calls++;
            sent = input.map;
            ok = true;
            return decoded.value;
          } finally {
            // 失敗したら会話を捨てて、次は全体から送る（claude.ts と同じ扱い）
            if (!ok) { messages = []; calls = 0; sent = undefined; }
          }
        },
        catch: (e) => new LocalLlmFailed({ message: e instanceof Error ? e.message : String(e) }),
      });
    return DiffUpdater.of({ update });
  }),
};
