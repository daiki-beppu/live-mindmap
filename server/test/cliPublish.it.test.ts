import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Fiber, FileSystem, Layer, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { openSealed, PUBLISH_TITLE, REVIEW_LOG_ELEMENT_ID } from "../src/core/index.ts";
import { AppleIntelligence } from "../src/appleIntelligence.ts";
import { ReviewBuild, ReviewPageFailed } from "../src/review.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

// cli publish（Issue #1250 の --anyone と、Issue #1251 の既定の合言葉）。runCli を、偽の Cloudflare API・一時フォルダの HOME・偽の ReviewBuild・止めた時計で呼ぶ。
// 偽の API が受け取った Worker のスクリプトは、実際に import して Request を渡す

const ACCOUNT = "acct-1234567890";
const TOKEN = "cf-token-synthetic";
const SUBDOMAIN = "acme-team";
const MEETING = "秘密の会議X";
const REMARK_TEXT = "ここは外に出してはいけない発言";
const SCREEN_LINE = "画面に映った社外秘ABC";
const NOW = Date.parse("2026-10-17T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const TEMPLATE = '<!doctype html><html><head><title>live-mindmap</title><meta property="og:title" content="live-mindmap"><meta name="description" content="live-mindmap"></head><body></body></html>';
const MIB = 1024 * 1024;

afterEach(() => vi.restoreAllMocks());

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-publish-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

type Call = { method: string; path: string; search: string; headers: Record<string, string>; form: FormData | null; json: unknown; text: string };

type ApiBehavior = {
  // 要求ごとの上書き。null を返すと既定の成功応答にする
  respond?: (call: Call) => { status: number; body: unknown } | null;
};

const ok = (result: unknown) => ({ status: 200, body: { success: true, errors: [], messages: [], result } });

// 受け取った要求を記録する偽の Cloudflare API。Direct Upload の 3 段（assets-upload-session → assets/upload → script PUT）と、
// サブドメインの取得・Worker 単位の workers.dev の有効化・Worker の削除に成功の応答を返す
function fakeCloudflare(behavior: ApiBehavior = {}) {
  const calls: Call[] = [];
  const client = HttpClient.make((request) => Effect.promise(async () => {
    const url = new URL(request.url);
    const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    let form: FormData | null = null;
    let json: unknown = null;
    let text = "";
    const body = request.body;
    if (body._tag === "FormData") form = body.formData;
    else if (body._tag === "Uint8Array") {
      const contentType = body.contentType ?? headers["content-type"] ?? "";
      if (contentType.startsWith("multipart/")) form = await new Response(body.body as BodyInit, { headers: { "content-type": contentType } }).formData();
      else {
        text = new TextDecoder().decode(body.body);
        try { json = JSON.parse(text); } catch { json = null; }
      }
    }
    const call: Call = { method: request.method, path: url.pathname, search: url.search, headers, form, json, text };
    calls.push(call);
    const custom = behavior.respond?.(call);
    const response = custom ?? defaultResponse(call);
    return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } }));
  }));
  return { calls, client };
}

function defaultResponse(call: Call): { status: number; body: unknown } {
  const base = `/client/v4/accounts/${ACCOUNT}/workers`;
  if (call.method === "GET" && call.path === `${base}/subdomain`) return ok({ subdomain: SUBDOMAIN });
  if (call.method === "POST" && call.path.endsWith("/assets-upload-session")) return ok({ jwt: "upload-jwt", buckets: [["0123456789abcdef0123456789abcdef"]] });
  if (call.method === "GET" && call.path === `${base}/scripts`) return ok([]);
  if (call.path === `${base}/assets/upload`) return { status: 201, body: { success: true, errors: [], messages: [], result: { jwt: "completion-jwt" } } };
  return ok({});
}

const isScriptPut = (c: Call) => c.method === "PUT" && /\/workers\/scripts\/[^/]+$/.test(c.path);
const isScriptDelete = (c: Call) => c.method === "DELETE" && /\/workers\/scripts\/[^/]+$/.test(c.path);
// Worker 単位の workers.dev の有効化（script の下の subdomain）
const isEnableSubdomain = (c: Call) => /\/workers\/scripts\/[^/]+\/subdomain$/.test(c.path);
const scriptName = (c: Call) => decodeURIComponent(c.path.split("/").at(-1)!);

type Setup = {
  api: ReturnType<typeof fakeCloudflare>;
  stdout: string[];
  stderr: string[];
  home: string;
  sessions: string;
  env?: Record<string, string>;
  template?: string;
  buildFailure?: ReviewPageFailed;
};

function layerOf(s: Setup) {
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { s.stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { s.stderr.push(args.map(String).join(" ") + "\n"); },
  };
  return Layer.mergeAll(
    NodeServices.layer,
    readyManagedDeps,
    Layer.succeed(HttpClient.HttpClient, s.api.client),
    Layer.succeed(AppleIntelligence, AppleIntelligence.of({
      availability: Effect.succeed({ osVersion: "27.0", availability: { status: "unavailable", reason: "modelNotReady" } }),
      launch: Effect.die("このテストでは推論子を起動できません"),
    })),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({
      HOME: s.home, LIVE_MINDMAP_CONFIG: join(s.sessions, "absent.config.json"), LIVE_MINDMAP_JUDGE: "off",
      LIVE_MINDMAP_SESSIONS: s.sessions, LIVE_MINDMAP_PORT: "0",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, ...s.env,
    })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(MapCapture, MapCapture.of({ capture: () => Effect.die("publish は撮影しない") })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({
      build: s.buildFailure ? Effect.fail(s.buildFailure) : Effect.succeed(s.template ?? TEMPLATE),
    })),
    fakeAudioMix().layer,
    fakeScreenJpeg().layer,
  );
}

const startLine = (title: string, local = false) => ({ at: "2026-10-01T00:00:00.000Z", type: "start", title, ...(local ? { model: { name: "local", route: "openai-compatible", local: true } } : {}) });
const bodyLines = (title: string) => [
  { at: "2026-10-01T00:00:01.000Z", type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 9, text: REMARK_TEXT } },
  { at: "2026-10-01T00:00:02.000Z", type: "screen", start: 3, image: null, lines: [SCREEN_LINE] },
  { at: "2026-10-01T00:00:04.000Z", type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: `${title}の論点`, evidence: ["r1"] }], dropped: [] },
];

function writeSession(sessions: string, name: string, title = MEETING, options: { local?: boolean; extra?: unknown[] } = {}) {
  const dir = join(sessions, name);
  mkdirSync(dir, { recursive: true });
  const lines = [startLine(title, options.local), ...bodyLines(title), ...(options.extra ?? [])];
  writeFileSync(join(dir, "log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

const setup = (root: string, behavior?: ApiBehavior, extra: Partial<Setup> = {}): Setup => ({
  api: fakeCloudflare(behavior), stdout: [], stderr: [], home: join(root, "home"), sessions: join(root, "sessions"), ...extra,
});

const publish = (s: Setup, argv: string[]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    return yield* Effect.result(runCli(["publish", ...argv]).pipe(Effect.provide(layerOf(s))));
  });

const failureText = (result: Result.Result<unknown, unknown>) => (Result.isFailure(result) ? String(result.failure) : "");
const output = (s: Setup, result?: Result.Result<unknown, unknown>) => [s.stdout.join(""), s.stderr.join(""), result ? failureText(result) : ""].join("\n");

// 記録: ~/.live-mindmap/ の下の通常ファイルを再帰的にすべて数える
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}
const recordFiles = (s: Setup) => filesUnder(join(s.home, ".live-mindmap"));
const recordRows = (s: Setup): Record<string, unknown>[] =>
  recordFiles(s).flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>));
