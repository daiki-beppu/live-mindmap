# 名前 live-mindmap が使われている場所（Issue #1859）

map #1857（ツールを短い再帰的頭字語に改名する）のために、名前 `live-mindmap` とその変種（`LIVE_MINDMAP_*`・`@live-mindmap/*`・`live-mindmap-helper` など）がどこで使われているかを洗い出し、改名するときの扱いで分けた。調べたのは 2026-11-03 の `origin/main`（`d5d5d2d`）と、この Mac の手元の状態。手元は読むだけで、何も変えていない。保存済みのセッションは件数とパスだけを数え、中身は読んでいない。

分類は次の 3 つ。

- **変えられる**: 文字列を置き換えるだけで、他に何も壊れない。
- **変えると壊れる**: 置き換えると、何かが動かなくなる・データが見えなくなる・移行が要る。壊れるものを書く。
- **変えられない**: リポジトリの外にあり、改名の PR では手が届かない（または過去の記録で、変えるべきでない）。

## 結論

- 追跡されているファイルで `live-mindmap` は 2,157 回、`LIVE_MINDMAP` は 341 回出る（`git grep -Io`）。変種の `live_mindmap`・`livemindmap`・`LiveMindmap`・`liveMindmap` は 0 回。
- 2,157 回のうち 1,661 回（84 ファイル）は `https://github.com/daiki-beppu/live-mindmap/...` のリンク。GitHub はリポジトリの改名の後も旧 URL をリダイレクトするので、置き換えなくても壊れない（旧名で新しいリポジトリを作らない限り）。
- 壊れるのは主に次の 5 つ。どれも「旧名がパスやプロセス間の約束として残る」場所で、#1857 の「Not yet specified」にある互換の ticket の材料になる。
  1. 手元の保存先 `~/.live-mindmap/`（セッション 3 件・管理依存 472 MB・設定・ChatGPT の資格情報・公開の記録）。既定のパスを変えると、過去のセッションと導入済みの依存が見えなくなる。
  2. 環境変数 `LIVE_MINDMAP_*`（18 種、82 ファイル）。利用者・CI・スクリプト・skill が外から渡すので、名前を変えると設定が黙って効かなくなる。
  3. helper の実行ファイル名 `live-mindmap-helper`・`live-mindmap-apple`。server が `helper/.build/release/` の固定のパスで起動するので、Swift の製品名と server の既定パスを同時に変え、ビルドし直さないと起動できない。
  4. 画面のタイトル `live-mindmap`（web）と、helper が「自分の画面なので会議のタブとして覚えない」ために照合する文字列（`ScreenChange.swift`）。片方だけ変えると、自分のマップを会議のタブとして覚える。
  5. GitHub のリポジトリ名に連動する手元の登録（ghq のパス、Orca の repo 登録、Claude Code の auto memory のフォルダ、常駐の案内役の引数 `daiki-beppu/live-mindmap`）。リダイレクトはあっても、パスや引数の一致で照合するものは止まる。

## リポジトリの中

### パッケージ名・CLI の bin

| 場所 | 件数 | 分類 | 備考 |
|---|---|---|---|
| ルートの `package.json` の `name: "live-mindmap"` | 1 | 変えられる | `private: true`。npm に出していない |
| `@live-mindmap/server`・`web`・`e2e`・`helper`（各 `package.json` の `name`） | 定義 4、参照 84 回 / 37 ファイル | 変えると壊れる（参照を同時に変えれば可） | `pnpm --filter @live-mindmap/...` がルートの `package.json` の scripts（`test:linux` など）、`.github/workflows/tests.yml`（7 か所）、README・AGENTS.md・`docs/agents/checks.md`・`e2e/README.md` に書かれている。名前だけ変えると filter が何にも当たらず、CI とスクリプトが落ちる（pnpm は一致なしでも終了コード 0 で何もしないことがあり、気付きにくい）。`pnpm-lock.yaml` には名前が出ない（0 回） |
| `server/package.json` の `bin: { "live-mindmap": "./src/cli.ts" }` | 1 | 変えられる | この Mac に `live-mindmap` コマンドは入っていない（`which live-mindmap` で無し）。README の使い方は `pnpm cli ...`。bin を直接使う利用者はいない前提 |
| CLI のルートコマンド名 `Command.make("live-mindmap")`（`server/src/cli.ts:1338`） | 1 | 変えられる | `--help` の表示に出る |
| `server/managed-deps/{claude,chromium}/package.json` の `live-mindmap-managed-*` | 2（lock を含め 6） | 変えられる | 管理依存を入れるための私的なパッケージ名。`package-lock.json` も作り直す |

