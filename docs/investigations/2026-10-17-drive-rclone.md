# Drive への保管で rclone を呼ぶ形（Issue #1269）

地図 [#1232](https://github.com/daiki-beppu/live-mindmap/issues/1232) の調査チケット [#1269](https://github.com/daiki-beppu/live-mindmap/issues/1269)。**Drive への保管**（会議のエクスポート一式を、利用者の Google Drive に期限なしで置くこと。Mac → Drive の片方向）を、live-mindmap が rclone を呼ぶだけで行うときの呼び方を、rclone の一次資料（rclone.org の文書と、手元の rclone v1.75.1 の `--help`）と、このリポジトリの前例（ADR 0008・0014・0017、GLOSSARY、`server/src/cli.ts` の `publish`、子プロセスを呼ぶ Service）から調べた。調べた日は 2026-10-17、main は `1af9a0f`。

rclone の振る舞いは、スクラッチの一時フォルダ 2 つの間で実際に流して確かめた（下の「手元で確かめたこと」）。`gdrive:` には書き込みも削除もしていない。**［未確認］** と付けたものは一次資料でも手元でも裏が取れていない。

## 結論

- **`rclone copy` を使う。`sync` は使わない**。copy は行き先から消さず、同じ名前で中身が違うファイルは上書きする。手元でセッションのフォルダを消しても Drive には残り、エクスポートし直せば新しい中身で上書きされる。sync は行き先を手元に合わせて消すので、手元を消した後に誤って流すと Drive の写しまで消える
- **行き先は rclone のパス 1 つ（`リモート:フォルダ`）を環境変数で持ち、既定値を置く**。前例（`LIVE_MINDMAP_SESSIONS`・`LIVE_MINDMAP_DEPS`）に合わせ、たとえば `LIVE_MINDMAP_DRIVE`、既定は `gdrive:live-mindmap`。セッションごとの行き先は `<根>/<セッションのフォルダ名>` にする
- **テストの偽の Drive は、行き先を `:local:<一時フォルダ>` にするだけで作れる**。資格情報も設定ファイルも要らない（`RCLONE_CONFIG=/dev/null` でも動く）。既定値 `gdrive:...` のままで試したいときは、`RCLONE_CONFIG_GDRIVE_TYPE=local` で同名のリモートを環境変数から作れる
- **終了コードは、rclone の 0 を 0、それ以外を live-mindmap の 1 に写す**。文面に rclone の終了コードと標準エラーの末尾を入れる。exit 3 は「`cli install` で入れられる管理依存が未導入」の約束なので使わない
- **rclone とリモートの有無は、保管のコマンドの中で、copy の前に `rclone listremotes --json` 1 回で見分ける**。rclone が無ければ起動の失敗（`NotFound`）、リモートが無ければ一覧に名前が無い。どちらも Drive には何も送らずに exit 1 で止め、入れ方・設定のしかたを出す。`publish` の「資格情報が無ければ `CommandFailed`」と同じ置き場所で、開始前の確かめには入れない
- **rclone は `effect/process` の `ChildProcessSpawner` で呼び、Service に包む**（`ScreenJpeg` の `sips` と同じ作り）。単体テストは偽の Layer、実際の rclone を `:local:` に向けて流すのは IT にする

## 各問いへの答え

### `copy` か `sync` か

rclone の文書（`rclone copy --help` と同じ文が [rclone.org/commands/rclone_copy](https://rclone.org/commands/rclone_copy/) にある）:

- copy は「同じファイルは送らない（大きさと更新時刻、または MD5 で比べる）。行き先からは消さない。行き先も消して手元に合わせたいなら sync を使う」[1]
- sync は「行き先だけを変え、必要なら行き先のファイルを消して手元に合わせる」「データを失いうるので、まず `--dry-run` か `--interactive` で試すこと」。途中で失敗があれば行き先は消さない [2]
- どちらも「フォルダそのものではなく中身を写す」。`rclone copy src dst:path` は `src` の中身を `dst:path` の直下に置く。行き先が無ければ作る [1][2]
- Drive は MD5・SHA1・SHA256 と、1 ms 精度の更新時刻を持つ [3]。copy の「同じか」の判定がそのまま効く

手元で確かめた結果（下の表）: copy をもう一度流すと、中身を変えた `map.md` は上書きされ、手元で消した `map.html` は行き先に残った。

地図の決定（手元が正の片方向、「同期」という語を避ける）に照らすと、copy が合う。

- **エクスポートし直したとき**: copy で上書きされる。古い中身は Drive の版の履歴に残るかは Drive 側の仕様で、rclone の文書には無い **［未確認］**
- **手元で消したとき**: copy は Drive から消さない。消すかどうかは地図の「手元で消したセッションを Drive でどう扱うか」で決めるが、消すと決めても `sync` で全体を写す形にはしない方がよい。保管は期限なしで置くことが目的で、手元の容量のためにセッションを消す使い方（`docs/devlog/2026-10-14.md` の計測のランの退避と同じ）では、Drive が唯一の写しになる
- **セッション単位で写す**: `~/.live-mindmap/sessions/` の直下には `vocabulary.json` のようにセッションでないファイルもある（手元で確かめた）。根ごと copy せず、セッションのフォルダ 1 つを `<根>/<フォルダ名>` に写す
- copy でも、手元で消えたファイル（エクスポートし直しで出なくなった `map-audio.html` など）は Drive に残る。中身を一致させたいなら、セッションのフォルダ 1 つに限った `sync` という選択肢はある。ただし誤った行き先に向けると消す範囲が広がるので、採るなら仕様で範囲を決める

### 行き先の指定

rclone のパスの書き方 [4]:

- `/path/to/dir`: 手元のファイルシステム
- `remote:path/to/dir`: 設定ファイルにあるリモート `remote:` の中の `path/to/dir`
- `:backend:path/to/dir`: その場で作るリモート（設定は引数か環境変数で渡す）
- 接続文字列 `remote,param=value:path` / `:backend,param=value:path` で、設定を上書きできる [4]
- リモート名は大文字小文字を区別し、英数字・`_`・`-`・`.`・`+`・`@`・空白が使える [4]

リモート名に決まった名前は無い。この Mac の `gdrive` は利用者が付けた名前で、Drive の文書の手順では `remote` という名前の例で作る [3]。そのため既定値を置いても、利用者の設定と合わない場合がある。

このリポジトリの前例:

- 置き場所は環境変数と既定値: `LIVE_MINDMAP_SESSIONS`（既定 `~/.live-mindmap/sessions`）、`LIVE_MINDMAP_DEPS`（既定 `~/.live-mindmap/deps`）（`server/src/config.ts`）
- 利用者ごとの既定の指定も環境変数: `LIVE_MINDMAP_SHARE_ALLOW`（閲覧の共有の既定の許可。引数で足せる）（`server/src/config.ts`・`cli.ts` の `share`）
- `publish` の資格情報も環境変数（`CLOUDFLARE_ACCOUNT_ID`・`CLOUDFLARE_API_TOKEN`）で、`~/.live-mindmap/config.json` には置かない
- `~/.live-mindmap/config.json`（`LIVE_MINDMAP_CONFIG` で変えられる）は差分更新のモデルの選択に使っていて、置き場所の設定の前例は無い

推奨: 行き先は rclone のパスの文字列 1 つで持つ（リモート名とフォルダを分けない）。こうすると `:local:/tmp/x` も手元のパスも同じ口で受けられ、テストの差し替えが値 1 つで済む。環境変数（例 `LIVE_MINDMAP_DRIVE`）に置き、既定は `gdrive:live-mindmap`。既定のリモートが無い利用者には、下の「見分け方」で環境変数の名前と例を出す。引数で上書きする口（`--to` など）を足すかは `cli` の形を決めるときに決める。

### テストで local バックエンドに差し替えられるか

できる。手元で確かめた（下の表）。

- `:local:<絶対パス>` は、設定ファイルに何も無くても（`RCLONE_CONFIG=/dev/null`）手元のフォルダに写す。終了コード 0
- 環境変数でリモートを作れる。`RCLONE_CONFIG_` + リモート名 + `_` + 設定の名前を大文字で、`_TYPE` は必須。`listremotes` にも出る [5]。`RCLONE_CONFIG=/dev/null RCLONE_CONFIG_GDRIVE_TYPE=local` で `gdrive:<絶対パス>` が手元のフォルダに写った。`listremotes --json` では `"source":"environment"` と出る
- 設定ファイルの場所は `--config` で変えられ、どのフラグも `RCLONE_` + 大文字の名前の環境変数で既定を置ける（`--config` は `RCLONE_CONFIG`）[5][6]。`--config` を空・`/dev/null` にすると設定ファイルを読まない [6]。手元で `RCLONE_CONFIG=/tmp/xx.conf rclone config file` が、その場所を使うと答えた
- 設定ファイルの既定の場所は `$XDG_CONFIG_HOME/rclone/rclone.conf`、無ければ `~/.config/rclone/rclone.conf`（この Mac もここ）[6]

テストは、利用者の本物の `gdrive:` に触れないよう、rclone を起動するときに `RCLONE_CONFIG=/dev/null` を必ず渡す（`ChildProcess.make` の `env` と `extendEnv`）。環境変数の `RCLONE_CONFIG_<NAME>_*` は設定ファイルより優先される [5] ので、`/dev/null` を渡さずに `RCLONE_CONFIG_GDRIVE_TYPE=local` だけにすると、本物の設定の残りの項目と混ざる。

CI の ubuntu の runner に rclone が入っているかは確かめていない **［未確認］**。`sips` を偽の Layer に替えた前例（`server/src/screenJpeg.ts`・`test/fixtures/screenJpeg.ts`）に合わせ、単体テストは偽の Service、本物の rclone を `:local:` に流すのは IT にして、CI では rclone を入れる手順を足す（入れるかどうかは実装の ticket で決める）。

### 終了コードの写し方

rclone の終了コード [6]:

| rclone | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 分類されない失敗 |
| 2 | 構文・使い方の誤り |
| 3 | フォルダが無い |
| 4 | ファイルが無い |
| 5 | 一時的な失敗（再試行で直りうる） |
| 6 | 軽い失敗（NoRetry） |
| 7 | 再試行では直らない致命的な失敗 |
| 8 | `--max-transfer` の上限に達した |
| 9 | 成功したが何も送らなかった（`--error-on-no-transfer` のときだけ） |
| 10 | `--max-duration` の上限に達した |

補足:

- `--retries` の既定は 3 で、失敗すると操作全体をやり直す。`--low-level-retries` の既定は 10 [6]（手元の `rclone help flags`）
- 手元では、無いリモート名に copy すると `didn't find section in config file ("nosuch")` で **終了コード 1**、無い元のフォルダを copy すると 3 回やり直した後に **3**、知らないフラグは **2** だった。リモートが無いことは終了コードでは他の失敗と分けられない
- Drive は 1 日 750 GiB のアップロードの上限があり（Google の文書に無い上限）、`--drive-stop-on-upload-limit` で致命的な失敗にできる [3]
- トークンが切れたときの終了コードは確かめていない **［未確認］**

live-mindmap の前例:

- `cli` の失敗は `CommandFailed`（`message` を 1 つ持つ）で表し、`reportFailure` が 1 か所で表示し、終了コードは `exitNaturally` で 1 になる（`server/src/cli.ts`・`entryFailure.ts`・`exitNaturally.ts`）
- 終了コード 3 は「開始に要るものが未導入」の 1 つだけで、`depsMissingTeardown` が `RequiredDepsMissing`・`StartupDepsMissing` に限って付ける。ADR 0017 で「エージェントとの約束」とし、受けたら利用者に確かめてから `cli install` を打つ流れになっている
- 終了コード 4 は、エクスポートの公開で発言の文字・録音を含めるときに止めて利用者に聞かせる口として、仕様 [#1246](https://github.com/daiki-beppu/live-mindmap/issues/1246)・[#1252](https://github.com/daiki-beppu/live-mindmap/issues/1252) で決まっている（main の `1af9a0f` には未実装）。`docs/knowledge/export-publish.md` は「exit 3 と同じ形」と書く
- `publish` の Cloudflare の失敗（`CloudflareFailed`）は、理由の文に直して `CommandFailed`（exit 1）にしている
- 子プロセスの失敗は「標準エラーの末尾、空なら `終了コード N`」を理由の文にする（`helpers.ts` の `stderrReason`、`screenJpeg.ts`、`managedDeps.ts`）

推奨の写し方:

- rclone 0 → live-mindmap 0。送った物が無くても（エクスポートが変わっていなくても）成功にする。`--error-on-no-transfer` は付けない
- rclone 0 以外 → live-mindmap 1（`CommandFailed`）。文面に「rclone が終了コード N で終わりました」と標準エラーの末尾を入れる。5 なら「時間をおいて流し直せば通りうる」と添える程度にとどめ、rclone の 2〜10 を live-mindmap の別々の終了コードには写さない。エージェントがそれで分岐する理由が今は無い
- exit 3 は使わない。rclone は管理依存ではなく、`cli install` で入れられないので、3 の約束（受けたら `cli install`）が壊れる
- 録音を含めるときに止めて聞かせる形（[#1270](https://github.com/daiki-beppu/live-mindmap/issues/1270) の結論しだい）を採るなら、公開の exit 4 と同じ番号と `--confirmed` にそろえるのが前例に沿う

### rclone・リモートが無いときをどう見分け、どこで止めるか

見分け方:

- **rclone が無い**: 起動そのものが失敗する。`NodeChildProcessSpawner` は Node の `spawn` の `error` イベント（ENOENT）を `PlatformError`（`SystemError`、理由 `NotFound`）にして返す（`@effect/platform-node-shared` 4.0.1 の `NodeChildProcessSpawner.ts`、`toPlatformError` → `handleErrnoException`）。PATH を自前で探す必要は無い
- **リモートが無い**: `rclone listremotes --json` の出力に名前が無い。`listremotes` は設定ファイルと環境変数のリモートを並べ、`--json` は名前・種類・出どころ（`file` か `environment`）を出す [7]。手元では、設定が空でも、`--name nosuch --exact` で一致が無くても、**終了コードは 0** だった。終了コードではなく出力を読んで判断する
- **種類が違う**: `--json` の `type` が `drive` でなくても、rclone のどのバックエンドにも置けるので拒まない（`:local:` で試すのもこの性質による）
- 行き先が `:backend:...`（その場のリモート）や手元のパスなら、`listremotes` で探す名前が無いので、この確かめは飛ばす
- 確かめはネットワークに出ない。トークンの期限切れなど Drive に着いてからの失敗は、copy の失敗として上の終了コードの写し方で知らせる

どこで止めるか（前例との照らし合わせ）:

- **開始前の確かめ（GLOSSARY）には入れない**。開始前の確かめは「セッションを始める前に、そのセッションで要るもの」を見る。保管は会議の後に行う任意の機能で、会議そのものは rclone が無くても動く（地図の決定）。開始のたびに「rclone がありません」と出すと、保管を使わない利用者に雑音になる。ただし [#1271](https://github.com/daiki-beppu/live-mindmap/issues/1271) で「締めたときに自動で保管」を採るなら、そのセッションで要るものになるので、「欠けても一部の出力が減るだけのもの」として開始前の確かめで知らせたうえで始める形（Chromium と `map.png` と同じ）になる
- **ADR 0017 の exit 3 と `cli install` の形は持ち込まない**。ADR 0017 は live-mindmap が固定版で管理ディレクトリに入れる物の話で、入れるのはいつも `cli install`。rclone は利用者が自分で入れ、OAuth の設定（`rclone config`）も利用者の手でしか済ませられない。製品が値を決められない物なので止まるのは同じだが、止まった後に打つのは `cli install` ではない
- **`publish` の資格情報の確かめと同じ置き場所にする**。`publish` は、ローカルモードを拒む → 資格情報が無ければ文面つきの `CommandFailed` → 中身を作る → Cloudflare に送る、の順で、外に何も送らずに止まる。保管も「ローカルモードを拒む → `listremotes` でリモートを確かめる → copy」の順にする。止まるときの文面は、何が無いか・どう入れるか（rclone の入れ方、`rclone config` で Drive のリモートを作る、行き先の環境変数の名前と例）を出し、`publish` の `MISSING_CREDENTIALS_MESSAGE` と同じく、利用者がすべき手順を書く
- **ローカルモードの拒み方も `publish` にそろえる**。`log.jsonl` の `start` の `model.local` を見て、`CommandFailed`（「ローカルモードのセッションは〜できません。会議の中身を Mac の外に出さないためです」）

### rclone を Effect からどう呼ぶか

前例（ADR 0008「子プロセスは `effect/process` の `ChildProcess`」）:

| 前例 | 呼び方 | 合う点 |
|---|---|---|
| `server/src/screenJpeg.ts`（`sips`） | Service の Layer で `ChildProcessSpawner` を受け、`Effect.scoped` の中で `spawner.spawn(ChildProcess.make("sips", args, { stdin: "ignore" }))`、`stdout`・`stderr`・`exitCode` を `Effect.all(..., { concurrency: "unbounded" })` で並べて読み、0 以外なら標準エラーの末尾を理由に `Schema.TaggedError` で失敗する。テストは偽の Layer | 1 回走らせて終わりを待つ形がそのまま合う。rclone も CI に無いかもしれない点が同じ |
| `server/src/helpers.ts` の `runHelperCommand` | 同じく 1 回起動して `{ stdout, stderr, code }` を返す。`forceKillAfter` を渡せる | 同上 |
| `server/src/tunnel.ts`（`cloudflared`） | 長く走る子を呼び出し側の Scope に結び、`forceKillAfter` で SIGTERM → SIGKILL。`check` と `open` を分けた Service | `check`（`listremotes`）と実行（`copy`）を分ける形の手本。ただし rclone は管理依存ではないので `ManagedDeps.executable` は使わず、`"rclone"` を PATH から起動する |
| `server/src/appleIntelligence.ts` | `NodeChildProcessSpawner.layer` を `cli.ts` の入口で渡す | `cli` から子プロセスを呼べることの前例 |

Effect 4.0.1 の公式の例（`effect/ai-docs/src/60_child-process/10_working-with-child-processes.ts`）では、出力をまとめて取るなら `spawner.string`・`spawner.lines`、走っている間に読むなら `spawner.spawn` と `Effect.scoped`、環境変数は `ChildProcess.make(cmd, args, { env, extendEnv: true })` で足す。`extendEnv: true` のときは `process.env` に `env` を重ねて渡す（`NodeChildProcessSpawner.ts` の `resolveEnvironment`）。

推奨の形:

- `DriveStore`（名前は仕様で決める）という Service に `check(dest)` と `store(sessionDir, dest)` を持たせ、Layer で `ChildProcessSpawner` を受ける
- `check`: `rclone listremotes --json` を走らせ、`Schema` で JSON を読む（Effect の AGENTS.md の「手で解析せず Schema で」）。起動の失敗で `PlatformError` の `NotFound` なら「rclone が無い」、一覧に名前が無ければ「リモートが無い」の `Schema.TaggedError`
- `store`: `rclone copy <セッションのフォルダ> <根>/<フォルダ名>` を `stdin: "ignore"` で走らせ、`stdout`・`stderr`・`exitCode` を並べて読む（パイプが詰まらないよう両方を読み切る）。進み具合を見せるなら `--stats-one-line` などを足す余地はあるが、出力を読むのはエージェントなので最初は無しでよい
- 中断（Ctrl-C）に備えて `forceKillAfter` を付ける。copy は途中で止めても次の copy で続きから写る（同じファイルは送らない）[1]
- 引数は配列で渡し、シェルを通さない（行き先にスペースが入りうる）
- `cli` の `publish` と同じく、サーバーを要らない `cli` のコマンドの中で走らせる。`cli.ts` の入口は `NodeServices.layer` と `NodeChildProcessSpawner.layer` を既に渡している

## 手元で確かめたこと

rclone v1.75.1（darwin/arm64）。スクラッチの一時フォルダの間で流した。`gdrive:` には書いていない。

| やったこと | 結果 |
|---|---|
| `rclone listremotes` | `gdrive:`、終了コード 0 |
| `RCLONE_CONFIG=/dev/null rclone copy src/<セッション> :local:<dst>/<セッション>` | 2 ファイルが写る。0 |
| `map.md` を書き換え、`map.html` を手元から除いて同じ copy | `map.md` は新しい中身、`map.html` は行き先に残る。0 |
| `rclone copy src nosuch:x` | `didn't find section in config file ("nosuch")`。1 |
| 無い元のフォルダを copy | 3 回やり直して `directory not found`。3 |
| 知らないフラグ | 2 |
| `RCLONE_CONFIG=/dev/null rclone listremotes` | 何も出ない。0 |
| `RCLONE_CONFIG=/dev/null RCLONE_CONFIG_FAKEDRIVE_TYPE=local rclone listremotes --json` | `[{"name":"fakedrive","type":"local","source":"environment","description":""}]`。0 |
| `RCLONE_CONFIG=/dev/null RCLONE_CONFIG_GDRIVE_TYPE=local rclone copy src gdrive:<絶対パス>` | 手元のフォルダに写る。0 |
| `rclone listremotes --name nosuch --exact` | 何も出ない。0 |
| `RCLONE_CONFIG=/tmp/xx.conf rclone config file` | その場所を使うと答える |

## 推奨

1. **copy で写す**。`rclone copy <~/.live-mindmap/sessions/<フォルダ名>> <根>/<フォルダ名>`。sync は使わない。手元で消しても Drive には残り、エクスポートし直しは上書きになる。手元で消えたファイルを Drive からも消すかは、地図の「手元で消したセッション」の問いで決める
2. **行き先は rclone のパス 1 つを環境変数で**。例 `LIVE_MINDMAP_DRIVE`、既定 `gdrive:live-mindmap`。`:local:...` や手元のパスもそのまま受ける。引数での上書きは `cli` の形を決めるときに決める
3. **テストは行き先を `:local:<一時フォルダ>` にし、rclone に `RCLONE_CONFIG=/dev/null` を渡す**。既定値のままで試すときは `RCLONE_CONFIG_GDRIVE_TYPE=local` を足す。単体テストは偽の Service の Layer、本物の rclone を流すのは IT
4. **終了コードは rclone 0 → 0、それ以外 → 1（`CommandFailed`）**。文面に rclone の終了コードと標準エラーの末尾。exit 3 は使わない。録音を含めるときに聞かせる形を採るなら、公開の exit 4 と `--confirmed` にそろえる
5. **rclone・リモートの有無は保管のコマンドの中で、copy の前に見る**。順は、ローカルモードを拒む → `rclone listremotes --json`（起動できなければ「rclone が無い」、名前が無ければ「リモートが無い」）→ copy。Drive には何も送らずに exit 1 で止め、rclone の入れ方・`rclone config` でのリモートの作り方・行き先の環境変数を出す。開始前の確かめには、保管を締めたときに自動で行うと決めた場合だけ、「欠けても一部の出力が減るだけのもの」として足す
6. **rclone は `effect/process` で呼ぶ Service に包む**。`ScreenJpeg` の `sips` と同じ作りで、`ChildProcess.make("rclone", [...], { stdin: "ignore", forceKillAfter })`、`stdout`・`stderr`・`exitCode` を並べて読む。`check` と `store` を分けるのは `Tunnel` の前例。`listremotes --json` は `Schema` で読む

## 出典

1. rclone copy: https://rclone.org/commands/rclone_copy/ （手元の `rclone copy --help` と同文、v1.75.1）
2. rclone sync: https://rclone.org/commands/rclone_sync/ （手元の `rclone sync --help`）
3. Google Drive バックエンド: https://rclone.org/drive/ （重複したファイル、MD5・SHA1・SHA256、更新時刻 1 ms、750 GiB/日、共有の client_id の 2026 年の廃止）
4. rclone の使い方（パスの書き方・接続文字列・リモート名）: https://rclone.org/docs/
5. 同（環境変数でのフラグの既定とリモートの定義、優先順位）: https://rclone.org/docs/#environment-variables
6. 同（`--config`・設定ファイルの場所・終了コード・`--retries`）: https://rclone.org/docs/ 、手元の `rclone help flags`
7. rclone listremotes: https://rclone.org/commands/rclone_listremotes/
- このリポジトリ: `docs/adr/0008-helper-lifecycle-on-effect.md`、`docs/adr/0014-local-mode-only-own-child-processes.md`、`docs/adr/0017-heavy-deps-in-managed-dir-cli-stops-at-check.md`、`GLOSSARY.md`（開始前の確かめ）、`docs/knowledge/export-publish.md`、`server/src/cli.ts`（`publish`・`reportFailure`・`teardown`）、`server/src/entryFailure.ts`、`server/src/exitNaturally.ts`、`server/src/config.ts`、`server/src/screenJpeg.ts`、`server/src/helpers.ts`、`server/src/tunnel.ts`
- Effect 4.0.1: `effect/AGENTS.md`、`effect/ai-docs/src/60_child-process/10_working-with-child-processes.ts`、`@effect/platform-node-shared` 4.0.1 の `src/NodeChildProcessSpawner.ts`
