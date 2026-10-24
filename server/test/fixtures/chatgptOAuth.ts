import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vitest";
import { classification, completedSse } from "./chatgpt.ts";

export type InvalidOAuth = "state" | "signature" | "issuer" | "audience" | "nonce" | "expired";
type OAuthOptions = { invalid?: InvalidOAuth; holdCallback?: boolean; afterResponse?: (call: number) => void };

type OAuthState = {
  options: OAuthOptions;
  key: { privateKey: KeyObject };
  wrongKey: { privateKey: KeyObject };
  jwk: Record<string, unknown> & { kid: string };
  authorizations: URL[];
  exchanges: URLSearchParams[];
  responses: { path: string; authorization: string | undefined; body: Record<string, unknown> }[];
  checks: boolean[];
  control: { ineligible: boolean; refreshExpired: boolean };
};

function handleAuthorize(state: OAuthState, url: URL, res: ServerResponse): void {
  state.authorizations.push(url);
  if (state.options.holdCallback) {
    res.writeHead(200).end("synthetic authorization pending");
    return;
  }
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", state.options.invalid === "state" ? "wrong-state" : url.searchParams.get("state")!);
  callback.searchParams.set("client_id", "synthetic-client");
  callback.searchParams.set("code", "synthetic-code");
  res.writeHead(302, { location: callback.href }).end();
}

function exchangeMatches(form: URLSearchParams, authorization: URL): boolean {
  return form.get("client_id") === "synthetic-client"
    && form.get("code") === "synthetic-code"
    && form.get("redirect_uri") === authorization.searchParams.get("redirect_uri")
    && createHash("sha256").update(form.get("code_verifier")!).digest("base64url") === authorization.searchParams.get("code_challenge");
}

function idToken(state: OAuthState, authorization: URL): string {
  const { invalid } = state.options;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: invalid === "issuer" ? "https://wrong.invalid" : "https://auth.openai.com",
    aud: invalid === "audience" ? "wrong-client" : "synthetic-client",
    nonce: invalid === "nonce" ? "wrong-nonce" : authorization.searchParams.get("nonce"),
    sub: "synthetic-user", iat: now - 10, exp: invalid === "expired" ? now - 1 : now + 3600,
  };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: state.jwk.kid, typ: "JWT" })).toString("base64url");
  const encoded = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = sign("RSA-SHA256", Buffer.from(encoded), invalid === "signature" ? state.wrongKey.privateKey : state.key.privateKey).toString("base64url");
  return `${encoded}.${signature}`;
}

function handleToken(state: OAuthState, text: string, res: ServerResponse): void {
  const form = new URLSearchParams(text);
  state.exchanges.push(form);
  if (form.get("grant_type") === "refresh_token" && state.control.refreshExpired) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
    return;
  }
  const authorization = state.authorizations.at(-1)!;
  if (form.get("grant_type") === "authorization_code") state.checks.push(exchangeMatches(form, authorization));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id_token: idToken(state, authorization), access_token: "synthetic-access", refresh_token: "synthetic-refresh",
    token_type: "Bearer", expires_in: 3600, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  }));
}

function handleResponses(state: OAuthState, req: IncomingMessage, url: URL, text: string, res: ServerResponse): void {
  const body = JSON.parse(text) as Record<string, unknown>;
  state.responses.push({ path: url.pathname, authorization: req.headers.authorization, body });
  state.options.afterResponse?.(state.responses.length);
  if (state.control.ineligible) {
    res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible" } }));
    return;
  }
  const schema = body.text as { format: { schema: { properties: { 文: { maxItems: number } } } } };
  const answer = classification(Array.from({ length: schema.format.schema.properties.文.maxItems }, () => ({ 種類: "説明", text: "採用の進め方" })));
  res.writeHead(200, { "content-type": "text/event-stream" }).end(completedSse(answer));
}

function respondToBody(state: OAuthState, req: IncomingMessage, url: URL, text: string, res: ServerResponse): void {
  if (url.pathname === "/api/accounts/oauth/token") handleToken(state, text, res);
  else if (url.pathname === "/v1/responses") handleResponses(state, req, url, text, res);
  else res.writeHead(404).end();
}

function route(state: OAuthState, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, "http://127.0.0.1");
  if (url.pathname === "/api/accounts/authorize") {
    handleAuthorize(state, url, res);
    return;
  }
  if (url.pathname === "/.well-known/jwks.json") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [state.jwk] }));
    return;
  }
  let text = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => { text += chunk; });
  req.on("end", () => respondToBody(state, req, url, text, res));
}

export const fakeChatgptOAuth = Effect.fnUntraced(function* (options: OAuthOptions) {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "synthetic-key", use: "sig", alg: "RS256" };
  const authorizations: URL[] = [];
  const exchanges: URLSearchParams[] = [];
  const responses: OAuthState["responses"] = [];
  const browserCommands: ChildProcess.StandardCommand[] = [];
  const checks: boolean[] = [];
  const control = { ineligible: false, refreshExpired: false };
  const state: OAuthState = { options, key, wrongKey, jwk, authorizations, exchanges, responses, checks, control };
  const server = createServer((req, res) => route(state, req, res));
  yield* Effect.acquireRelease(Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  })), () => Effect.promise(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("偽 OAuth のポートがありません");
  const origin = `http://127.0.0.1:${address.port}`;
  const rewrite = (url: string) => {
    const parsed = new URL(url);
    if (["auth.openai.com", "api.openai.com"].includes(parsed.hostname)) return `${origin}${parsed.pathname}${parsed.search}`;
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") return url;
    throw new Error("テストから外部の宛先へ接続しようとしました");
  };
  const fetchOriginal = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (input instanceof Request) return fetchOriginal(new Request(rewrite(input.url), input), init);
    return fetchOriginal(rewrite(String(input)), init);
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => fetchSpy.mockRestore()));
  const realClient = yield* HttpClient.HttpClient;
  const client = realClient.pipe(HttpClient.mapRequest((request) => HttpClientRequest.setUrl(request, rewrite(request.url))));
  const browser = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => Effect.gen(function* () {
    if (command._tag !== "StandardCommand") throw new Error("ブラウザは単一コマンドで起動する必要があります");
    browserCommands.push(command);
    const url = command.args.find((arg) => /^https?:\/\//.test(arg));
    if (!url) throw new Error("認可 URL がありません");
    yield* Effect.promise(() => fetchOriginal(rewrite(url)));
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: undefined as never,
      stdout: Stream.empty, stderr: Stream.empty, all: Stream.empty,
      getInputFd: () => undefined as never, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
    });
  })));
  return { client, browser, authorizations, exchanges, responses, browserCommands, checks, control };
});