### helper（Swift）

| 場所 | 件数 | 分類 | 備考 |
|---|---|---|---|
| `helper/Package.swift` のパッケージ名・製品名・ターゲット名 `live-mindmap-helper`・`live-mindmap-apple` | 5 | 変えると壊れる | 実行ファイル名になる。`server/src/helperPath.ts`（`DEFAULT_HELPER_PATH`）、`server/src/appleIntelligence.ts:69`、`e2e/scripts/serve.ts:76`、`helper/scripts/fetch-speaker-models.sh:9`、`scripts/measure-bootstrap.sh` が固定のパスで呼ぶ。ソースのフォルダ名 `helper/Sources/live-mindmap-helper/`・`live-mindmap-apple/` も対応して変える。手元の `.build/` に旧名の実行ファイルが残ると、古いものを起動したまま気付かないことがある |
| bundle id | 0 | — | helper は `.app` ではなく、`Info.plist` も entitlements も無い。bundle id は持たない。`bundleID` の語はすべて会議アプリの bundle id のこと |
| `DispatchQueue(label: "live-mindmap.…")` | 7 | 変えられる | デバッグ用のラベルだけ |
| プロセスタップの名前 `live-mindmap-helper`・集約デバイス名 `live-mindmap-helper tap`（`ProcessTap.swift:87,107`） | 2 | 変えられる | private な集約デバイス。名前で探すコードは無い |
| 自分の画面を除く照合 `["live-mindmap", "about:blank", "新しいタブ", "New Tab"]`（`ScreenChange.swift:89`） | 1（テスト 7） | 変えると壊れる | web のタイトルと対。下の「web」を参照 |
| usage の文言（`main.swift`・`Entry.swift`） | 5 | 変えられる | |
| `~/Library/Caches/live-mindmap-helper/`（手元に存在） | — | 変えられる（旧フォルダは残る） | bundle id が無いので、Foundation の `URLCache` が実行ファイル名でフォルダを作る（コードからは参照していない）。改名すると新しい名前のフォルダができ、旧フォルダはごみとして残る |
| 話者分離のモデルの置き場 | 0 | — | 既定は `~/Library/Application Support/FluidAudio/Models`（`SortformerSpeakerDiarizer.swift:151`）。名前を含まない。上書きは環境変数 `LIVE_MINDMAP_HELPER_SPEAKER_MODEL_DIR` |
| 画面収録・音声の許可（TCC） | — | 要確認 | helper は bundle を持たない CLI で、許可は起動した端末アプリ側に付く想定。実行ファイル名を変えて許可を求め直すかは確かめていない（実機で 1 回確かめる） |

### 保存先のパス（`~/.live-mindmap/`）

server が既定で使う。すべて `join(homedir(), ".live-mindmap", ...)` で組み、`HOME` で動く。

| パス | 定義 | 上書き | 手元の状態 |
|---|---|---|---|
| `~/.live-mindmap/sessions/` | `server/src/config.ts:12` | `LIVE_MINDMAP_SESSIONS` | 3 件、619 MB |
| `~/.live-mindmap/sessions.server/`・`sessions.model-transfer/` | sessions の隣（server の PID 記録・モデルの受け渡し） | 同上から派生 | 0 件・1 件 |
| `~/.live-mindmap/deps/` | `server/src/config.ts:8` | `LIVE_MINDMAP_DEPS` | 3 件、472 MB（Chromium・Claude SDK など） |
| `~/.live-mindmap/config.json` | `server/src/modelConfig.ts:13` | `LIVE_MINDMAP_CONFIG` | 無し |
| `~/.live-mindmap/auth/chatgpt.json` | `server/src/chatgptAuthStore.ts:20` | 無し | 無し |
| `~/.live-mindmap/publish/records.jsonl` | `server/src/publishRecords.ts:27` | 無し | 無し |

分類: **変えると壊れる**。既定のパスを新しい名前に変えると、過去のセッション（`cli play`・`cli restore`・`cli review`・語彙の過去のセッションからの取り込み）、導入済みの管理依存（再ダウンロードになる）、モデルの設定、ChatGPT のサインイン、公開の記録（`cli publish list`・`withdraw` が過去の公開を見失い、期限切れの Worker の後片付けもできなくなる）が見えなくなる。移行（旧フォルダを読む・移す・旧名のまま残す）を決める必要がある。文言にもこのパスが出る（`cli.ts:1184,1325`、README.ja.md、`e2e/README.md`）。