const asMs = (value: unknown): number => (typeof value === "number" ? value : Date.parse(String(value)));

// 偽の API が受け取った HTML（assets/upload の base64 を戻したもの）
// パートの Content-Type は Worker が配信するときの Content-Type になるので、text/html であることも確かめる
async function uploadedHtml(s: Setup): Promise<string> {
  const upload = s.api.calls.find((c) => c.path.endsWith("/workers/assets/upload"));
  expect(upload, "assets/upload が呼ばれていない").toBeDefined();
  expect(upload!.search).toContain("base64=true");
  expect(upload!.headers["authorization"]).toBe("Bearer upload-jwt");
  const parts = [...upload!.form!.values()];
  expect(parts).toHaveLength(1);
  const part = parts[0];
  expect(part instanceof Blob, "アセットのパートが型付きの Blob ではない").toBe(true);
  expect((part as Blob).type).toMatch(/^text\/html/);
  return Buffer.from(await (part as Blob).text(), "base64").toString("utf8");
}

// 偽の API が受け取った Worker のスクリプト（script PUT の JavaScript の module）
async function uploadedWorker(s: Setup) {
  const put = s.api.calls.find(isScriptPut);
  expect(put, "script PUT が呼ばれていない").toBeDefined();
  const metadata = JSON.parse(await (put!.form!.get("metadata") as File).text()) as { main_module: string; assets?: { jwt?: string; config?: Record<string, unknown> }; bindings?: { type: string; name: string }[] };
  const module = put!.form!.get(metadata.main_module) as File;
  expect(module, `module の part ${metadata.main_module} が無い`).toBeTruthy();
  const source = await module.text();
  const dir = await mkdtemp(join(tmpdir(), "live-mindmap-worker-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(file, source);
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { default: { fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> } };
  await rm(dir, { recursive: true, force: true });
  const assetFetches: string[] = [];
  const env = { ASSETS: { fetch: (request: Request) => { assetFetches.push(new URL(request.url).pathname); return Promise.resolve(new Response("<html>ASSET-BODY</html>", { headers: { "content-type": "text/html" } })); } } };
  const call = async (path: string, userAgent?: string, at: number = NOW) => {
    vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      return await mod.default.fetch(new Request(`https://${scriptName(put!)}.${SUBDOMAIN}.workers.dev${path}`, userAgent === undefined ? {} : { headers: { "user-agent": userAgent } }), env, { waitUntil: () => undefined });
    } finally {
      vi.restoreAllMocks();
    }
  };
  return { metadata, call, assetFetches };
}

describe("cli publish（Issue #1250: --anyone / Issue #1251: 既定は合言葉）", () => {
  describe("成功の通し", () => {
    it.effect("セッションを省くと log.jsonl を持つ最新のセッションをマップだけの段で置き、URL・期限・サブドメインの旨を出す。記録は 1 か所に 0o600 で書く", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-09-01T00-00-00.000Z", "古い会議");
      const latest = writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
      mkdirSync(join(s.sessions, "9999-12-31T00-00-00.000Z")); // log.jsonl の無い、より新しいフォルダ

      const result = yield* publish(s, ["--anyone"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      // 3 段 + 有効化
      const put = s.api.calls.find(isScriptPut)!;
      const name = scriptName(put);
      expect(name).toMatch(/^lmm-[0-9a-f]{32}$/);
      expect(put.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(put.path).toBe(`/client/v4/accounts/${ACCOUNT}/workers/scripts/${name}`);
      // 出力: URL・期限・サブドメインが URL に出る旨
      const out = s.stdout.join("");
      const url = `https://${name}.${SUBDOMAIN}.workers.dev`;
      expect(out).toContain(url);
      expect(out).toContain("7");
      expect(out).toContain(SUBDOMAIN);
      expect(out).not.toContain(MEETING);
      // 記録
      const files = recordFiles(s);
      expect(files).toHaveLength(1);
      expect(statSync(files[0]!).mode & 0o777).toBe(0o600);
      expect(statSync(join(s.home, ".live-mindmap")).mode & 0o077).toBe(0);
      const rows = recordRows(s);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name, accountId: ACCOUNT, dir: latest, level: "map", anyone: true, status: "published" });
      expect(String(rows[0]!.url)).toContain(url);
      expect(asMs(rows[0]!.publishedAt)).toBe(NOW);
      expect(asMs(rows[0]!.expiresAt)).toBe(NOW + 7 * DAY);
      expect(JSON.stringify(rows[0])).not.toContain(TOKEN);
      // 元のログの「古い方」は使わない
      expect(JSON.stringify(rows[0])).not.toContain("2026-09-01");
    }));

    it.effect("アップロード開始の応答が公式文書の例の形（errors:null, messages:null）でも、最後まで成功する", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, {
        respond: (call) => call.method === "POST" && call.path.endsWith("/assets-upload-session")
          ? { status: 200, body: { success: true, errors: null, messages: null, result: { jwt: "upload-jwt", buckets: [["0123456789abcdef0123456789abcdef"]] } } }
          : null,
      });
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");

      const result = yield* publish(s, ["--anyone"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const name = scriptName(s.api.calls.find(isScriptPut)!);
      expect(s.api.calls.filter(isEnableSubdomain)).toHaveLength(1);
      expect(s.api.calls.filter(isScriptDelete)).toHaveLength(0);
      expect(s.stdout.join("")).toContain(`https://${name}.${SUBDOMAIN}.workers.dev`);
      expect(recordRows(s)).toHaveLength(1);
      expect(recordRows(s)[0]).toMatchObject({ name, status: "published" });
    }));

    it.effect("セッションのパスを渡すと、そのセッションを置く", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      const older = writeSession(s.sessions, "2026-09-01T00-00-00.000Z", "古い会議");
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");

      const result = yield* publish(s, [older, "--anyone"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(recordRows(s)[0]).toMatchObject({ dir: older });
    }));

    it.effect("置く HTML はマップだけの段で、Direct Upload の manifest は /index.html 1 件（大きさは HTML のバイト数）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");

      const result = yield* publish(s, ["--anyone"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const html = yield* Effect.promise(() => uploadedHtml(s));
      expect(html).not.toContain(REMARK_TEXT);
      expect(html).not.toContain(SCREEN_LINE);
      const embedded = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      expect(embedded).not.toBeNull();
      const events = JSON.parse(embedded![1]!) as { type: string; remark?: { text: string }; lines?: string[] }[];
      expect(events.some((e) => e.type === "diff")).toBe(true);
      expect(events.filter((e) => e.type === "remark").every((e) => e.remark!.text === "")).toBe(true);
      expect(events.filter((e) => e.type === "screen").every((e) => e.lines === undefined)).toBe(true);

      const session = s.api.calls.find((c) => c.path.endsWith("/assets-upload-session"))!;
      const manifest = (session.json as { manifest: Record<string, { hash: string; size: number }> }).manifest;
      expect(Object.keys(manifest)).toEqual(["/index.html"]);
      expect(manifest["/index.html"]!.hash).toMatch(/^[0-9a-f]{32}$/);
      expect(manifest["/index.html"]!.size).toBe(Buffer.byteLength(html));
      expect(session.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    }));

    it.effect("置く Worker のメタデータは run_worker_first と ASSETS の束縛を持ち、assets の jwt は完了の jwt", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");

      yield* publish(s, ["--anyone"]);

      const worker = yield* Effect.promise(() => uploadedWorker(s));
      expect(worker.metadata.assets?.jwt).toBe("completion-jwt");
      expect(worker.metadata.assets?.config?.run_worker_first).toBe(true);
      expect(worker.metadata.bindings).toContainEqual({ type: "assets", name: "ASSETS" });
      // 同じ Worker の workers.dev を有効にする要求が、enabled: true で送られる
      const put = s.api.calls.find(isScriptPut)!;
      const enable = s.api.calls.filter(isEnableSubdomain);
      expect(enable).toHaveLength(1);
      expect(enable[0]!.method).toBe("POST");
      expect(enable[0]!.path).toBe(`${put.path}/subdomain`);
      expect(enable[0]!.json).toMatchObject({ enabled: true });
    }));
  });

  describe("会議名を外に出さない", () => {
    it.effect("Worker 名・URL・出力に会議名が出ない。2 回置くと名前は異なり、記録は 2 行になる", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");

      yield* publish(s, ["--anyone"]);
      yield* publish(s, ["--anyone"]);

      const names = s.api.calls.filter(isScriptPut).map(scriptName);
      expect(names).toHaveLength(2);
      for (const name of names) expect(name).toMatch(/^lmm-[0-9a-f]{32}$/);
      expect(names[0]).not.toBe(names[1]);
      expect(recordRows(s)).toHaveLength(2);
      expect(JSON.stringify(s.api.calls.map((c) => [c.path, c.search]))).not.toContain(encodeURIComponent(MEETING));
      expect(s.stdout.join("")).not.toContain(MEETING);
    }));

    it.effect("head の title は決まった文に差し替わり、og・description のメタにも会議名が出ない。会議名はログの埋め込みの中にだけ残る", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      // 会議名入りの title・メタを持つテンプレート（差し替えが無ければ会議名が残る）
      const named = `<!doctype html><html><head><title>${MEETING}</title><meta property="og:title" content="${MEETING}"><meta name="description" content="${MEETING}の議事"><meta property="og:description" content="${MEETING}"></head><body></body></html>`;
      const s = setup(root, undefined, { template: named });
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");

      yield* publish(s, ["--anyone"]);

      const html = yield* Effect.promise(() => uploadedHtml(s));
      const metas = [...html.matchAll(/<meta\s[^>]*content="([^"]*)"[^>]*>/g)].map((m) => m[1]!);
      expect(metas.length).toBeGreaterThanOrEqual(2);
      for (const content of metas) expect(content.trim()).not.toBe("");
      const withoutEmbedded = html.replace(new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">[\\s\\S]*?</script>`), "");
      expect(withoutEmbedded).not.toContain(MEETING);
      const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)];
      expect(titles).toHaveLength(1);
      expect(titles[0]![1]!.trim()).not.toBe("");
      expect(titles[0]![1]!.trim()).not.toBe("live-mindmap");
    }));

    it.effect("埋め込みの JSON の中の <title> という字面は head の書き換えの対象にならず、head の title だけが 1 つ差し替わる", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      const tricky = `${MEETING} <title>罠</title>`;
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z", tricky);

      const result = yield* publish(s, ["--anyone"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const html = yield* Effect.promise(() => uploadedHtml(s));
      expect(html.match(/<title>/g)).toHaveLength(1);
      expect(html).toContain("\\u003ctitle>罠\\u003c/title>");
      const embedded = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      const events = JSON.parse(embedded![1]!) as { type: string; title?: string }[];
      expect(events.find((e) => e.type === "start")!.title).toBe(tricky);
      expect(html).not.toMatch(/<title>[^<]*罠/);
    }));
  });

  describe("置いた Worker の振る舞い（受け取った script に Request を渡す）", () => {
    const placed = (root: string, days?: string[]) => {
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
      return { s, run: publish(s, ["--anyone", ...(days ?? [])]) };
    };

    it.effect("期限の後は、どのパスにも 410 と短い文を返す（期限の 1 ミリ秒前は通す）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { s, run } = placed(root);
      yield* run;
      const worker = yield* Effect.promise(() => uploadedWorker(s));
      const expires = NOW + 7 * DAY;

      for (const path of ["/", "/index.html", "/robots.txt", "/anything/else?x=1"]) {
        const response = yield* Effect.promise(() => worker.call(path, "Mozilla/5.0", expires));
        expect(response.status, path).toBe(410);
        const text = yield* Effect.promise(() => response.text());
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThan(200);
        expect(text).not.toContain(MEETING);
        expect(response.headers.get("x-robots-tag"), path).toBeTruthy();
      }
      const before = yield* Effect.promise(() => worker.call("/", "Mozilla/5.0", expires - 1));
      expect(before.status).toBe(200);
      expect(yield* Effect.promise(() => before.text())).toContain("ASSET-BODY");
    }));

    it.effect("期限の後は、AI クローラーの UA にも 410 を返す（410 の判定を先に置く）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { s, run } = placed(root);
      yield* run;
      const worker = yield* Effect.promise(() => uploadedWorker(s));

      const response = yield* Effect.promise(() => worker.call("/", "GPTBot/1.0", NOW + 8 * DAY));

      expect(response.status).toBe(410);
    }));

    it.effect("/robots.txt は全拒否（User-agent: * と Disallow: /）を返し、asset には取りに行かない", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { s, run } = placed(root);
      yield* run;
      const worker = yield* Effect.promise(() => uploadedWorker(s));

      const response = yield* Effect.promise(() => worker.call("/robots.txt", "Mozilla/5.0"));

      expect(response.status).toBe(200);
      const text = yield* Effect.promise(() => response.text());
      expect(text).toMatch(/User-agent:\s*\*/i);
      expect(text).toMatch(/Disallow:\s*\/\s*$/m);
      expect(response.headers.get("x-robots-tag")).toBeTruthy();
      expect(worker.assetFetches).toEqual([]);
    }));

    it.effect("主な AI クローラーの UA には 403、Discordbot などのプレビュー用のボットと通常のブラウザは asset を通す", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { s, run } = placed(root);
      yield* run;
      const worker = yield* Effect.promise(() => uploadedWorker(s));

      for (const ua of ["GPTBot/1.1", "ChatGPT-User/1.0", "OAI-SearchBot/1.0", "ClaudeBot/1.0", "anthropic-ai", "CCBot/2.0", "PerplexityBot/1.0", "Bytespider", "Mozilla/5.0 (compatible; Amazonbot/0.1)"]) {
        const response = yield* Effect.promise(() => worker.call("/", ua));
        expect(response.status, ua).toBe(403);
        expect(response.headers.get("x-robots-tag"), ua).toBeTruthy();
      }
      expect(worker.assetFetches).toEqual([]);
      for (const ua of ["Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 (Macintosh) Safari/605.1.15"]) {
        const response = yield* Effect.promise(() => worker.call("/", ua));
        expect(response.status, ua).toBe(200);
        expect(yield* Effect.promise(() => response.text()), ua).toContain("ASSET-BODY");
        expect(response.headers.get("x-robots-tag"), ua).toBeTruthy();
      }
    }));

    it.effect("UA が無い要求も asset を通し、x-robots-tag を付ける", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { s, run } = placed(root);
      yield* run;
      const worker = yield* Effect.promise(() => uploadedWorker(s));

      const response = yield* Effect.promise(() => worker.call("/"));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-robots-tag")).toBeTruthy();
    }));

    it.effect("--days 30 の期限は 30 日後で、その直前までは通し、以後は 410", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { s, run } = placed(root, ["--days", "30"]);
      const result = yield* run;
      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const worker = yield* Effect.promise(() => uploadedWorker(s));

      expect((yield* Effect.promise(() => worker.call("/", "Mozilla/5.0", NOW + 30 * DAY - 1))).status).toBe(200);
      expect((yield* Effect.promise(() => worker.call("/", "Mozilla/5.0", NOW + 30 * DAY))).status).toBe(410);
      expect(asMs(recordRows(s)[0]!.expiresAt)).toBe(NOW + 30 * DAY);
    }));
  });

  describe("何も置かずに止まる（Cloudflare への要求が 0 件、記録も無い）", () => {
    const refused = (name: string, argv: string[], prepare: (s: Setup) => void, expected: RegExp, extra: Partial<Setup> = {}) =>
      it.effect(name, () => Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const s = setup(root, undefined, extra);
        prepare(s);

        const result = yield* publish(s, argv);

        expect(Result.isFailure(result)).toBe(true);
        // publish が使い方の表示（未知のサブコマンド）で止まっただけの失敗は、拒否の証拠にしない
        expect(output(s, result)).not.toMatch(/Help requested|DESCRIPTION/);
        expect(output(s, result)).toMatch(expected);
        expect(s.api.calls).toEqual([]);
        expect(recordFiles(s)).toEqual([]);
      }));
    const normal = (s: Setup) => { writeSession(s.sessions, "2026-10-01T00-00-00.000Z"); };

    refused("--anyone が無くても、--days が範囲外なら止まる", ["--days", "0"], normal, /1.*30|--days/);
    refused("--anyone が無くても、ローカルモードのセッションは拒む", [], (s) => { writeSession(s.sessions, "2026-10-01T00-00-00.000Z", MEETING, { local: true }); }, /ローカル/);
    refused("--anyone が無くても、CLOUDFLARE_API_TOKEN が無ければ止まる", [], normal, /CLOUDFLARE_API_TOKEN/, { env: { CLOUDFLARE_API_TOKEN: "" } });
    refused("--anyone が無くても、見返しのビルドの失敗で止まる", [], normal, /ビルドに失敗/, { buildFailure: new ReviewPageFailed({ message: "ビルドに失敗" }) });
    refused("--anyone が無いときの 25 MiB は暗号化した後の HTML で数える（平文は 25 MiB 未満でも、暗号文で超えれば止まる）", [], normal, /25|MiB|大き/, {
      template: `<!doctype html><html><head><title>t</title></head><body><!--${"a".repeat(20 * MIB)}--></body></html>`,
    });
    // 未知のフラグは CLI の解析が使い方つきで拒む（refused の「使い方だけの失敗は証拠にしない」の対象外）
    it.effect("--passphrase は持たない（合言葉は引数で受けず、製品が作る）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      normal(s);

      const result = yield* publish(s, ["--passphrase", "my-own-words"]);

      expect(Result.isFailure(result)).toBe(true);
      expect(output(s, result)).toContain("Unrecognized flag: --passphrase");
      expect(s.api.calls).toEqual([]);
      expect(recordFiles(s)).toEqual([]);
    }));
    refused("--days が 0", ["--anyone", "--days", "0"], normal, /1.*30|--days/);
    refused("--days が 31", ["--anyone", "--days", "31"], normal, /1.*30|--days/);
    refused("--days が整数でない", ["--anyone", "--days", "1.5"], normal, /1.*30|--days/);
    refused("--days が数でない", ["--anyone", "--days", "abc"], normal, /1.*30|--days/);
    refused("ローカルモードのセッション（start の model.local）は拒む", ["--anyone"], (s) => { writeSession(s.sessions, "2026-10-01T00-00-00.000Z", MEETING, { local: true }); }, /ローカル/);
    refused("log.jsonl のあるセッションが無い", ["--anyone"], (s) => { mkdirSync(s.sessions, { recursive: true }); }, /セッションがありません/);
    refused("見返しのビルドが失敗した", ["--anyone"], normal, /ビルドに失敗/, { buildFailure: new ReviewPageFailed({ message: "ビルドに失敗" }) });
    refused("HTML が 25 MiB を 1 バイト超える（文字数でなくバイト数で数える）", ["--anyone"], normal, /25|MiB|大き/, {
      // 「あ」は UTF-8 で 3 バイト。文字数では 25 MiB 未満、バイト数では超える
      template: `<!doctype html><html><head><title>t</title></head><body><!--${"あ".repeat(Math.floor((25 * MIB) / 3))}--></body></html>`,
    });
    for (const [name, env] of [
      ["CLOUDFLARE_ACCOUNT_ID が無い", { CLOUDFLARE_ACCOUNT_ID: "" }],
      ["CLOUDFLARE_API_TOKEN が無い", { CLOUDFLARE_API_TOKEN: "" }],
    ] as const) {
      refused(`${name}と、変数名・Workers Admin・アカウントが要る理由を出して止まる`, ["--anyone"], normal, /CLOUDFLARE_ACCOUNT_ID[\s\S]*CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_TOKEN[\s\S]*CLOUDFLARE_ACCOUNT_ID/, { env });
      it.effect(`${name}ときの出力に Workers Admin とアカウントが要る理由がある`, () => Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const s = setup(root, undefined, { env });
        normal(s);

        const result = yield* publish(s, ["--anyone"]);

        const text = output(s, result);
        expect(text).toContain("Workers Admin");
        expect(text).toContain("アカウント");
        expect(text).toContain("workers.dev");
      }));
    }
    it.effect("資格情報が無い拒否は、見返しのビルドより前に出る（ビルド失敗でも資格情報の案内が出る）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, undefined, { env: { CLOUDFLARE_API_TOKEN: "" }, buildFailure: new ReviewPageFailed({ message: "ビルドに失敗" }) });
      normal(s);

      const result = yield* publish(s, ["--anyone"]);

      expect(output(s, result)).toContain("CLOUDFLARE_API_TOKEN");
      expect(output(s, result)).not.toContain("ビルドに失敗");
    }));
  });

  describe("Cloudflare の失敗の見分け", () => {
    const failing = (respond: ApiBehavior["respond"]) => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, { respond });
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
      const result = yield* publish(s, ["--anyone"]);
      return { s, result };
    });
    const error = (status: number, code: number, message: string) => ({ status, body: { success: false, errors: [{ code, message }], messages: [], result: null } });

    it.effect("権限不足（403）・サブドメインが無い・Worker の数の上限は、それぞれ別の出力になり、どれも失敗で返る", () => Effect.gen(function* () {
      const permission = yield* failing((c) => (c.method === "GET" && c.path.endsWith("/workers/subdomain") ? error(403, 10000, "Authentication error") : null));
      const noSubdomain = yield* failing((c) => (c.method === "GET" && c.path.endsWith("/workers/subdomain") ? error(404, 10007, "workers.dev subdomain not found") : null));
      const limit = yield* failing((c) => (isScriptPut(c) ? error(400, 10027, "You have reached the maximum number of Workers allowed on your account") : null));

      for (const r of [permission, noSubdomain, limit]) expect(Result.isFailure(r.result)).toBe(true);
      const texts = [permission, noSubdomain, limit].map((r) => output(r.s, r.result));
      expect(new Set(texts).size).toBe(3);
      expect(texts[0]).toMatch(/権限/);
      expect(texts[1]).toMatch(/サブドメイン/);
      expect(texts[2]).toMatch(/上限/);
      expect(texts[0]).not.toMatch(/上限/);
      expect(texts[1]).not.toMatch(/上限/);
      expect(texts[2]).not.toMatch(/権限/);
      expect(texts[0]).not.toContain(TOKEN);
      // どれも URL を成功として出さない・記録を残さない
      for (const r of [permission, noSubdomain, limit]) {
        expect(r.s.stdout.join("")).not.toContain("workers.dev");
        expect(recordRows(r.s)).toEqual([]);
      }
    }));

    it.effect("サブドメインの取得で止まったときは、Worker をまだ作っていない（script PUT も DELETE も呼ばない）", () => Effect.gen(function* () {
      const { s } = yield* failing((c) => (c.method === "GET" && c.path.endsWith("/workers/subdomain") ? error(404, 10007, "no subdomain") : null));

      expect(s.api.calls.some((c) => c.method === "GET" && c.path.endsWith("/workers/subdomain"))).toBe(true);
      expect(s.api.calls.some((c) => isScriptPut(c) || isScriptDelete(c))).toBe(false);
    }));
  });

  describe("置く途中の失敗は、作りかけの Worker を消してから失敗で返す", () => {
    const run = (respond: ApiBehavior["respond"]) => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, { respond });
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
      const result = yield* publish(s, ["--anyone"]);
      return { s, result };
    });

    it.effect("workers.dev の有効化で失敗すると、同じ名前の Worker を DELETE してから失敗で返す。成功の出力と記録は無い", () => Effect.gen(function* () {
      const { s, result } = yield* run((c) => (isEnableSubdomain(c) ? { status: 500, body: { success: false, errors: [{ code: 1, message: "boom-enable" }], messages: [], result: null } } : null));

      expect(Result.isFailure(result)).toBe(true);
      const put = s.api.calls.findIndex(isScriptPut);
      const del = s.api.calls.findIndex(isScriptDelete);
      expect(put).toBeGreaterThanOrEqual(0);
      expect(del).toBeGreaterThan(put);
      expect(scriptName(s.api.calls[del]!)).toBe(scriptName(s.api.calls[put]!));
      expect(s.api.calls.filter(isScriptDelete)).toHaveLength(1);
      expect(s.stdout.join("")).not.toContain("workers.dev");
      expect(recordRows(s)).toEqual([]);
      expect(output(s, result)).toContain("boom-enable");
    }));

    it.effect("script PUT の失敗でも、同じ名前を DELETE してから失敗で返す", () => Effect.gen(function* () {
      const { s, result } = yield* run((c) => (isScriptPut(c) ? { status: 500, body: { success: false, errors: [{ code: 1, message: "boom-put" }], messages: [], result: null } } : null));

      expect(Result.isFailure(result)).toBe(true);
      const names = s.api.calls.filter(isScriptDelete).map(scriptName);
      expect(names).toEqual([scriptName(s.api.calls.find(isScriptPut)!)]);
      expect(recordRows(s)).toEqual([]);
    }));

    it.effect("DELETE が 404（まだ無い）でも、元の失敗がそのまま返り、残っている旨は足さない", () => Effect.gen(function* () {
      const { s, result } = yield* run((c) => {
        if (isScriptPut(c)) return { status: 500, body: { success: false, errors: [{ code: 1, message: "boom-put" }], messages: [], result: null } };
        if (isScriptDelete(c)) return { status: 404, body: { success: false, errors: [{ code: 10007, message: "not found" }], messages: [], result: null } };
        return null;
      });

      expect(Result.isFailure(result)).toBe(true);
      expect(output(s, result)).toContain("boom-put");
      expect(output(s, result)).not.toContain("残っている");
    }));

    it.effect("DELETE も失敗しても、元の失敗の理由は置き換わらず、Worker 名と残っているかもしれない旨が足される", () => Effect.gen(function* () {
      const { s, result } = yield* run((c) => {
        if (isEnableSubdomain(c)) return { status: 500, body: { success: false, errors: [{ code: 1, message: "boom-enable" }], messages: [], result: null } };
        if (isScriptDelete(c)) return { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null } };
        return null;
      });

      expect(Result.isFailure(result)).toBe(true);
      const text = output(s, result);
      expect(text).toContain("boom-enable");
      expect(text).toContain(scriptName(s.api.calls.find(isScriptPut)!));
      expect(text).toContain("残っている");
      expect(text).not.toMatch(/権限/);
    }));

    it.effect("記録が書けない（~/.live-mindmap が通常ファイル）ときも、置いた Worker を消してから失敗で返す", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
      mkdirSync(s.home, { recursive: true });
      writeFileSync(join(s.home, ".live-mindmap"), "file");

      const result = yield* publish(s, ["--anyone"]);

      expect(Result.isFailure(result)).toBe(true);
      expect(s.api.calls.filter(isScriptDelete).map(scriptName)).toEqual([scriptName(s.api.calls.find(isScriptPut)!)]);
      expect(s.stdout.join("")).not.toContain("workers.dev");
    }));

    it.effect("script PUT の後、記録を書く前に中断されても、同じ名前の Worker を DELETE する。記録は無い", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
      const reached = yield* Deferred.make<void>();
      const inner = s.api.client;
      // workers.dev の有効化の要求だけ、到達を知らせて止める（PUT は済み、記録はまだ）
      const client = HttpClient.make((request) => {
        if (request.method === "POST" && /\/workers\/scripts\/[^/]+\/subdomain$/.test(new URL(request.url).pathname)) {
          return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never));
        }
        return inner.execute(request);
      });
      s.api = { ...s.api, client };

      const fiber = yield* Effect.forkChild(publish(s, ["--anyone"]));
      yield* Deferred.await(reached);
      yield* Fiber.interrupt(fiber);

      const put = s.api.calls.find(isScriptPut);
      expect(put).toBeDefined();
      expect(s.api.calls.filter(isScriptDelete).map(scriptName)).toEqual([scriptName(put!)]);
      expect(s.stdout.join("")).not.toContain("workers.dev");
      expect(recordRows(s)).toEqual([]);
    }));
  });

  describe("サーバーに頼らない", () => {
    it.effect("Cloudflare 以外には通信しない（要求はすべて api.cloudflare.com 向け）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
      const hosts: string[] = [];
      const inner = s.api.client;
      const client = HttpClient.make((request) => {
        hosts.push(new URL(request.url).host);
        return inner.execute(request);
      });
      s.api = { ...s.api, client };

      const result = yield* publish(s, ["--anyone"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(new Set(hosts)).toEqual(new Set(["api.cloudflare.com"]));
    }));
  });
});

