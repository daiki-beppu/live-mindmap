import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { Clock, Context, Deferred, Duration, Effect, FileSystem, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { authPath, chatgptRefusal, readCredentials, withAuthLock, writeAuthFile, ChatgptUnavailable, type Credentials } from "./chatgptAuthStore.ts";

export const ChatgptEndpoints = Context.Reference("live-mindmap/ChatgptEndpoints", {
  defaultValue: () => ({
    authorize: "https://auth.openai.com/api/accounts/authorize",
    token: "https://auth.openai.com/api/accounts/oauth/token",
    jwks: "https://auth.openai.com/.well-known/jwks.json",
    issuer: "https://auth.openai.com", resource: "https://api.openai.com/v1",
    responses: "https://api.openai.com/v1/responses",
    loginTimeout: Duration.minutes(5),
  }),
});
const Token = Schema.Struct({
  access_token: Schema.NonEmptyString, refresh_token: Schema.optionalKey(Schema.NonEmptyString),
  id_token: Schema.optionalKey(Schema.NonEmptyString),
  expires_in: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  scope: Schema.optionalKey(Schema.String),
});
const LOGIN_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const Claims = Schema.Struct({ sub: Schema.NonEmptyString, nonce: Schema.NonEmptyString, exp: Schema.Finite,
  email: Schema.optionalKey(Schema.String) });

const tokenRequest = Effect.fnUntraced(function* (form: Record<string, string>) {
  const endpoints = yield* ChatgptEndpoints;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const response = yield* client.execute(HttpClientRequest.post(endpoints.token).pipe(
    HttpClientRequest.bodyText(new URLSearchParams(form).toString(), "application/x-www-form-urlencoded"),
  ));
  if (response.status < 200 || response.status >= 300) return yield* chatgptRefusal("ChatGPT のトークンが期限切れか、利用できません");
  return yield* HttpClientResponse.schemaBodyJson(Token)(response);
}, Effect.scoped, Effect.timeout("30 seconds"), Effect.mapError(() => chatgptRefusal("ChatGPT のトークンが期限切れか、利用できません")));

const renewed = Effect.fnUntraced(function* (previous: Credentials, token: typeof Token.Type) {
  const now = yield* Clock.currentTimeMillis;
  return {
    ...previous, access_token: token.access_token,
    refresh_token: token.refresh_token ?? previous.refresh_token,
    // 更新応答の ID token は認証済み identity の代わりに使わない。
    scopes: token.scope === undefined ? previous.scopes : token.scope.split(" ").filter(Boolean),
    expires_at: now + token.expires_in * 1000, saved_at: new Date(now).toISOString(),
  } satisfies Credentials;
});

export const accessToken = Effect.fnUntraced(function* (path: string) {
  const endpoints = yield* ChatgptEndpoints;
  if ((yield* readCredentials(path)) === undefined) return yield* chatgptRefusal("ChatGPT にサインインしていません");
  return yield* withAuthLock(path, Effect.gen(function* () {
    const previous = yield* readCredentials(path);
    if (previous === undefined) return yield* chatgptRefusal("ChatGPT にサインインしていません");
    if (!previous.scopes.includes("chatgpt.tokens.use.direct")) return yield* chatgptRefusal("ChatGPT のプラン利用が許可されていません");
    const now = yield* Clock.currentTimeMillis;
    if (now < previous.expires_at - 300_000) return previous.access_token;
    const token = yield* tokenRequest({ grant_type: "refresh_token", client_id: previous.client_id,
      refresh_token: previous.refresh_token, resource: endpoints.resource });
    const credentials = yield* renewed(previous, token);
    if (!credentials.scopes.includes("chatgpt.tokens.use.direct")) return yield* chatgptRefusal("ChatGPT のプラン利用が許可されていません");
    yield* writeAuthFile(path, JSON.stringify(credentials));
    return credentials.access_token;
  }));
}, Effect.catchIf((error) => error._tag !== "ChatgptUnavailable", () => Effect.fail(chatgptRefusal("ChatGPT の資格情報を読み込み・保存できません"))));

export const loginChatgpt = Effect.gen(function* () {
  const endpoints = yield* ChatgptEndpoints;
  const path = yield* authPath;
  const fs = yield* FileSystem.FileSystem;
  const registration = yield* withAuthLock(path, Effect.gen(function* () {
    const hostPath = join(dirname(path), "chatgpt-host-id");
    let host = yield* fs.readFileString(hostPath).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
    if (host === undefined) {
      host = `urn:uuid:${randomUUID()}`;
      yield* writeAuthFile(hostPath, host);
    }
    const previous = yield* readCredentials(path);
    return { host, previous };
  }));
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const callback = yield* Deferred.make<URLSearchParams>();
  const server = yield* Effect.acquireRelease(Effect.sync(() => createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/auth/callback") { response.writeHead(404).end(); return; }
    Deferred.doneUnsafe(callback, Effect.succeed(url.searchParams));
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("live-mindmap: サインインを受け取りました。このタブは閉じてかまいません。");
  })), (server) => Effect.promise(() => new Promise<void>((resolve) => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
  yield* Effect.callback<void, Error>((resume) => {
    const failed = (error: Error) => resume(Effect.fail(error));
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => { server.off("error", failed); resume(Effect.void); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") return yield* chatgptRefusal("ChatGPT の認可結果を受信できません");
  const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
  const query = new URLSearchParams({
    client_id: registration.previous?.client_id ?? "dynamic_agent_client",
    ...(registration.previous === undefined ? { agent_name_hint: "live-mindmap" } : { id_token_hint: registration.previous.id_token }),
    ext_agent_host_id: registration.host, response_type: "code", redirect_uri: redirect,
    scope: LOGIN_SCOPE, resource: endpoints.resource, state, nonce,
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const browser = yield* spawner.spawn(ChildProcess.make("open", [`${endpoints.authorize}?${query}`]));
  const exit = yield* browser.exitCode;
  if (exit !== 0) return yield* chatgptRefusal("ChatGPT のサインイン画面を開けません");
  const result = yield* Deferred.await(callback).pipe(Effect.timeout(endpoints.loginTimeout));
  if (result.get("state") !== state || result.has("error")) return yield* chatgptRefusal("ChatGPT の認可結果が不正です");
  const clientId = result.get("client_id") ?? registration.previous?.client_id;
  const code = result.get("code");
  if (!clientId || clientId === "dynamic_agent_client" || !code || (registration.previous !== undefined && clientId !== registration.previous.client_id)) {
    return yield* chatgptRefusal("ChatGPT の認可結果が不正です");
  }
  const token = yield* tokenRequest({ grant_type: "authorization_code", client_id: clientId, code,
    code_verifier: verifier, redirect_uri: redirect, resource: endpoints.resource });
  if (token.id_token === undefined || token.refresh_token === undefined || token.scope === undefined) return yield* chatgptRefusal("ChatGPT の認証応答が不正です");
  const now = yield* Clock.currentTimeMillis;
  const verified = yield* Effect.tryPromise({
    try: (signal) => jwtVerify(token.id_token!, createRemoteJWKSet(new URL(endpoints.jwks), {
      timeoutDuration: 10_000,
      [customFetch]: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, signal]) }),
    }), {
      issuer: endpoints.issuer, audience: clientId, algorithms: ["RS256"], requiredClaims: ["exp", "sub", "nonce"], currentDate: new Date(now),
    }).then((value) => { signal.throwIfAborted(); return value; }),
    catch: () => chatgptRefusal("ChatGPT の ID トークンを検証できません"),
  });
  const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload);
  if (claims.nonce !== nonce) return yield* chatgptRefusal("ChatGPT の ID トークンを検証できません");
  const credentials: Credentials = {
    client_id: clientId, ext_agent_host_id: registration.host, subject: claims.sub,
    ...(claims.email === undefined ? {} : { email: claims.email }), id_token: token.id_token,
    access_token: token.access_token, refresh_token: token.refresh_token,
    scopes: token.scope.split(" ").filter(Boolean), expires_at: now + token.expires_in * 1000, saved_at: new Date(now).toISOString(),
  };
  yield* withAuthLock(path, writeAuthFile(path, JSON.stringify(credentials)));
}).pipe(Effect.scoped, Effect.timeout("5 minutes"), Effect.catchIf((error) => !(error instanceof ChatgptUnavailable), () => Effect.fail(chatgptRefusal("ChatGPT のサインインを完了できません"))));