### 環境変数 `LIVE_MINDMAP_*`

18 種、82 ファイル、341 回。多い順に `PORT` 78・`SESSIONS` 54・`JUDGE` 47・`CONFIG` 47・`DEPS` 39・`MODEL` 30・`SHARE_ALLOW` 13・`HELPER` 9・`HELPER_SPEAKER_MODEL_DIR` 6、テスト・計測用に `TEST_ENV`・`MEASURE_NODE`・`MEASURE_WRAPPER`・`MEASURE_CONFIG`・`VERIFY_REAL_HELPER`・`VERIFY_DISCUSSION`、helper との間の `HELPER_CONTROL_TOKEN`。

分類: **変えると壊れる**。利用者が README の手順で設定する値（`PORT`・`MODEL`・`JUDGE`・`SHARE_ALLOW`・`SESSIONS`・`DEPS`・`CONFIG`）は、名前を変えると黙って既定値に戻る。CI（`.github/workflows/tests.yml` が `LIVE_MINDMAP_DEPS` を `$GITHUB_ENV` に書き、キャッシュのパスに使う）、`web/vite.config.ts`（`LIVE_MINDMAP_PORT`）、`.agents/skills/verify-live-mindmap/scripts/*.sh`、`scripts/measure-bootstrap.sh`、`e2e/scripts/serve.ts` も同時に変える。この Mac のシェルの設定（`~/.zshrc` など・dotfiles）には `LIVE_MINDMAP_*` の設定は無かった。

`__LIVE_MINDMAP_CAPTURE_SNAPSHOT__`・`__LIVE_MINDMAP_RENDERER__`（ページ内のグローバル変数）は server と web が同じリポジトリで対になっているだけなので、変えられる。

### コードの文字列（server・web）

| 場所 | 件数 | 分類 | 備考 |
|---|---|---|---|
| Effect のサービスの鍵 `"live-mindmap/server/..."` など（`Context.Service`・`Context.Reference`） | 30 前後 / server/src | 変えられる | 同じプロセスの中の識別子。外に出ない |
| 一時フォルダの接頭辞 `live-mindmap-…-`（`makeTempDirectoryScoped`・`mkdtemp`） | 59（大半はテスト） | 変えられる | `/tmp`・`$TMPDIR` の名前だけ |
| 起動の表示 `live-mindmap サーバーを起動しました: http://127.0.0.1:<port>`（`server/src/server.ts:127`） | 1 | 変えると壊れる | `scripts/measure-bootstrap.sh:211` と `server/test/serverMain.heavy.test.ts:52` が正規表現でこの行からポートを読む。同時に変える |
| HTTP ヘッダー `x-live-mindmap-model-token`（`server/src/modelTransferToken.ts:5`） | 1 | 変えられる（版をまたぐと壊れる） | server と CLI の間の約束。両方を同じ版にそろえれば問題ない。古い常駐 server と新しい CLI の組み合わせでは、モデルの受け渡しが通らない |
| 見返しの HTML の要素 id `live-mindmap-sealed`・`live-mindmap-review-log`・`-review-audio`・`-review-licenses`（`server/src/core/passphrase.ts`・`core/review.ts`） | 4 | 変えられる | 書き出した `map.html` は読み手の JS を中に持つので、過去の書き出し・公開済みのページはそのまま開ける。書き出した HTML を読み戻すコードは無い |
| ChatGPT のサインインの `agent_name_hint: "live-mindmap"`・完了ページの文言（`server/src/chatgptAuth.ts:89,105`） | 2 | 変えられる | 新しく登録するときの表示名だけ。既存の登録（`~/.live-mindmap/auth`）には影響しない |
| 案内の文言（`live-mindmap login chatgpt で…`・`live-mindmap が起動するモデル` など） | 数件 | 変えられる | |
| Cloudflare の Worker 名の接頭辞 `lmm-`（`server/src/cloudflareWorkers.ts:83`、`cli.ts:1130`） | 2 | 変えると壊れる | 名前そのものではなく略称。`cli publish list` は「`lmm-` で始まり記録に無い Worker」を知らせる。接頭辞を変えると、旧名で置いた公開を見分けられなくなる。残すなら変えなくてよい |

### web

