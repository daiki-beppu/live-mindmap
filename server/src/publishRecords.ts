// 公開の記録。~/.live-mindmap/publish/records.jsonl に 1 公開 1 行で追記する（利用者だけが読める権限）。
// 一覧・取り下げ・期限切れの後片付けは後のチケット。ここでは書くだけ
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, FileSystem } from "effect";

export type PublishRecord = {
  readonly name: string;
  readonly url: string;
  readonly accountId: string;
  // 元のセッションのフォルダ
  readonly dir: string;
  // 中身の段。この段ではマップだけ
  readonly level: "map";
  readonly anyone: boolean;
  // 合言葉つき（anyone: false）のときだけ入る
  readonly passphrase?: string;
  readonly publishedAt: string;
  readonly expiresAt: string;
  readonly status: "published";
};

const homeConfig = Config.String("HOME").pipe(Config.withDefault(homedir()));

export const appendPublishRecord = Effect.fnUntraced(function* (record: PublishRecord) {
  const home = yield* homeConfig;
  const fs = yield* FileSystem.FileSystem;
  const base = join(home, ".live-mindmap");
  const directory = join(base, "publish");
  const path = join(directory, "records.jsonl");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
  yield* fs.writeFileString(path, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
  yield* fs.chmod(path, 0o600);
});
