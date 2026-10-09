// 使い捨て（issue #635 の計測用）。Sign in with ChatGPT（ChatGPT プラン利用）の最小の OAuth と、Responses API の呼び出し。
// トークンはリポジトリの外（~/.live-mindmap-proto/chatgpt/、0600）に置く。ログにも出さない。
// 使い方:
//   node bench/chatgpt.ts login     ブラウザで Continue with ChatGPT を通し、資格情報を保存する
//   node bench/chatgpt.ts models    このアカウントで選べるモデルを出す
//   node bench/chatgpt.ts ping <model>  構造化出力つきで 1 回呼び、時間とヘッダーを出す
// ID トークンの署名は検証しない（試作。nonce と aud だけ見る）。
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const DIR = join(homedir(), ".live-mindmap-proto", "chatgpt");
const CREDS = join(DIR, "credentials.json");
const HOST_ID = join(DIR, "host-id");
const AUTH = "https://auth.openai.com/api/accounts";
const RESOURCE = "https://api.openai.com/v1";
const PORT = 1455;
const REDIRECT = `http://127.0.0.1:${PORT}/auth/callback`;

type Creds = {
  client_id: string; ext_agent_host_id: string; subject: string; email?: string;
  id_token: string; access_token: string; refresh_token: string; scopes: string[];
  expires_at: number; saved_at: string;
};

const b64url = (b: Buffer) => b.toString("base64url");
const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());

function writeAtomic(path: string, body: string) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

function hostId() {
  if (existsSync(HOST_ID)) return readFileSync(HOST_ID, "utf8").trim();
  const id = `urn:uuid:${randomUUID()}`;
  writeAtomic(HOST_ID, id);
  return id;
}

const loadCreds = (): Creds | undefined => (existsSync(CREDS) ? JSON.parse(readFileSync(CREDS, "utf8")) : undefined);