| 場所 | 件数 | 分類 | 備考 |
|---|---|---|---|
| ページのタイトル `live-mindmap`（`web/index.html`、`web/src/app/{meeting,capture,review}/entry.ts` の `TITLE`） | 4 | 変えると壊れる | helper の `ScreenChange.swift:89` が、ブラウザのタブの題名が `live-mindmap` なら自分の画面として覚えない。タイトルだけ変えると、マップのタブを会議のタブとして覚える（共有画面にマップが映る）。helper の照合と同時に変える。過去の版の題名も除くなら、両方を並べる |
| `server/test/cliPublish.it.test.ts` の雛形 `<title>live-mindmap</title>` | 2 | 変えられる | |

### テスト

`server/test` 69 ファイル、`web/test` 8、`helper/Tests` 9、`e2e/tests` 1。大半は一時フォルダの接頭辞・`@live-mindmap/server` の import・環境変数。上の本体と一緒に置き換える。`e2e/.e2e/cache/` には名前が出ない（0 回）。`e2e/tests` の `agent.act` の指示にも名前は無いので、改名で記録し直し（`REPLAY_STALE`）は起きない見込み。ただし画面のタイトルが変わると、画面の写しを照合するステップで外れることはありうる（実際に smoke を流して確かめる）。

### 文書

| 場所 | `live-mindmap` の回数（うち GitHub の URL） | 分類 |
|---|---|---|
| `README.md`・`README.ja.md` | 見出し・本文・`git clone` の手順・ロードマップのリンク | 見出し・本文・手順は変えられる。`git clone https://github.com/daiki-beppu/live-mindmap` と `cd live-mindmap` はリポジトリの改名と同時に変える |
| `GLOSSARY.md`（見出しと 4 か所） | 5 | 変えられる |
| `AGENTS.md`・`CODING_STANDARDS.md`・`docs/agents/*.md` | 数件 | 変えられる |
| `docs/adr/`（25 ファイル） | 91（80） | 変えられない（過去の決定の記録）。URL はリダイレクトで生きる |
| `docs/devlog/`（25 ファイル） | 873（760） | 変えられない（公開前提の過去の記事）。URL はリダイレクトで生きる |
| `docs/knowledge/`（28 ファイル） | 817（804） | URL は変えなくてよい。本文の製品名は変えられる |
| `docs/investigations/`・`docs/screenshots/`・`docs/evidence/` | 7・12・7 | 変えられない（当時の証拠） |
| `docs/publishing.md` | 4 | 変えられる（`gh repo edit daiki-beppu/live-mindmap` などの手順） |
| `.agents/skills/verify-live-mindmap/`（`.claude/skills/` からシンボリックリンク） | 8 ファイル | 変えると壊れる（軽い）: フォルダ名が skill 名になる。改名すると呼び出し名が変わり、`CLAUDE.md`・利用者の手順・`~/.claude` の記憶から旧名で呼んでも見つからない |

README にバッジは無い。

## リポジトリの外（読むだけで確かめた）

