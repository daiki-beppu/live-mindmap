import { createHash, randomBytes } from "node:crypto";
import { Effect, Predicate, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

const API = "https://api.cloudflare.com/client/v4";
const COMPATIBILITY_DATE = "2026-10-01";
const ASSET_PATH = "/index.html";

export type CloudflareCredentials = { readonly accountId: string; readonly token: string };

export class CloudflareFailed extends Schema.TaggedError<CloudflareFailed>()("CloudflareFailed", {
  kind: Schema.Literals(["permission", "noSubdomain", "workerLimit", "other"]),
  detail: Schema.String,
}) {}

const Envelope = Schema.Struct({
  // Cloudflare の成功応答は errors: null を返す（公式の Direct Upload の例）。null は「エラーなし」として受ける
  errors: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ code: Schema.optionalKey(Schema.Finite), message: Schema.optionalKey(Schema.String) })))),
  result: Schema.optionalKey(Schema.Unknown),
});
type Envelope = typeof Envelope.Type;

const detailOf = (status: number, envelope: Envelope): string => {
  const messages = (envelope.errors ?? []).map((e) => e.message).filter(Predicate.isString);
  return messages.length > 0 ? messages.join(" / ") : `HTTP ${status}`;
};

export const classifyFailure = (status: number, envelope: Envelope): CloudflareFailed => {
  const errors = envelope.errors ?? [];
  const detail = detailOf(status, envelope);
  const has = (code: number) => errors.some((e) => e.code === code);
  const mentions = (pattern: RegExp) => errors.some((e) => pattern.test(e.message ?? ""));
  if (has(10027) || mentions(/maximum number of workers/i)) return new CloudflareFailed({ kind: "workerLimit", detail });
  if (status === 401 || status === 403 || has(10000)) return new CloudflareFailed({ kind: "permission", detail });
  if (has(10007) || (status === 404 && mentions(/subdomain/i))) return new CloudflareFailed({ kind: "noSubdomain", detail });
  return new CloudflareFailed({ kind: "other", detail });
};

export const describeCloudflareFailure = (failure: CloudflareFailed, operation = "公開"): string => {
  switch (failure.kind) {
    case "permission":
      return `Cloudflare の権限が足りません。API トークンに Workers の編集（Workers Admin）の権限があるか確かめてください（${failure.detail}）`;
    case "noSubdomain":
      return `このアカウントには workers.dev のサブドメインがありません。Cloudflare のダッシュボードの Workers & Pages で作ってください（${failure.detail}）`;
    case "workerLimit":
      return `Cloudflare アカウントの Worker の数が上限に達しています。使っていない Worker を消してください（${failure.detail}）`;
    case "other":
      return `Cloudflare への${operation}に失敗しました: ${failure.detail}`;
  }
};

type Call = { readonly method: "GET" | "POST" | "PUT" | "DELETE"; readonly path: string; readonly bearer: string; readonly search?: string; readonly json?: object; readonly form?: FormData };

const send = Effect.fnUntraced(function* (call: Call, accepted: readonly number[] = []) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.make(call.method)(`${API}${call.path}${call.search ?? ""}`, { headers: { authorization: `Bearer ${call.bearer}` } });
  const request = call.form !== undefined ? HttpClientRequest.bodyFormData(base, call.form) : call.json !== undefined ? HttpClientRequest.bodyJsonUnsafe(base, call.json) : base;
  const response: HttpClientResponse.HttpClientResponse = yield* client.execute(request).pipe(
    Effect.mapError((e) => new CloudflareFailed({ kind: "other", detail: e.message })),
  );
  const raw = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
  const envelope = yield* Schema.decodeUnknownEffect(Envelope)(raw).pipe(Effect.orElseSucceed((): Envelope => ({})));
  if ((response.status >= 200 && response.status < 300) || accepted.includes(response.status)) return { status: response.status, result: envelope.result };
  return yield* classifyFailure(response.status, envelope);
});

const accountPath = (credentials: CloudflareCredentials, rest: string) => `/accounts/${encodeURIComponent(credentials.accountId)}${rest}`;
const scriptPath = (credentials: CloudflareCredentials, name: string) => accountPath(credentials, `/workers/scripts/${encodeURIComponent(name)}`);

