import { ByteSize, Effect, FileSystem, Option, PlatformError } from "effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

export const CHATGPT_HOME = "/synthetic-home";
export const chatgptCredentials = (expiresAt: number) => ({
  client_id: "synthetic-client", ext_agent_host_id: "urn:uuid:synthetic-installation", subject: "synthetic-user",
  id_token: "synthetic-id-token", access_token: "synthetic-access", refresh_token: "synthetic-refresh",
  scopes: ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
  expires_at: expiresAt, saved_at: "1970-01-01T00:00:00.000Z",
});
export const chatgptAuthPath = (home: string) => `${home}/.live-mindmap/auth/chatgpt.json`;
export const CHATGPT_MODEL = { name: "subscription", route: "chatgpt" as const, model: "synthetic-model", local: false as const, images: false };

export const jsonRequestBody = (request: HttpClientRequest.HttpClientRequest): Record<string, unknown> => {
  if (request.body._tag === "Uint8Array") return JSON.parse(new TextDecoder().decode(request.body.body));
  if (request.body._tag === "Raw" && typeof request.body.body === "string") return JSON.parse(request.body.body);
  throw new Error("JSON body がありません");
};
export const encodedRequestBody = (request: HttpClientRequest.HttpClientRequest): string => {
  if (request.body._tag === "Uint8Array") return new TextDecoder().decode(request.body.body);
  if (request.body._tag === "Raw" && typeof request.body.body === "string") return request.body.body;
  throw new Error("文字列 body がありません");
};
export const classification = (sentences: readonly object[]) => ({ 議題: { id: "新しい議題", 題: "採用" }, 文: sentences, 済み: "なし" });
export const sseEvent = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
export const completedSse = (answer: unknown) => sseEvent({ type: "response.output_text.delta", delta: JSON.stringify(answer) })
  + sseEvent({ type: "response.completed", response: { id: "synthetic-response", status: "completed" } });

export const fakeChatgptHttp = (reply: (request: HttpClientRequest.HttpClientRequest, call: number) => Response | Effect.Effect<Response>) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) => Effect.gen(function* () {
    requests.push(request);
    const response = reply(request, requests.length);
    return HttpClientResponse.fromWeb(request, response instanceof Response ? response : yield* response);
  }));
  return { client, requests };
};

// FileSystem の境界で mode と rename を観測する。未定義の操作は makeNoop が失敗させる。
export const fakeChatgptFiles = (initial: ReturnType<typeof chatgptCredentials>) => {
  const authPath = chatgptAuthPath(CHATGPT_HOME);
  const files = new Map<string, { text: string; mode: number }>([[authPath, { text: JSON.stringify(initial), mode: 0o600 }]]);
  const directories = new Set<string>();
  const writes: { path: string; mode: number }[] = [];
  const renames: { from: string; to: string; mode: number }[] = [];
  const control = { failRename: false, failWrite: false };
  const failure = (method: string, path: string, reason: PlatformError.SystemErrorTag) => PlatformError.systemError({
    module: "FileSystem", method, _tag: reason, pathOrDescriptor: path,
  });
  const read = (path: string) => Effect.suspend(() => {
    const file = files.get(path);
    return file ? Effect.succeed(file.text) : Effect.fail(failure("readFileString", path, "NotFound"));
  });
  const write: FileSystem.FileSystem["writeFileString"] = (path, text, options) => Effect.suspend(() => {
    if (options?.flag?.includes("x") && files.has(path)) return Effect.fail(failure("writeFileString", path, "AlreadyExists"));
    const mode = files.get(path)?.mode ?? options?.mode ?? 0o666;
    files.set(path, { text, mode });
    writes.push({ path, mode });
    if (control.failWrite) return Effect.fail(failure("writeFileString", path, "PermissionDenied"));
    return Effect.void;
  });
  const fs = FileSystem.makeNoop({
    exists: (path) => Effect.sync(() => files.has(path) || directories.has(path)),
    readFileString: read,
    readFile: (path) => read(path).pipe(Effect.map((text) => new TextEncoder().encode(text))),
    writeFileString: write,
    writeFile: (path, bytes, options) => write(path, new TextDecoder().decode(bytes), options),
    makeDirectory: (path, options) => Effect.suspend(() => {
      if (directories.has(path) && !options?.recursive) return Effect.fail(failure("makeDirectory", path, "AlreadyExists"));
      directories.add(path);
      return Effect.void;
    }),
    chmod: (path, mode) => Effect.suspend(() => {
      const file = files.get(path);
      if (!file) return Effect.fail(failure("chmod", path, "NotFound"));
      files.set(path, { ...file, mode });
      return Effect.void;
    }),
    rename: (from, to) => Effect.suspend(() => {
      const file = files.get(from);
      if (!file) return Effect.fail(failure("rename", from, "NotFound"));
      if (control.failRename) return Effect.fail(failure("rename", to, "PermissionDenied"));
      renames.push({ from, to, mode: file.mode });
      files.set(to, file);
      files.delete(from);
      return Effect.void;
    }),
    remove: (path, options) => Effect.suspend(() => {
      const removed = files.delete(path) || directories.delete(path);
      return removed || options?.force ? Effect.void : Effect.fail(failure("remove", path, "NotFound"));
    }),
    stat: (path) => Effect.suspend(() => {
      const file = files.get(path);
      if (!file && !directories.has(path)) return Effect.fail(failure("stat", path, "NotFound"));
      return Effect.succeed({
        type: file ? "File" as const : "Directory" as const, mode: file?.mode ?? 0o700,
        mtime: Option.some(new Date(0)), atime: Option.none(), birthtime: Option.none(), dev: 1,
        ino: Option.none(), nlink: Option.none(), uid: Option.none(), gid: Option.none(), rdev: Option.none(),
        size: ByteSize.bytes(file ? new TextEncoder().encode(file.text).length : 0), blksize: Option.none(), blocks: Option.none(),
      });
    }),
  });
  return { fs, files, writes, renames, control, authPath };
};