| 場所 | 状態 | 分類 |
|---|---|---|
| GitHub のリポジトリ `daiki-beppu/live-mindmap` | public、star 3、fork 0、Pages 無し、webhook 0、Actions の secret・variable 0 | 変えられる（GitHub の設定で改名）。旧 URL・`git remote`・`gh api repos/<旧名>` はリダイレクトされる。旧名で新しいリポジトリを作るとリダイレクトが切れる |
| 外からのリンク | 追跡ファイルの中の URL 1,661 回 / 84 ファイル。外部サイトの記事・SNS は調べていない | 変えられない（外のものは手が届かない）。リダイレクトに頼る |
| ghq のパス `~/ghq/github.com/daiki-beppu/live-mindmap` | メインのチェックアウト | 変えると壊れる: リポジトリを改名しても手元のフォルダ名は変わらない。フォルダを移すと、下の Orca の登録・Claude Code の記憶・takt の worktree が旧パスを指したままになる |
| Orca の repo の登録 | `displayName: "live-mindmap"`、`path` が上のパス、`~/orca/workspaces/live-mindmap/` に worktree 19 個 | 変えると壊れる: パスで結び付く。フォルダを移すなら登録し直す（`orca repo add`）。表示名は変えられる |
| Claude Code のプロジェクトのフォルダ `~/.claude/projects/-Users-mba-ghq-github-com-daiki-beppu-live-mindmap*` | 50 フォルダ（メインと各 worktree）。auto memory は 14 ファイルが名前に触れる | 変えると壊れる: フォルダ名はチェックアウトのパスから作られる。チェックアウトのパスを変えると、auto memory（`MEMORY.md` と各記憶）が新しいパスから読まれなくなる。移すかパスを据え置く |
| 案内役（guide）の常駐 | `guide.mjs daiki-beppu/live-mindmap --from 1284` が 2 つ動いている。`desk.mjs` は引数と `gh repo view` の `nameWithOwner` を照合し、違えば止まる（`~/.claude/skills/guide/scripts/desk.mjs:141`） | 変えると壊れる: GitHub の改名の後、旧名の引数のままだと起動し直したときに止まる。新しい名前の引数で起動し直す |
| takt | 手元の設定 `~/.takt/` に名前は無い。リポジトリの `.takt/`（gitignore 済み）の `config.yaml` はコメントに名前があるだけ。takt の worktree は `~/ghq/github.com/daiki-beppu/takt-worktrees/` | 変えられる。動いている run がある間に改名しない |
| `~/.claude/skills`（takt・guide） | takt の参考文書・スクリプトのコメントに 5 ファイル、guide のテストに 5 ファイル（dotfiles の `config/.agents/skills/` が元） | 変えられない（変えなくてよい）: 過去の出来事の例として名前を出しているだけ。利用者の自作スキルなので、直すなら dotfiles 側 |
| `~/agent-memory` | 2 ファイル（`MEMORY.md`・`agent-skills.md`）。どちらも過去の出来事の例 | 変えられる（変えなくてよい） |
| 手元の保存済みのセッション | `~/.live-mindmap/sessions/` に 3 件（中身は読んでいない） | 変えると壊れる（上の「保存先のパス」） |
| 評価のサンプル `~/live-mindmap-samples/` | 存在する。AGENTS.md・`server/bench/README.md`・`docs/publishing.md` から 12 回参照 | 変えると壊れる（軽い）: 文書の中のパスと、手元のフォルダ名を同時に変える。コードの既定値には無い |
| `~/Library/Caches/live-mindmap-helper/` | 存在する（URLCache） | 変えられる（旧フォルダが残るだけ） |
| `~/Library/Logs/live-mindmap-release-maps.log` | 2026-10-27 の一回きりの作業のログ（記憶 `design-review-maps-release.md` から） | 変えられない（変えなくてよい）: 過去のログ |
| `~/Library/Application Support/` | 名前を含むフォルダは無い | — |
| launchd | `~/Library/LaunchAgents`・`/Library/LaunchAgents`・`/Library/LaunchDaemons` に名前を含む plist は無い。`launchctl list` にも無い | — |
| cloudflared | `~/.cloudflared` は無い。cloudflared は管理依存として `~/.live-mindmap/deps` に入り、閲覧の共有はその場限りのトンネル | — （保存先のパスに含まれる） |
| Cloudflare の Worker（公開） | 名前は `lmm-<乱数>`。公開の記録は手元に無い | 上の `lmm-` の行 |
| シェルの設定・dotfiles の環境変数 | 名前を含む設定は無い | — |

## 調べ方

- 追跡ファイル: `git grep -IEio 'live[-_ ]?mind[-_ ]?map'`（大文字小文字を区別しない変種の検出）、`git grep -IEoh 'LIVE_MINDMAP_[A-Z0-9_]+' | sort | uniq -c`、URL を除いた形の集計（`grep -v 'github.com/daiki-beppu/live-mindmap'`）、フォルダごとの `git grep -Il ... | wc -l`。
- 手元: `which live-mindmap`、`gh repo view` と `gh api repos/daiki-beppu/live-mindmap`、`orca repo list --json`、`ls ~/.live-mindmap/*`（件数と `du -sh` だけ）、`find ~/Library/{Application Support,Caches,Logs,Preferences} -maxdepth 1 -iname '*mindmap*'`、LaunchAgents・LaunchDaemons の `grep -il`、`grep -rIl` を `~/.takt`・`~/agent-memory`・`~/.claude/skills`・dotfiles・シェルの設定に、`ps -axo command` で動いている常駐の引数。

## 残る問い（#1857 の互換の ticket の材料）

- `~/.live-mindmap/` を新しい名前に移すか、旧名のまま据え置くか。移すなら、旧フォルダがあれば読む・移す仕組みが要る。
- `LIVE_MINDMAP_*` の旧名を当面受け付けるか（新旧の両方を読む）。
- 画面のタイトルの除外で、旧名のタイトルも除き続けるか。
- 手元のチェックアウトのパス（ghq・Orca・Claude Code の記憶）を新しい名前に移すか。
- helper の実行ファイル名を変えたとき、画面収録などの許可を求め直すか（実機で確かめる）。