const SubdomainResult = Schema.Struct({ subdomain: Schema.NonEmptyString });
const UploadSession = Schema.Struct({ jwt: Schema.String, buckets: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))) });
const UploadDone = Schema.Struct({ jwt: Schema.String });
const malformed = (what: string) => new CloudflareFailed({ kind: "other", detail: `${what}の応答が読めません` });

export const accountSubdomain = Effect.fnUntraced(function* (credentials: CloudflareCredentials) {
  const { result } = yield* send({ method: "GET", path: accountPath(credentials, "/workers/subdomain"), bearer: credentials.token });
  const decoded = yield* Schema.decodeUnknownEffect(SubdomainResult)(result).pipe(
    Effect.mapError(() => new CloudflareFailed({ kind: "noSubdomain", detail: "サブドメインが返りませんでした" })),
  );
  return decoded.subdomain;
});

export const newWorkerName = (): string => `lmm-${randomBytes(16).toString("hex")}`;

// Direct Upload の hash は、base64 の中身と拡張子から作る 32 桁の 16 進
const assetHash = (base64: string): string => createHash("sha256").update(base64 + "html").digest("hex").slice(0, 32);

export const deployWorker = Effect.fnUntraced(function* (credentials: CloudflareCredentials, name: string, html: string, workerSource: string) {
  const content = Buffer.from(html, "utf8").toString("base64");
  const hash = assetHash(content);
  const session = yield* send({
    method: "POST",
    path: `${scriptPath(credentials, name)}/assets-upload-session`,
    bearer: credentials.token,
    json: { manifest: { [ASSET_PATH]: { hash, size: Buffer.byteLength(html, "utf8") } } },
  });
  const uploadSession = yield* Schema.decodeUnknownEffect(UploadSession)(session.result).pipe(Effect.mapError(() => malformed("アセットのアップロード開始")));
  let completionJwt = uploadSession.jwt;
  if ((uploadSession.buckets ?? []).some((bucket) => bucket.length > 0)) {
    const form = new FormData();
    // パートの Content-Type は、Worker が配信するときの Content-Type になる。型なしの文字列だと HTML として配信されない
    form.append(hash, new Blob([content], { type: "text/html" }), hash);
    const uploaded = yield* send({ method: "POST", path: accountPath(credentials, "/workers/assets/upload"), search: "?base64=true", bearer: uploadSession.jwt, form });
    completionJwt = (yield* Schema.decodeUnknownEffect(UploadDone)(uploaded.result).pipe(Effect.mapError(() => malformed("アセットのアップロード")))).jwt;
  }
  const metadata = {
    main_module: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    assets: { jwt: completionJwt, config: { run_worker_first: true } },
    bindings: [{ type: "assets", name: "ASSETS" }],
  };
  const script = new FormData();
  script.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  script.append("worker.js", new Blob([workerSource], { type: "application/javascript+module" }), "worker.js");
  yield* send({ method: "PUT", path: scriptPath(credentials, name), bearer: credentials.token, form: script });
  yield* send({ method: "POST", path: `${scriptPath(credentials, name)}/subdomain`, bearer: credentials.token, json: { enabled: true, previews_enabled: false } });
});

export const deleteWorker = (credentials: CloudflareCredentials, name: string) =>
  send({ method: "DELETE", path: scriptPath(credentials, name), search: "?force=true", bearer: credentials.token }, [404]).pipe(Effect.asVoid);

const WorkerList = Schema.Array(Schema.Struct({ id: Schema.String }));

export const listWorkerNames = Effect.fnUntraced(function* (credentials: CloudflareCredentials) {
  const { result } = yield* send({ method: "GET", path: accountPath(credentials, "/workers/scripts"), bearer: credentials.token });
  const workers = yield* Schema.decodeUnknownEffect(WorkerList)(result).pipe(Effect.mapError(() => malformed("Worker の一覧")));
  return workers.map((worker) => worker.id);
});

export const workerUrl = (name: string, subdomain: string): string => `https://${name}.${subdomain}.workers.dev`;