describe("cli publish の既定は合言葉で暗号化して置く（Issue #1251）", () => {
  const passphraseOf = (s: Setup) => {
    const m = /合言葉:\s*(\S+)/.exec(s.stdout.join(""));
    expect(m, "stdout に「合言葉: …」の行が無い").not.toBeNull();
    return m![1]!;
  };
  const sealedOf = (outer: string) => {
    const m = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(outer);
    expect(m, "外側のページに暗号文の script が無い").not.toBeNull();
    return JSON.parse(m![1]!) as { salt: string; iv: string; data: string };
  };
  const placedDefault = (root: string, extra: Partial<Setup> = {}, argv: string[] = []) => {
    const s = setup(root, undefined, extra);
    writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
    return { s, run: publish(s, argv) };
  };

  it.effect("--anyone が無くても止まらずに置き、URL と合言葉を出す。受け取った HTML は stdout の合言葉で復号でき、マップだけの段（発言・画面の文字が無い）に戻る", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const { s, run } = placedDefault(root);

    const result = yield* run;

    expect(Result.isSuccess(result), failureText(result)).toBe(true);
    const name = scriptName(s.api.calls.find(isScriptPut)!);
    const out = s.stdout.join("");
    expect(out).toContain(`https://${name}.${SUBDOMAIN}.workers.dev`);
    const passphrase = passphraseOf(s);
    expect(passphrase).toMatch(/^[a-z0-9]{5}(-[a-z0-9]{5}){3}$/);
    expect(s.stderr.join("")).not.toContain(passphrase);

    const outer = yield* Effect.promise(() => uploadedHtml(s));
    const inner = yield* Effect.promise(() => openSealed(sealedOf(outer), passphrase));
    expect(inner).not.toContain(REMARK_TEXT);
    expect(inner).not.toContain(SCREEN_LINE);
    const embedded = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(inner);
    expect(embedded).not.toBeNull();
    const events = JSON.parse(embedded![1]!) as { type: string; remark?: { text: string }; lines?: string[] }[];
    expect(events.some((e) => e.type === "diff")).toBe(true);
    expect(events.filter((e) => e.type === "remark").every((e) => e.remark!.text === "")).toBe(true);
    expect(events.filter((e) => e.type === "screen").every((e) => e.lines === undefined)).toBe(true);
    // 違う合言葉では開けない
    yield* Effect.promise(() => expect(openSealed(sealedOf(outer), `${passphrase}x`)).rejects.toThrow());
    // manifest は外側のページのバイト数
    const session = s.api.calls.find((c) => c.path.endsWith("/assets-upload-session"))!;
    const manifest = (session.json as { manifest: Record<string, { size: number }> }).manifest;
    expect(Object.keys(manifest)).toEqual(["/index.html"]);
    expect(manifest["/index.html"]!.size).toBe(Buffer.byteLength(outer));
  }));

  it.effect("外側のページは入力欄 1 つと暗号文だけで、title とメタは決まった文。会議名・発言・画面の文字・見返しのログの埋め込みは平文に無い", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const named = `<!doctype html><html><head><title>${MEETING}</title><meta property="og:title" content="${MEETING}"><meta name="description" content="${MEETING}の議事"></head><body></body></html>`;
    const { s, run } = placedDefault(root, { template: named });

    yield* run;

    const outer = yield* Effect.promise(() => uploadedHtml(s));
    for (const secret of [MEETING, REMARK_TEXT, SCREEN_LINE, REVIEW_LOG_ELEMENT_ID, passphraseOf(s)]) expect(outer).not.toContain(secret);
    const titles = [...outer.matchAll(/<title>([\s\S]*?)<\/title>/g)];
    expect(titles).toHaveLength(1);
    expect(titles[0]![1]).toBe(PUBLISH_TITLE);
    const metas = [...outer.matchAll(/<meta\s[^>]*content="([^"]*)"[^>]*>/g)].map((m) => m[1]!);
    expect(metas.length).toBeGreaterThanOrEqual(2);
    for (const content of metas) expect(content.trim()).not.toBe("");
    expect(outer.match(/<input\b/g)).toHaveLength(1);
    // 復号した内側の title も決まった文
    const inner = yield* Effect.promise(() => openSealed(sealedOf(outer), passphraseOf(s)));
    expect(inner.match(/<title>/g)).toHaveLength(1);
    expect(inner).toContain(`<title>${PUBLISH_TITLE}</title>`);
  }));

  it.effect("記録には、既定では stdout と同じ合言葉と anyone: false が入る（0o600 のまま）。2 回置くと合言葉は異なる", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const { s, run } = placedDefault(root);

    yield* run;
    const first = passphraseOf(s);
    s.stdout.length = 0;
    yield* publish(s, []);
    const second = passphraseOf(s);

    const rows = recordRows(s);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ anyone: false, passphrase: first, level: "map", status: "published" });
    expect(rows[1]).toMatchObject({ anyone: false, passphrase: second });
    expect(first).not.toBe(second);
    expect(statSync(recordFiles(s)[0]!).mode & 0o777).toBe(0o600);
  }));

  it.effect("--anyone では合言葉の行を出さず、記録に passphrase の欄も無く、置く HTML は平文のマップのまま", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const { s, run } = placedDefault(root, {}, ["--anyone"]);

    yield* run;

    expect(s.stdout.join("")).not.toContain("合言葉");
    const rows = recordRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ anyone: true });
    expect("passphrase" in rows[0]!).toBe(false);
    expect(yield* Effect.promise(() => uploadedHtml(s))).toContain(REVIEW_LOG_ELEMENT_ID);
  }));

  it.effect("Cloudflare へ送るすべての要求（パス・クエリ・本文・Worker のスクリプト・メタデータ）に、合言葉も平文の中身も無い", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const { s, run } = placedDefault(root);

    yield* run;

    const passphrase = passphraseOf(s);
    const sent = yield* Effect.promise(async () => {
      const parts: string[] = [];
      for (const call of s.api.calls) {
        parts.push(call.path, call.search, call.text, JSON.stringify(call.headers));
        if (call.form !== null) for (const value of call.form.values()) parts.push(typeof value === "string" ? value : await value.text());
      }
      return parts.join("\n");
    });
    expect(sent.length).toBeGreaterThan(0);
    for (const secret of [passphrase, passphrase.replaceAll("-", ""), MEETING, REMARK_TEXT, SCREEN_LINE, REVIEW_LOG_ELEMENT_ID]) expect(sent).not.toContain(secret);
    const worker = yield* Effect.promise(() => uploadedWorker(s));
    expect(JSON.stringify(worker.metadata)).not.toContain(passphrase);
  }));

  it.effect("既定でも Worker の期限・クローラー拒否は同じ（期限の後は 410）", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const { s, run } = placedDefault(root);

    yield* run;

    const worker = yield* Effect.promise(() => uploadedWorker(s));
    expect((yield* Effect.promise(() => worker.call("/", "Mozilla/5.0", NOW + 7 * DAY))).status).toBe(410);
    expect((yield* Effect.promise(() => worker.call("/", "GPTBot/1.0"))).status).toBe(403);
    expect((yield* Effect.promise(() => worker.call("/", "Mozilla/5.0"))).status).toBe(200);
  }));
});

