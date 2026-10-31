# Claude cloud の環境をファイルで決める範囲

issue #1786（map #1784）。Claude Code on the web（Claude cloud、Anthropic がホストする環境）の環境を、リポジトリに置くファイルでどこまで決められるかを、Anthropic の公式ドキュメントで確かめた。読んだ日: 2026-10-31。

主な出典:

- [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments)（以下 CE）
- [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)（以下 Web）
- [Settings files and precedence — Settings in cloud sessions](https://code.claude.com/docs/en/settings#settings-in-cloud-sessions)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Skills — Use skills in Cowork and cloud sessions](https://code.claude.com/docs/en/skills)
- [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading)

## 結論

- **environment（ネットワークの段階・環境変数・セットアップスクリプト・network secrets）は UI でしか決められない。** claude.ai/code の環境の選択欄（Desktop app・管理画面の共有環境を含む）で設定する。リポジトリのファイルから読む仕組みは無い。セットアップスクリプトは「Choose file」で 64 KB までのファイルの中身を UI に貼れるだけで、repo のファイルを参照し続けるわけではない。（CE [Configure your environment](https://code.claude.com/docs/en/cloud-environments#configure-your-environment)、[Add a setup script](https://code.claude.com/docs/en/cloud-environments#add-a-setup-script)）
- **ファイルで決められるのは、clone に入る repo 側の設定**: `CLAUDE.md`・`.claude/settings.json`（hooks・permissions・`env`）・`.claude/rules/`・`.claude/skills/`・`.claude/agents/`・`.claude/commands/`・`.mcp.json`。ただし settings.json と `.mcp.json` は「repo 1 つのセッション」で、project のスレッドの外に限る。（CE [What carries over from your setup](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup)）
- **依存の導入は repo の SessionStart hook でできる。** `CLAUDE_CODE_REMOTE=true` でクラウドだけに絞る形を公式が例示している。時間制限は command hook の既定 600 秒（`timeout` で変更可、`async: true` なら制限なし）。（CE [Install dependencies with a SessionStart hook](https://code.claude.com/docs/en/cloud-environments#install-dependencies-with-a-sessionstart-hook)、[Time limits](https://code.claude.com/docs/en/cloud-environments#time-limits)）
- **標準イメージの Node は 20・21・22（PATH は 22）で、24 は入っていない。** 既定の許可リスト（Trusted）に `nodejs.org`・`registry.npmjs.org`・GitHub の release 配布ホストが入っているので、Node 24 と pnpm 12 は取りに行ける。
- **ユーザー側の `~/.claude`（グローバル CLAUDE.md・skills・settings・hooks）と repo の `enabledPlugins` の plugin はクラウドで読まれない。**

## 1. UI で決めるもの（environment）

| 項目 | どこで決めるか | 補足 | 出典 |
|---|---|---|---|
| ネットワークの段階 | 環境ダイアログの **Network access**（None / Trusted / Full / Custom） | 既定の **Default** 環境は Trusted。Custom は 1 行 1 ドメイン、「Also include default list」で Trusted の一覧も足せる。組織全体の許可リストや server-managed setting でドメインを足す手段は無い | CE [Access levels](https://code.claude.com/docs/en/cloud-environments#access-levels)、[Allow specific domains](https://code.claude.com/docs/en/cloud-environments#allow-specific-domains) |
| 環境変数 | 環境ダイアログの **Environment variables**（`.env` 形式） | その環境を使う人は誰でも値を読める。秘密は置かない | CE [Set environment variables](https://code.claude.com/docs/en/cloud-environments#set-environment-variables) |
| セットアップスクリプト | 環境ダイアログの **Setup script** | root・Ubuntu 24.04 で、Claude Code の起動前に走る。非 0 で終わるとセッションが立たない。環境変数はまだ入っていない。約 5 分以内に終わるとファイルシステムのスナップショットが取られ、次回からは省かれる（スクリプトかネットワーク設定の変更、または約 7 日で作り直し） | CE [Setup scripts](https://code.claude.com/docs/en/cloud-environments#setup-scripts)、[Script requirements](https://code.claude.com/docs/en/cloud-environments#script-requirements)、[Environment caching](https://code.claude.com/docs/en/cloud-environments#environment-caching) |
| network secrets | 環境ダイアログ | 鍵は VM に入らず、プロキシが指定ホストへのリクエストに付ける。今回は API キーを渡さないので使わない | CE [Add network secrets](https://code.claude.com/docs/en/cloud-environments#add-network-secrets) |
| 権限モード | セッション作成時のドロップダウン | | Web [Permission modes in cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web#permission-modes-in-cloud-sessions) |

環境は「アカウントごと」（Owner が作る共有環境もある）で、リポジトリには紐付かない。同じ環境を他の repo のセッションでも使う。

`/config` はクラウドでは claude.ai の設定画面を開くだけ。セッションの設定を変えたいときは環境の環境変数か、repo の `.claude/settings.json` にキーを書く。（[Settings in cloud sessions](https://code.claude.com/docs/en/settings#settings-in-cloud-sessions)）

## 2. ファイルで決めるもの（repo の clone に入るもの）

CE [What carries over from your setup](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup) の表の要点:

| repo のファイル | クラウドで効くか |
|---|---|
| `CLAUDE.md`、`.claude/rules/` | 効く |
| `.claude/settings.json` の hooks・permissions・`env` | repo 1 つのセッションで効く。repo 複数のセッションは `enabledPlugins`・`extraKnownMarketplaces` しか読まず、project のスレッドは何も読まない |
| `.mcp.json` | repo 1 つのセッションで効く |
| `.claude/skills/`・`.claude/agents/`・`.claude/commands/` | 効く（project のスレッドでは skills は効かない） |
| `.claude/settings.json` の `enabledPlugins`・`extraKnownMarketplaces` | **効かない**。クラウドはこれらの plugin を入れない。marketplace の追加はワークスペースの信頼ダイアログを要し、クラウドはそれを出さないため（[Plugin loading — Plugins shared through a repository](https://code.claude.com/docs/en/plugins/loading#plugins-shared-through-a-repository)） |
| `.claude/settings.json` の `env` のうち `NODE_EXTRA_CA_CERTS` など通信系 | 無視される |
| `.claude/settings.local.json` | 読まれない（clone に入らない） |

AGENTS.md について: 公式の表は `CLAUDE.md` だけを挙げる。この repo のルートに `CLAUDE.md` は無く `AGENTS.md` だけがある。Claude Code が `AGENTS.md` を自動で読むかは、この調査の範囲では一次情報で確かめていない。確実にするなら `CLAUDE.md` に `@AGENTS.md` を書いて取り込む（仕様で決める）。

## 3. SessionStart hook とクラウドの見分け方

- **クラウドの判定**: セッションの VM には `CLAUDE_CODE_REMOTE=true` が入る。手元では `true` にならない。公式例は `if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then exit 0; fi` で始める。セッション ID は `CLAUDE_CODE_REMOTE_SESSION_ID`（`cse_…`）。（CE [Install dependencies with a SessionStart hook](https://code.claude.com/docs/en/cloud-environments#install-dependencies-with-a-sessionstart-hook)、[Link output back to the session](https://code.claude.com/docs/en/cloud-environments#link-output-back-to-the-session)）
- **書き方**: repo の `.claude/settings.json` に `"SessionStart": [{"matcher": "startup|resume", "hooks": [{"type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR\"/scripts/….sh"}]}]`。`$CLAUDE_PROJECT_DIR` は repo のルート。matcher は `startup`・`resume`・`clear`・`compact`・`fork`。（Hooks reference の SessionStart）
- **何度も走る前提で書く**: hook は resume を含めセッションの開始ごとに走り、セットアップスクリプトのキャッシュは効かない。公式例は lockfile とスクリプトの sha256 を `node_modules/` に記録し、変わっていなければ install を飛ばす。pnpm workspace なら各 package の `package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml` もハッシュに入れる（公式も「workspace の package.json を足す」と注記）。
- **時間制限**: command hook は既定 600 秒で取り消される。`timeout`（秒）で変えられる。`async: true` にすると待たずに裏で走り、`timeout` は課されない。ただし async の結果は次のターンに届くだけで、Claude はその間に install 前の状態でコマンドを打ちうる。（CE [Time limits](https://code.claude.com/docs/en/cloud-environments#time-limits)、Hooks [Run hooks in the background](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)）
- **PATH の受け渡し**: SessionStart hook は `CLAUDE_ENV_FILE` に `export` 行を追記すると、以降の Bash コマンドに効く（各コマンドの前にその内容が実行される）。Node 24 を `/opt` などに入れた場合、`echo 'export PATH="/opt/node24/bin:$PATH"' >> "$CLAUDE_ENV_FILE"` のように渡せる。（Hooks reference の SessionStart「Persist environment variables」）
- **セットアップスクリプトとの分担（公式の推奨）**: VM そのものの用意（イメージに無いツールチェーン）はセットアップスクリプト、手元とクラウドの両方で走らせたいプロジェクトの準備（`npm install` など）は SessionStart hook。順序はセットアップスクリプト → Claude Code 起動 → SessionStart hook。（CE [Setup scripts vs. SessionStart hooks](https://code.claude.com/docs/en/cloud-environments#setup-scripts-vs-sessionstart-hooks)）

## 4. 標準イメージと既定の許可リスト

- Ubuntu 24.04・x86_64。目安 4 vCPU・16 GB RAM・30 GB ディスク。（CE [What's available in cloud sessions](https://code.claude.com/docs/en/cloud-environments#whats-available-in-cloud-sessions)、[Resource limits](https://code.claude.com/docs/en/cloud-environments#resource-limits)）
- **Node.js は 20・21・22**（`/opt/node20` 等、PATH は 22）。npm・yarn・pnpm・bun 入り。pnpm の版は書かれていない（セッション内で `check-tools` を実行すると版が出る）。Bun はプロキシとの相性問題があると明記。（CE [Installed tools](https://code.claude.com/docs/en/cloud-environments#installed-tools)）
- Docker・PostgreSQL・Redis・gh・jq なども入っている。イメージ自体を差し替える手段は無い。
- Trusted の既定許可リスト（CE [Default allowed domains](https://code.claude.com/docs/en/cloud-environments#default-allowed-domains)）にこの repo に関わるものは入っている:
  - npm: `registry.npmjs.org`、`npmjs.com`、`registry.yarnpkg.com` など
  - Node 本体: `nodejs.org`
  - GitHub: `github.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`raw.githubusercontent.com`
  - Playwright のブラウザ配布元（`cdn.playwright.dev` など）は一覧に無い。Chromium の実導入（`pnpm cli install chromium`・`test:external`）はクラウドでは Custom に足さない限り通らない見込み（範囲外なので影響は小さい）。
- **Node 24 と pnpm 12 の入れ方（推論、未実測）**: `nodejs.org` が許可されているので、セットアップスクリプトで Node 24 の tarball を `/opt/node24` に展開し、`corepack` または `npm i -g pnpm@12.11.2` で pnpm を入れる形が取れる。スナップショットに残るので次回からは数秒で済む。pnpm 12 が要求する Node の版、イメージの pnpm が `packageManager` の版へ自動で切り替えるかは、実際のセッションで確かめる必要がある。

## 5. ユーザー側の `~/.claude` と plugin

| 手元の設定 | クラウドで | 代わりの手段 | 出典 |
|---|---|---|---|
| `~/.claude/CLAUDE.md` | 読まれない | セットアップスクリプトで `~/.claude/CLAUDE.md`（`/root/.claude/CLAUDE.md`）を書く。共有環境ではなく自分の環境に置く | CE [Add personal preferences without committing to the repo](https://code.claude.com/docs/en/cloud-environments#add-personal-preferences-without-committing-to-the-repo) |
| `~/.claude/skills/`・`agents/`・`commands/` | 読まれない | repo の `.claude/` に commit するか、claude.ai のアカウントで skill を有効にする（クラウドのセッション開始時に同期される） | CE 同表、[Skills](https://code.claude.com/docs/en/skills) |
| `~/.claude/settings.json`（hooks・permissions・`enabledPlugins`） | 読まれない | repo の `.claude/settings.json` に書く | [Settings in cloud sessions](https://code.claude.com/docs/en/settings#settings-in-cloud-sessions) |
| user・local スコープの MCP（`~/.claude.json`） | 読まれない | `claude mcp add --scope project` で `.mcp.json` に書いて commit | CE 同表 |
| repo の `enabledPlugins`（pstack など marketplace の plugin） | 入らない | plugin の skill を repo の `.claude/skills/` に写すか、claude.ai 側で有効にする。claude.ai で有効にした plugin（`@synced`）は「Cowork とターミナル」で読まれると書かれており、クラウドセッションで読まれるかは明記が無い | [Plugin loading — Plugins synced from claude.ai](https://code.claude.com/docs/en/plugins/loading#plugins-synced-from-claudeai) |

この repo への影響: ユーザーのグローバル CLAUDE.md の判断基準（Orca の worktree、`vp`、`gh-subissues` など）や、`poteto-mode`・`pstack:poteto-agent`・`wayfinder` などの手元の skill・plugin はクラウドに無い。map の Notes にある「実装は poteto-mode で行う」をクラウドで守るなら、仕様で扱いを決める必要がある。

## 6. 注意点

- **`gh issue`・`gh pr` が使えない。** GitHub への通信は専用プロキシを通り、GraphQL は 403 で拒否される。`gh pr`・`gh issue` のサブコマンドは GraphQL を使うので失敗する。REST の `gh api repos/{owner}/{repo}/...` か、組み込みの GitHub ツールを使う。プロキシはセッションに付いた repo 以外への API・archive 取得も 403 にし、ブランチ削除と tag の push も拒否する。（CE [GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy)）AGENTS.md の `gh pr merge --squash --auto` などはクラウドではそのまま動かない。
- **`GH_TOKEN`/`GITHUB_TOKEN` はプレースホルダ `proxy-injected`。** 直接トークンを読むスクリプトは動かない。（CE [Work with GitHub issues and pull requests](https://code.claude.com/docs/en/cloud-environments#work-with-github-issues-and-pull-requests)）
- **コマンドの時間制限**: Bash は既定 2 分、最大 10 分。超えると裏に回り、さらに 30 分で止まる。`BASH_DEFAULT_TIMEOUT_MS`・`BASH_MAX_TIMEOUT_MS` は環境の環境変数（UI）で上げる。`pnpm typecheck` が長い場合に効く。（CE [Time limits](https://code.claude.com/docs/en/cloud-environments#time-limits)）
- **セットアップスクリプトの変更は既存セッションに効かない。** 新しいセッションか、VM が作り直されたときに効く。環境変数も VM の復帰・再構築時に読み直す。
- **project のスレッドと repo 複数のセッションでは repo の hooks が走らない。** その場合はセットアップスクリプトで依存を入れる。
- **helper（Swift）**: `swift.org` は許可リストにあるが、イメージは Linux で helper は macOS 専用。`pnpm -r typecheck`・`pnpm test` は helper を含むので、クラウドでは `--filter` で外すか、helper 側がクラウドを判定して飛ばす必要がある（Linux で通るコマンドの ticket で決める）。
- `vp`（vite-plus）はイメージに無い。`orca.yaml` の `vp install` をそのまま共通スクリプトに入れるなら、`pnpm install --frozen-lockfile` に寄せるか vp を入れる。

## 仕様への含意

1. repo 側（ファイル）: `.claude/settings.json` に SessionStart hook、`scripts/` に共通のセットアップスクリプト（`CLAUDE_CODE_REMOTE` 判定、ハッシュで install を飛ばす、Node 24 の PATH を `CLAUDE_ENV_FILE` に書く）。必要なら `CLAUDE.md` から `@AGENTS.md` を取り込む。
2. UI 側（手順として README・docs に書く）: 環境を 1 つ作り、Network access は Trusted、セットアップスクリプトは「repo の共通スクリプトを呼ぶ数行」か「Node 24 と pnpm を入れる数行」を貼る。環境変数に `BASH_DEFAULT_TIMEOUT_MS` など。API キーは置かない。
3. hook とセットアップスクリプトの分担: Node 24・pnpm 12 はセットアップスクリプト（キャッシュされる）、`pnpm install` は hook（lockfile の変化に追従する）を基本にする。セットアップスクリプトから repo のファイルを呼ぶ形は、実セッションで確かめてから採る。Web の `--cloud` の説明は起動の手順を「repo の clone、セットアップスクリプトの実行」の順に挙げるが、スクリプトの作業ディレクトリや repo のパスは CE に明記が無い。また環境はアカウント単位で他の repo とも共有されうるので、スクリプトは repo が無くても 0 で終わるように書く。hook 側は `$CLAUDE_PROJECT_DIR` で確実に repo を読める。
