import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { Effect, Predicate, Schema } from "effect";

export type NpmCommand = { command: string; args: string[] };

export class NpmNotFound extends Schema.TaggedError<NpmNotFound>()("NpmNotFound", {
  searched: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `npm が見つかりません（探した場所: ${this.searched.join("、")}）`;
  }
}

const available = async (path: string, executable: boolean): Promise<boolean> => {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, executable ? constants.X_OK : constants.R_OK);
    return true;
  } catch (error) {
    if (Predicate.hasProperty(error, "code") && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) return false;
    throw error;
  }
};

export const resolveNpm = Effect.fnUntraced(function* (options: {
  explicit?: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
}) {
  const bin = dirname(options.execPath);
  const adjacent = join(bin, "../lib/node_modules/npm/bin/npm-cli.js");
  const linked = join(bin, "npm");
  const candidates = [
    ...(options.explicit === undefined ? [] : [{ path: options.explicit, cli: /\.[cm]?js$/.test(options.explicit) }]),
    { path: adjacent, cli: true },
    { path: linked, cli: false },
    ...(options.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => ({ path: join(dir, "npm"), cli: false })),
  ];
  for (const candidate of candidates) {
    if (!(yield* Effect.tryPromise(() => available(candidate.path, !candidate.cli)))) continue;
    const path = yield* Effect.tryPromise(() => realpath(candidate.path));
    return candidate.cli || /\.[cm]?js$/.test(path)
      ? { command: options.execPath, args: [path] }
      : { command: path, args: [] };
  }
  return yield* new NpmNotFound({ searched: candidates.map(({ path }) => path) });
});