describe("cli publish list / withdraw（Issue #1253）", () => {
  const OTHER_ACCOUNT = "acct-other-999";
  const STILL_THERE = "まだ置き場にあります";
  const hour = (n: number) => new Date(NOW + n * 60 * 60 * 1000).toISOString();
  const rowOf = (name: string, over: Record<string, unknown> = {}) => ({
    name, url: `https://${name}.${SUBDOMAIN}.workers.dev`, accountId: ACCOUNT, dir: `/sessions/${name}-dir`, level: "map", anyone: false,
    passphrase: `pass-${name}`, publishedAt: hour(-24), expiresAt: hour(24), status: "published", ...over,
  });
  const seed = (s: Setup, rows: Record<string, unknown>[]) => {
    const directory = join(s.home, ".live-mindmap", "publish");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "records.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  };
  const recordPath = (s: Setup) => join(s.home, ".live-mindmap", "publish", "records.jsonl");
  const scriptsPath = `/client/v4/accounts/${ACCOUNT}/workers/scripts`;
  const deletes = (s: Setup) => s.api.calls.filter(isScriptDelete);
  const statusOf = (s: Setup, name: string) => recordRows(s).find((r) => r.name === name)?.status;
  const A = "lmm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "lmm-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const C = "lmm-cccccccccccccccccccccccccccccccc";

  describe("list", () => {
    it.effect("記録から URL・合言葉・期限・中身の段・元のセッション・状態を出す。--anyone の物は合言葉の欄が「なし」。資格情報が無ければ Cloudflare を呼ばない", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, undefined, { env: { CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" } });
      seed(s, [rowOf(A), rowOf(B, { anyone: true, passphrase: undefined, dir: "/sessions/anyone-dir" })]);

      const result = yield* publish(s, ["list"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const out = s.stdout.join("");
      for (const name of [A, B]) expect(out).toContain(`https://${name}.${SUBDOMAIN}.workers.dev`);
      expect(out).toContain(`pass-${A}`);
      expect(out).not.toContain(`pass-${B}`);
      expect(out).toContain(hour(24));
      expect(out).toContain("マップだけ");
      expect(out).toContain(`/sessions/${A}-dir`);
      expect(out).toContain("/sessions/anyone-dir");
      expect(out).toContain("公開中");
      expect(out).toContain("--anyone");
      expect(s.api.calls).toHaveLength(0);
    }));

    it.effect("既定は公開中だけ。期限切れで未削除の物は含め、取り下げた物は出さない", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A), rowOf(B, { expiresAt: hour(-1) }), rowOf(C, { status: "withdrawn" })]);

      const result = yield* publish(s, ["list"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const out = s.stdout.join("");
      expect(out).toContain(A);
      expect(out).toContain(B);
      expect(out).not.toContain(C);
      expect(out).toContain("期限切れ");
    }));

    it.effect("--all で取り下げた物も出し、状態は「取り下げた」", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A), rowOf(B, { expiresAt: hour(-1) }), rowOf(C, { status: "withdrawn" })]);

      const result = yield* publish(s, ["list", "--all"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const out = s.stdout.join("");
      for (const name of [A, B, C]) expect(out).toContain(name);
      const line = out.split("\n").find((l) => l.includes(C))!;
      expect(line).toContain("取り下げた");
      expect(out.split("\n").find((l) => l.includes(A))!).not.toContain("取り下げた");
    }));

    it.effect("資格情報があれば、記録に無い lmm- の Worker を知らせ、消さない。記録にある物・lmm- でない物は知らせない", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, {
        respond: (call) => (call.method === "GET" && call.path === scriptsPath ? ok([{ id: A }, { id: "lmm-orphan" }, { id: "other-worker" }]) : null),
      });
      seed(s, [rowOf(A), rowOf(C, { status: "withdrawn" })]);

      const result = yield* publish(s, ["list"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const warned = s.stderr.join("");
      expect(warned).toContain("lmm-orphan");
      expect(warned).not.toContain("other-worker");
      expect(warned).not.toContain(A);
      expect(s.stdout.join("")).not.toContain("lmm-orphan");
      expect(deletes(s)).toHaveLength(0);
      expect(s.api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    }));

    it.effect("取り下げた記録の名前も「記録にある」扱いで、知らせない", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, { respond: (call) => (call.method === "GET" && call.path === scriptsPath ? ok([{ id: C }]) : null) });
      seed(s, [rowOf(C, { status: "withdrawn" })]);

      const result = yield* publish(s, ["list"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(s.stderr.join("")).not.toContain(C);
    }));

    it.effect("Worker の一覧を取れなくても、記録の一覧は出して成功で返す（消さない）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, { respond: (call) => (call.method === "GET" && call.path === scriptsPath ? { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null } } : null) });
      seed(s, [rowOf(A)]);

      const result = yield* publish(s, ["list"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(s.stdout.join("")).toContain(A);
      expect(deletes(s)).toHaveLength(0);
    }));

    it.effect("ローカルモードのセッションが最新でも、サーバーが無くても、記録を出す", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      const dir = writeSession(s.sessions, "2026-10-01T00-00-00.000Z", MEETING, { local: true });
      seed(s, [rowOf(A, { dir })]);

      const result = yield* publish(s, ["list"]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(s.stdout.join("")).toContain(A);
    }));
  });

  describe("withdraw", () => {
    it.effect("名前で名指しすると、記録のアカウントの Worker を DELETE し、その行だけ withdrawn にする。行は残り、ほかの項目と 0o600 は保つ", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, undefined, { env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
      const first = rowOf(A, { accountId: OTHER_ACCOUNT });
      const second = rowOf(B);
      seed(s, [first, second]);

      const result = yield* publish(s, ["withdraw", A]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(deletes(s)).toHaveLength(1);
      expect(deletes(s)[0]!.path).toBe(`/client/v4/accounts/${OTHER_ACCOUNT}/workers/scripts/${A}`);
      expect(deletes(s)[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(recordRows(s)).toEqual([{ ...first, status: "withdrawn" }, second]);
      expect(statSync(recordPath(s)).mode & 0o777).toBe(0o600);
      expect(recordFiles(s)).toHaveLength(1);
      expect(s.stdout.join("")).toContain(first.url);
    }));

    it.effect("URL でも名指しできる（末尾の / があっても）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A), rowOf(B)]);

      const result = yield* publish(s, ["withdraw", `${rowOf(B).url}/`]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(deletes(s).map(scriptName)).toEqual([B]);
      expect(statusOf(s, B)).toBe("withdrawn");
      expect(statusOf(s, A)).toBe("published");
    }));

    it.effect("複数を渡すと、すべて消して全部 withdrawn にする。同じ物を 2 度渡しても DELETE は 1 回", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A), rowOf(B), rowOf(C)]);

      const result = yield* publish(s, ["withdraw", A, rowOf(A).url, B]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(deletes(s).map(scriptName).sort()).toEqual([A, B]);
      expect(statusOf(s, A)).toBe("withdrawn");
      expect(statusOf(s, B)).toBe("withdrawn");
      expect(statusOf(s, C)).toBe("published");
    }));

    it.effect("DELETE が 404（Cloudflare 側に既に無い）でも成功で、withdrawn にする", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, { respond: (call) => (isScriptDelete(call) ? { status: 404, body: { success: false, errors: [{ code: 10007, message: "workers.api.error.script_not_found" }], messages: [], result: null } } : null) });
      seed(s, [rowOf(A)]);

      const result = yield* publish(s, ["withdraw", A]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(deletes(s)).toHaveLength(1);
      expect(statusOf(s, A)).toBe("withdrawn");
    }));

    it.effect("期限切れで未削除の物も取り下げられる", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A, { expiresAt: hour(-5) })]);

      const result = yield* publish(s, ["withdraw", A]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(deletes(s)).toHaveLength(1);
      expect(statusOf(s, A)).toBe("withdrawn");
    }));

    it.effect("記録に無い名前だけを渡すと、DELETE せず 0 以外で返し、「まだ置き場にある」と --anyone の旨を出す。記録は変わらない", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A)]);
      const before = readFileSync(recordPath(s), "utf8");

      const result = yield* publish(s, ["withdraw", "lmm-unknown"]);

      expect(Result.isFailure(result)).toBe(true);
      expect(deletes(s)).toHaveLength(0);
      const text = output(s, result);
      expect(text).toContain(STILL_THERE);
      expect(text).toContain("--anyone");
      expect(text).toContain("lmm-unknown");
      expect(readFileSync(recordPath(s), "utf8")).toBe(before);
    }));

    it.effect("記録に無い URL を渡しても同じ（失敗で、DELETE 0 件）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A)]);

      const result = yield* publish(s, ["withdraw", `https://lmm-unknown.${SUBDOMAIN}.workers.dev`]);

      expect(Result.isFailure(result)).toBe(true);
      expect(deletes(s)).toHaveLength(0);
      expect(output(s, result)).toContain(STILL_THERE);
      expect(statusOf(s, A)).toBe("published");
    }));

    it.effect("記録にある物と無い物を混ぜると、ある物は取り下げ、全体は 0 以外で返す", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A)]);

      const result = yield* publish(s, ["withdraw", A, "lmm-unknown"]);

      expect(Result.isFailure(result)).toBe(true);
      expect(deletes(s).map(scriptName)).toEqual([A]);
      expect(statusOf(s, A)).toBe("withdrawn");
      expect(output(s, result)).toContain(STILL_THERE);
    }));

    it.effect("消すのに失敗した物があれば 0 以外で返し、その物は published のまま、ほかは withdrawn。「まだ置き場にある」を出す", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, { respond: (call) => (isScriptDelete(call) && scriptName(call) === B ? { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null } } : null) });
      seed(s, [rowOf(A), rowOf(B)]);

      const result = yield* publish(s, ["withdraw", A, B]);

      expect(Result.isFailure(result)).toBe(true);
      expect(deletes(s)).toHaveLength(2);
      expect(statusOf(s, A)).toBe("withdrawn");
      expect(statusOf(s, B)).toBe("published");
      const text = output(s, result);
      expect(text).toContain(STILL_THERE);
      expect(text).toContain("--anyone");
      expect(text).not.toContain("公開に失敗しました");
    }));

    it.effect("一部を消せた後に記録の書き換えに失敗しても、残る物があれば「まだ置き場にある」を出す", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A)]);
      // 記録のフォルダを書き込み不可にして、排他の取得と置き換えを失敗させる（読むことはできる）
      const directory = join(s.home, ".live-mindmap", "publish");
      chmodSync(directory, 0o500);

      const result = yield* publish(s, ["withdraw", A, "lmm-unknown"]).pipe(Effect.ensuring(Effect.sync(() => chmodSync(directory, 0o700))));

      expect(Result.isFailure(result)).toBe(true);
      const text = output(s, result);
      expect(text).toContain("記録を書き換えられませんでした");
      expect(text).toContain(STILL_THERE);
      expect(text).toContain("--anyone");
    }));

    it.effect("資格情報が無ければ、Cloudflare を呼ばずに 0 以外で返す。記録は変わらない", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root, undefined, { env: { CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" } });
      seed(s, [rowOf(A)]);

      const result = yield* publish(s, ["withdraw", A]);

      expect(Result.isFailure(result)).toBe(true);
      expect(s.api.calls).toHaveLength(0);
      expect(output(s, result)).toContain(STILL_THERE);
      expect(statusOf(s, A)).toBe("published");
    }));

    it.effect("まとめて取り下げる口・セッション単位の口は無い（引数なし・--all・セッションのフォルダ）。どれも失敗で DELETE 0 件、記録は変わらない", () => Effect.gen(function* () {
      for (const build of [() => [], () => ["--all"], (dir: string) => [dir]]) {
        const root = yield* temporaryDirectory;
        const s = setup(root);
        const row = rowOf(A);
        seed(s, [row, rowOf(B)]);
        const before = readFileSync(recordPath(s), "utf8");

        const result = yield* publish(s, ["withdraw", ...build(String(row.dir))]);

        expect(Result.isFailure(result)).toBe(true);
        expect(deletes(s)).toHaveLength(0);
        expect(readFileSync(recordPath(s), "utf8")).toBe(before);
      }
    }));

    it.effect("ローカルモードのセッションが最新でも、サーバーが無くても取り下げられる", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      const dir = writeSession(s.sessions, "2026-10-01T00-00-00.000Z", MEETING, { local: true });
      seed(s, [rowOf(A, { dir })]);

      const result = yield* publish(s, ["withdraw", A]);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(deletes(s)).toHaveLength(1);
      expect(statusOf(s, A)).toBe("withdrawn");
    }));
  });

  describe("記録ファイルの更新はプロセス間で排他する", () => {
    // 別のプロセスが records.jsonl.lock を持っている状態で操作を始める。操作がロックを待つことを確かめてから、
    // 持ち主として記録を書き換えて解放する。排他が無いと、待たずに先に終わる
    const whileLockHeld = (s: Setup, argv: string[], holderUpdate: () => void) => Effect.gen(function* () {
      const lock = `${recordPath(s)}.lock`;
      mkdirSync(lock, { recursive: true });
      const waiting = yield* Deferred.make<void>();
      const observe = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return FileSystem.FileSystem.of({
          ...fs,
          makeDirectory: (directory, options) => fs.makeDirectory(directory, options).pipe(
            Effect.tapError((error) => directory === lock && error.reason._tag === "AlreadyExists" ? Deferred.succeed(waiting, undefined) : Effect.void),
          ),
        });
      });
      yield* TestClock.setTime(NOW);
      const fiber = yield* Effect.result(runCli(["publish", ...argv]).pipe(
        Effect.provideServiceEffect(FileSystem.FileSystem, observe),
        Effect.provide(layerOf(s)),
      )).pipe(Effect.forkChild);
      const first = yield* Effect.raceFirst(
        Effect.as(Deferred.await(waiting), "waiting" as const),
        Effect.as(Fiber.join(fiber), "finished" as const),
      );
      expect(first).toBe("waiting");
      holderUpdate();
      rmSync(lock, { recursive: true });
      yield* TestClock.adjust(10);
      return yield* Fiber.join(fiber);
    });
    const append = (s: Setup, row: Record<string, unknown>) => () => { appendFileSync(recordPath(s), JSON.stringify(row) + "\n"); };

    it.effect("取り下げの途中で別のプロセスが追記しても、その行と取り下げの状態の両方が残る", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A)]);

      const result = yield* whileLockHeld(s, ["withdraw", A], append(s, rowOf(B)));

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(recordRows(s)).toEqual([{ ...rowOf(A), status: "withdrawn" }, rowOf(B)]);
      expect(statSync(recordPath(s)).mode & 0o777).toBe(0o600);
    }));

    it.effect("取り下げが重なっても、両方の状態変更が残り、一時ファイルは残らない", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      seed(s, [rowOf(A), rowOf(B)]);
      const other = () => { writeFileSync(recordPath(s), [rowOf(A), rowOf(B, { status: "withdrawn" })].map((r) => JSON.stringify(r)).join("\n") + "\n"); };

      const result = yield* whileLockHeld(s, ["withdraw", A], other);

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      expect(recordRows(s).map((r) => [r.name, r.status])).toEqual([[A, "withdrawn"], [B, "withdrawn"]]);
      expect(recordFiles(s)).toHaveLength(1);
      expect(statSync(recordPath(s)).mode & 0o777).toBe(0o600);
    }));

    it.effect("公開の途中で別のプロセスが追記しても、元の行と新しい行の両方が残る", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");
      seed(s, [rowOf(A)]);

      const result = yield* whileLockHeld(s, [], append(s, rowOf(B)));

      expect(Result.isSuccess(result), failureText(result)).toBe(true);
      const rows = recordRows(s);
      expect(rows).toHaveLength(3);
      expect(rows.slice(0, 2)).toEqual([rowOf(A), rowOf(B)]);
      expect(statSync(recordPath(s)).mode & 0o777).toBe(0o600);
    }));
  });

  describe("既存の cli publish を保つ", () => {
    it.effect("置いた直後の記録は list に出て、withdraw で取り下げられる（publish → list → withdraw → list）", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const s = setup(root);
      writeSession(s.sessions, "2026-10-01T00-00-00.000Z");

      const placed = yield* publish(s, []);
      expect(Result.isSuccess(placed), failureText(placed)).toBe(true);
      const name = scriptName(s.api.calls.find(isScriptPut)!);
      s.stdout.length = 0;

      const listed = yield* publish(s, ["list"]);
      expect(Result.isSuccess(listed), failureText(listed)).toBe(true);
      expect(s.stdout.join("")).toContain(name);

      const withdrawn = yield* publish(s, ["withdraw", name]);
      expect(Result.isSuccess(withdrawn), failureText(withdrawn)).toBe(true);
      expect(statusOf(s, name)).toBe("withdrawn");
      s.stdout.length = 0;

      yield* publish(s, ["list"]);
      expect(s.stdout.join("")).not.toContain(name);
      yield* publish(s, ["list", "--all"]);
      expect(s.stdout.join("")).toContain(name);
    }));
  });
});
