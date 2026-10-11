import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

export const CONTENT = "#!/bin/sh\nprintf 'synthetic cloudflared\\n'\n";
export const archive = Effect.fnUntraced(function* (dir: string) {
  const source = join(dir, "archive-source");
  const path = join(dir, "cloudflared.tgz");
  const corruptedPath = join(dir, "corrupted.tgz");
  yield* Effect.tryPromise(async () => {
    await mkdir(source);
    for (const [destination, content] of [[path, CONTENT], [corruptedPath, "#!/bin/sh\nexit 17\n"]] as const) {
      await writeFile(join(source, "cloudflared"), content, { mode: 0o755 });
      await new Promise<void>((resolve, reject) => {
        execFile("tar", ["-czf", destination, "-C", source, "cloudflared"], { timeout: 5_000 }, (error) => error ? reject(error) : resolve());
      });
    }
  });
  const bytes = yield* Effect.tryPromise(() => readFile(path));
  return { path, corruptedPath, artifact: { version: "2026.9.2", url: "https://example.invalid/cloudflared.tgz", sha256: createHash("sha256").update(bytes).digest("hex") } };
});
