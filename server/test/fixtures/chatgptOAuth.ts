import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vitest";
import { classification, completedSse } from "./chatgpt.ts";

export type InvalidOAuth = "state" | "signature" | "issuer" | "audience" | "nonce" | "expired";
export const fakeChatgptOAuth = Effect.fnUntraced(function* (options: { invalid?: InvalidOAuth; holdCallback?: boolean; afterResponse?: (call: number) => void }) {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "synthetic-key", use: "sig", alg: "RS256" };
  const authorizations: URL[] = [];
  const exchanges: URLSearchParams[] = [];
  const responses: { path: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const browserCommands: ChildProcess.StandardCommand[] = [];
  const checks: boolean[] = [];
  const control = { ineligible: false, refreshExpired: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname === "/api/accounts/authorize") {
      authorizations.push(url);
      if (options.holdCallback) {
        res.writeHead(200).end("synthetic authorization pending");
        return;
      }
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", options.invalid === "state" ? "wrong-state" : url.searchParams.get("state")!);
      callback.searchParams.set("client_id", "synthetic-client");
      callback.searchParams.set("code", "synthetic-code");
      res.writeHead(302, { location: callback.href }).end();
      return;
    }
    if (url.pathname === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { text += chunk; });
    req.on("end", () => {
      if (url.pathname === "/api/accounts/oauth/token") {
        const form = new URLSearchParams(text);
        exchanges.push(form);
        if (form.get("grant_type") === "refresh_token" && control.refreshExpired) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const authorization = authorizations.at(-1)!;
        if (form.get("grant_type") === "authorization_code") {
          checks.push(form.get("client_id") === "synthetic-client"
            && form.get("code") === "synthetic-code"
            && form.get("redirect_uri") === authorization.searchParams.get("redirect_uri")
            && createHash("sha256").update(form.get("code_verifier")!).digest("base64url") === authorization.searchParams.get("code_challenge"));
        }
        const now = Math.floor(Date.now() / 1000);
        const payload = {
          iss: options.invalid === "issuer" ? "https://wrong.invalid" : "https://auth.openai.com",
          aud: options.invalid === "audience" ? "wrong-client" : "synthetic-client",
          nonce: options.invalid === "nonce" ? "wrong-nonce" : authorization.searchParams.get("nonce"),
          sub: "synthetic-user", iat: now - 10, exp: options.invalid === "expired" ? now - 1 : now + 3600,
        };
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" })).toString("base64url");
        const encoded = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
        const signature = sign("RSA-SHA256", Buffer.from(encoded), options.invalid === "signature" ? wrongKey.privateKey : key.privateKey).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          id_token: `${encoded}.${signature}`, access_token: "synthetic-access", refresh_token: "synthetic-refresh",
          token_type: "Bearer", expires_in: 3600, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        }));
        return;
      }
      if (url.pathname === "/v1/responses") {
        const body = JSON.parse(text) as Record<string, unknown>;
        responses.push({ path: url.pathname, authorization: req.headers.authorization, body });
        options.afterResponse?.(responses.length);
        if (control.ineligible) {
          res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible" } }));
          return;
        }
        const schema = body.text as { format: { schema: { properties: { 文: { maxItems: number } } } } };
        const answer = classification(Array.from({ length: schema.format.schema.properties.文.maxItems }, () => ({ 種類: "説明", text: "採用の進め方" })));
        res.writeHead(200, { "content-type": "text/event-stream" }).end(completedSse(answer));
        return;
      }
      res.writeHead(404).end();
    });
  });
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
