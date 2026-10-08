// 使い捨て（issue #380 の計測用）。bench/afm/afm（Foundation Models）を、localhost の OpenAI 互換の chat completions で包む。
// messages が system + user の 2 つなら会話を作り直し、それより長ければ同じ session に最後の user だけを送る。画像は捨てる。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const PORT = Number(process.env.PORT ?? 8090);
const child = spawn(new URL("./afm/afm", import.meta.url).pathname, [], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout! });
const waiting: ((l: string) => void)[] = [];
lines.on("line", (l) => waiting.shift()?.(l));
const ask = (req: object) => new Promise<string>((res) => { waiting.push(res); child.stdin!.write(JSON.stringify(req) + "\n"); });

// JSON Schema を Apple の方言にする（anyOf と object に title、object に x-order）
const conv = (n: any, name = "R"): any => {
  if (n.anyOf) return { title: name, anyOf: n.anyOf.map((c: any, i: number) => ({ ...conv(c, `${name}${i}`), title: `${name}${i}` })) };
  const o = { ...n };
  if (o.type === "object") {
    o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, conv(v, k)]));
    o["x-order"] = Object.keys(o.properties);
    o.title = name;
  }
  if (o.type === "array") o.items = conv(o.items, `${name}Item`);
  return o;
};
const textOf = (c: any): string => (typeof c === "string" ? c : c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"));

let queue = Promise.resolve();
createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    queue = queue.then(async () => {
      const j = JSON.parse(body);
      const msgs = j.messages;
      const out = JSON.parse(await ask({
        reset: msgs.length === 2,
        system: textOf(msgs[0].content),
        prompt: textOf(msgs[msgs.length - 1].content),
        schema: conv(j.response_format.json_schema.schema),
      }));
      if (out.error) { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: out.error })); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: out.content }, finish_reason: "stop" }],
        usage: { prompt_tokens: out.input, completion_tokens: out.output, prompt_tokens_details: { cached_tokens: out.cached } },
      }));
    });
  });
}).listen(PORT, "127.0.0.1", () => console.error(`afm on 127.0.0.1:${PORT}`));