async function tokenRequest(form: Record<string, string>) {
  const res = await fetch(`${AUTH}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`token ${res.status}: ${json.error ?? ""} ${json.error_description ?? ""}`);
  return json;
}

function save(prev: Partial<Creds>, tok: any): Creds {
  const id = tok.id_token ?? prev.id_token!;
  const claims = jwtPayload(id);
  const creds: Creds = {
    client_id: prev.client_id!, ext_agent_host_id: prev.ext_agent_host_id!, subject: claims.sub, email: claims.email,
    id_token: id, access_token: tok.access_token, refresh_token: tok.refresh_token ?? prev.refresh_token!,
    scopes: String(tok.scope ?? "").split(" ").filter(Boolean), expires_at: Date.now() + tok.expires_in * 1000,
    saved_at: new Date().toISOString(),
  };
  writeAtomic(CREDS, JSON.stringify(creds, null, 2));
  return creds;
}

async function login() {
  const prev = loadCreds();
  const ext = hostId();
  const state = b64url(randomBytes(24)), nonce = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    client_id: prev?.client_id ?? "dynamic_agent_client",
    ...(prev ? { id_token_hint: prev.id_token } : { agent_name_hint: "live-mindmap" }),
    ext_agent_host_id: ext, response_type: "code", redirect_uri: REDIRECT,
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", resource: RESOURCE,
    state, nonce, code_challenge_method: "S256", code_challenge: challenge,
  });
  const got = await new Promise<URLSearchParams>((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT);
      if (u.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("live-mindmap: サインインを受け取りました。このタブは閉じてかまいません。");
      srv.close();
      resolve(u.searchParams);
    });
    srv.on("error", reject);
    srv.listen(PORT, "127.0.0.1", () => {
      console.log("ブラウザで ChatGPT のサインインを開きます。");
      execFile("open", [`${AUTH}/authorize?${q}`]);
    });
  });
  if (got.get("state") !== state) throw new Error("state が合わない");
  if (got.get("error")) throw new Error(`認可されなかった: ${got.get("error")}`);
  const clientId = got.get("client_id") ?? prev?.client_id;
  if (!clientId || clientId === "dynamic_agent_client") throw new Error("発行された client_id が無い");
  if (prev && clientId !== prev.client_id) throw new Error("別の client_id が返った");
  const tok = await tokenRequest({
    grant_type: "authorization_code", client_id: clientId, code: got.get("code")!, code_verifier: verifier,
    redirect_uri: REDIRECT, resource: RESOURCE,
  });
  const claims = jwtPayload(tok.id_token);
  if (claims.nonce !== nonce) throw new Error("nonce が合わない");
  if (claims.aud !== clientId && !(Array.isArray(claims.aud) && claims.aud.includes(clientId))) throw new Error("aud が合わない");
  const creds = save({ client_id: clientId, ext_agent_host_id: ext }, tok);
  console.log(`保存した: ${creds.email ?? creds.subject}、スコープ ${creds.scopes.join(" ")}`);
  if (!creds.scopes.includes("chatgpt.tokens.use.direct")) console.log("注意: プラン利用（chatgpt.tokens.use.direct）が許可されていない");
}

// 期限の 5 分前を過ぎていたら更新する。呼ぶのは 1 つのプロセスだけなので、直列化はしない
let refreshing: Promise<Creds> | undefined;
export async function accessToken(): Promise<string> {
  let c = loadCreds();
  if (!c) throw new Error("ChatGPT にサインインしていない（node bench/chatgpt.ts login）");
  if (Date.now() > c.expires_at - 5 * 60_000) {
    const prev = c;
    refreshing ??= tokenRequest({ grant_type: "refresh_token", client_id: prev.client_id, refresh_token: prev.refresh_token, resource: RESOURCE })
      .then((tok) => save(prev, tok)).finally(() => { refreshing = undefined; });
    c = await refreshing;
  }
  return c.access_token;
}

export type ResponsesResult = {
  ms: number; text?: string; status: number; error?: string; usage?: any;
  headers: Record<string, string>; requestId?: string; firstByteMs?: number;
};

// Responses API を SSE で呼び、response.completed までを成功とする
export async function callResponses(body: object, timeoutMs = 300_000): Promise<ResponsesResult> {
  const t0 = performance.now();
  const res = await fetch(`${RESOURCE}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await accessToken()}` },
    body: JSON.stringify({ ...body, store: false, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (/^x-|ratelimit|retry|openai/i.test(k)) headers[k] = v; });
  const base = { status: res.status, headers, requestId: res.headers.get("x-request-id") ?? undefined };
  if (!res.ok || !res.body) {
    const detail = await res.text();
    return { ...base, ms: Math.round(performance.now() - t0), error: detail.slice(0, 600) };
  }
  let buf = "", text = "", firstByteMs: number | undefined, done: any, failed: string | undefined;
  const dec = new TextDecoder();
  for await (const chunk of res.body as any) {
    firstByteMs ??= Math.round(performance.now() - t0);
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      const e = JSON.parse(data);
      if (e.type === "response.output_text.delta") text += e.delta;
      else if (e.type === "response.completed") done = e.response;
      else if (e.type === "response.failed" || e.type === "response.incomplete" || e.type === "error")
        failed = JSON.stringify(e.response?.error ?? e.response?.incomplete_details ?? e.error ?? e).slice(0, 600);
    }
  }
  const ms = Math.round(performance.now() - t0);
  if (!done) return { ...base, ms, firstByteMs, error: failed ?? "response.completed が来なかった" };
  return { ...base, ms, firstByteMs, text, usage: done.usage };
}

async function models() {
  const res = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${await accessToken()}` } });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`models ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  for (const m of json.models ?? json.data ?? []) console.log(`${m.slug ?? m.id}\t${m.display_name ?? ""}\t${m.visibility ?? ""}`);
}

async function ping(model: string) {
  const schema = {
    type: "object", additionalProperties: false, required: ["種類", "text"],
    properties: { 種類: { type: "string", enum: ["なし", "合意", "作業"] }, text: { type: "string" } },
  };
  const r = await callResponses({
    model, instructions: "発言の種類を 1 つ選び、text に 40 字以内で要約する。",
    input: [{ role: "user", content: "では、来週までに佐藤さんが見積もりを出す、ということでお願いします。" }],
    text: { format: { type: "json_schema", name: "ping", strict: true, schema } },
  });
  console.log(JSON.stringify(r, null, 2));
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const run = cmd === "login" ? login() : cmd === "models" ? models() : cmd === "ping" ? ping(arg ?? "gpt-6-luna") : Promise.reject(new Error("login | models | ping <model>"));
  run.catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
