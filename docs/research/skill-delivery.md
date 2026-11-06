# エージェント向けの skill を repo の外へ届ける方法

調べた日: 2026-11-06。対象: [#1931](https://github.com/daiki-beppu/live-mindmap/issues/1931)（map [#1930](https://github.com/daiki-beppu/live-mindmap/issues/1930)）。方式の選定はしない。[#1934](https://github.com/daiki-beppu/live-mindmap/issues/1934) で決める。

前提: CLI は .app に同梱して PATH に通す予定（map [#1865](https://github.com/daiki-beppu/live-mindmap/issues/1865)）。サーバーは持たない（[ADR 0018](../adr/0018-host-on-cloudflare-with-alchemy-not-now.md)）。

確かめた版: Claude Code の CHANGELOG 先頭 2.1.318、Codex `rust-v0.167.0`、`skills` 1.7.6、Kanary 4.1.8。各ドキュメントのページには更新日の表示が無い。

## 要点

- **標準は置き場所も配り方も決めていない。** 置き場所の慣行は `.agents/skills/` だが、Codex は読み、Claude Code は `.claude/skills/` と plugin だけを読む（公式の表に `.agents` が無く、対応の要望が open）。両方へ届けるには、2 か所に置くか、片方を symlink にする。
- **skill が求める CLI の版を、エージェントが確かめる仕組みは無い。** `compatibility` は自由記述で、Claude Code は「accepts the field but doesn't act on it」、Codex のパーサーは読まない。版のずれへの備えは、配り方か skill の本文で作るしかない。
- **ずれの大きさは、skill の更新が CLI と同じ経路かで決まる。** .app の中身を直接読ませる方式（symlink・`command` source・ローカルの marketplace）は同時に変わる。GitHub から取る方式（marketplace・`skills` CLI）は別の経路で、Claude Code の marketplace と `skills` CLI は既定では自動で更新されない（Codex の既定は未確認）。
- **Kanary は展開したコピーを手動で更新する方式で、手元で実際にずれている。** .app と同梱の CLI は 11-04 の 4.1.8 なのに、skill は 9-26 のままで、`references/contract.md` がひな形と 2 行違う。
- **どの方式もサーバーは要らない。** repo は public なので、GitHub だけで足りる。

## 選択肢の一覧

| | 方式 | 届く先 | 誰がいつ入れるか | 更新の経路 | CLI とのずれ |
|---|---|---|---|---|---|
| A | .app か CLI が展開したコピー（Kanary） | 両方（実体 + symlink） | 利用者がボタンやコマンドで | 再展開するまで届かない | 起きる。CLI だけ先に進む |
| B | .app の中への symlink | 両方 | 同上 | .app の更新と同時 | 原理上は起きない。実機では未検証 |
| C | GitHub の marketplace の plugin | Claude Code、Codex は別に登録 | 利用者かエージェントが 2 コマンド | Claude Code は自動更新が既定で off | 起きる。どちらにも進む |
| D | ローカルの marketplace（.app の中） | Claude Code、Codex は未確認 | 同上 | 次のセッションで .app の中身を読む | 原理上は起きない。実機では未検証 |
| E | plugin の `command` source | Claude Code のみ | 2 コマンド + コマンドの承認 | セッションごとに再実行 | 原理上は起きない。実機では未検証 |
| F | `skills` CLI（`npx skills add`） | 両方 + 他のエージェント | 利用者かエージェントが 1 コマンド | `skills update` を手で | 起きる。どちらにも進む |
| G | Codex の `$skill-installer` | Codex のみ | 利用者が Codex の中で | 更新の手順が無い | 起きる |
| H | 手で置く（README の案内、URL） | 置いた先 | 利用者かエージェントが | 届かない | 起きる |

3 章に各方式の詳細、4 章にずれの表、5 章に live-mindmap での制約がある。

## 1. Kanary の方式

手元の Kanary.app 4.1.8（build 101、2026-11-04 公開。[appcast](https://distro.kanary.to/appcast.xml)）を読むだけで調べた。Kanary は実行していない。根拠の種類を、各項目に「確認」「推定」「不明」で書く。

### 1.1 .app の中にあるもの

`Contents/Frameworks/KanaryUIVoice.framework/Versions/A/Resources/` に、skill のひな形がある。

| ファイル | 役割 |
|---|---|
| `SKILL.md.template` | 本文。`{{skillName}}`・`{{cliName}}`・`{{appBundleName}}` と、下の断片を差し込む `{{channelSafetyGuidance}}`・`{{channelSkillAppendix}}` を持つ |
| `contract.md.template` | `references/contract.md` になる。CLI の JSON の形 |
| `troubleshooting.md.template` | `references/troubleshooting.md` になる。`{{channelTroubleshootingAppendix}}` を持つ |
| `ChannelReleaseSafety.md.template` | リリース版の Safety の 1 行。アプリのデータを触らせない |
| `ChannelDebugSafety.md.template` | デバッグ版の Safety。読むだけなら許す |
| `ChannelDebugSkillAppendix.md.template` | デバッグ版だけに付く「Maintaining This Skill」 |
| `ChannelDebugTroubleshootingAppendix.md.template` | デバッグ版だけに付く UI 自動操作の注意 |

ビルドの種類（`release`・`debug`）で断片を選び、CLI の名前と .app の名前を差し込んで 1 つのツリーを作る仕組みである（確認。文字列に `AgentSkillTemplateChannel`・`release`・`debug`・`templateChannel` がある）。

### 1.2 手元の導入先との比較

`~/.claude/skills/kanary` と `~/.agents/skills/kanary` は、同じ構成（`SKILL.md`・`references/contract.md`・`references/troubleshooting.md`）を見せる。

**この 2 つは別々のコピーではない。** この Mac では `~/.claude/skills` と `~/.agents/skills` がどちらも `dotfiles/config/.agents/skills` への symlink で、`SKILL.md` の inode も同じ（823658236）だった。利用者の dotfiles の構成によるもので、Kanary の仕組みではない。「2 か所の中身が同じ」ことから Kanary の動きは何も言えない。

ひな形と導入先の差は次のとおり（`diff` で確認）。

- `SKILL.md`: 差し込みの差だけ。`{{channelSafetyGuidance}}` はリリース版の 1 行に置き換わり、`{{channelSkillAppendix}}` は空になっている。「Maintaining This Skill」は導入先に無い。
- `troubleshooting.md`: 差し込みの差だけ。デバッグ版の追記は無い。
- `contract.md`: **中身が 2 行違う。** どちらも導入先のほうが古いと読める。
  - 導入先は `macos/docs/specs/cli.md` を正本として指す。ひな形はこの文を除いている。
  - 導入先の `upgrade_url` は `kanary.download`、ひな形は `kanary.to`。

### 1.3 誰がいつ展開するか

**利用者が設定画面のボタンを押したときに、.app が展開する。**（確認。.app の文字列と文言）

- 導入の口は `AgentSkillInstallService`。設定の Voice の Automation の枠に「Install CLI & Agent Skill」「Install Skill」のボタンがある。
- 説明文は ``Installs the `%@` command at `%@` and the `/%@` Agent Skill at `%@`, linked from `%@`.`` で、CLI と skill を 1 回で入れる。
- デバッグ版の追記は `~/.agents/skills/{{skillName}}` を実体、「their Claude symlinks」をリンクと呼ぶ。文字列 `canonicalURL`・`claudeLinkURL`・`../../.agents/skills/` もある。したがって **実体は `~/.agents/skills/kanary`、`~/.claude/skills/kanary` はそこへの相対 symlink** である。
- Codex は `~/.agents/skills` を直接読む（2.3）ので、リンクが要らない。Cursor も文言に挙がっているが、Cursor 向けのリンクの文字列は見つからなかった。Cursor の読み込み先は、この調査では調べていない。
- CLI は `Contents/Helpers/kanary` への symlink を `~/.local/bin/kanary` に置く（確認。手元の symlink と文言 ``Update `%@` to point at this Kanary app.``）。

状態は次の 7 つ（確認。`AgentSkillInstallState` の近くの文字列）。

| 状態 | 文言・動き |
|---|---|
| `missing` | ``Install `/%@` to `%@`.`` |
| `installed` | ``/%@ is installed for agents.`` |
| `updateAvailable` | ``Review and update `/%@`.`` |
| `needsRepair` | ``Repair `/%@` Agent Skill links.``。中身に差が無いときは「No content changes. This will repair skill links.」 |
| `installedWithClaudeConflict` | `~/.agents` 側は入ったが、Claude 側に Kanary の管理でないものがある |
| `conflict` | ``Cannot install because `%@` already exists and is not managed by Kanary.`` |
| `templateMissing` | 「Bundled Agent Skill template is missing.」 |

既にあるものを上書きせず、管理しているか否かを見分ける作りである。

### 1.4 更新はどう届くか

- **CLI**: symlink の先が .app の中なので、Sparkle で .app が更新されれば CLI も同時に変わる（確認。`SUAutomaticallyUpdate` = true、`SUFeedURL` = `https://distro.kanary.to/appcast.xml`）。
- **skill**: **.app の更新では書き換わらない。** 利用者が「Review & Update...」を押し、差分（`AgentSkillDiffReview`、「Review Agent Skill Changes」「%d files changed, +%d / -%d lines.」）を見て再生成する（確認。文言）。

手元の日付がこれを裏付ける。

| もの | 日付 |
|---|---|
| skill の 3 ファイル | 2026-09-26 14:36:22 |
| `~/.local/bin/kanary` の symlink | 2026-09-26 15:23 |
| .app の中身（4.1.8） | 2026-11-04 16:55:23 |
| .app の置き換え | 2026-11-04 18:26:49 |
| 動いている Kanary の起動 | 2026-11-04 18:26:53 |

4.1.8 で起動した後も skill は 9-26 のままで、`contract.md` はひな形より古い。**CLI は新しく skill は古い、という版のずれが手元で実際に起きている。** ずれに気付く経路は設定画面の `updateAvailable` だけで、エージェントの側には届かないと読める（通知の有無は不明。Kanary を実行して確かめていない）。

### 1.5 ずれに対する skill 側の備え

Kanary は次の 3 つで、古い skill が害になりにくい形にしている（確認）。

- `SKILL.md` の frontmatter に版を書かない。`name` と `description` だけである。
- 「Run `kanary help` for the authoritative command list.」で、コマンド一覧の正本を CLI に置く。
- `contract.md` に「If an observed response-family version differs, treat this skill as stale: trust the live JSON field names and tell the user.」とある。CLI の JSON に `schema_version` があり、これが古さの検出に使われる。`kanary status` は `cli.version` も返す。

### 1.6 Kanary について分からないこと

- ボタン以外の導入の口（初回の案内の流れ、更新時の自動再生成の条件）があるか。文字列では見つからなかったが、無いとは言い切れない。Kanary を実行していない。
- `updateAvailable` の判定方法。文字列に版の比較らしいものは見つからず、生成結果との内容比較と推定する（`AgentSkillFileDiff`）が、逆アセンブルはしていない。
- 手元の skill がボタンで入ったものかどうか。9-26 の日付と内容はボタンでの導入と矛盾しないが、操作の記録は無い。`~/.agents/.skill-lock.json` に `kanary` の項目は無いので、`skills` CLI で入れたものではない。
- Kanary の公開文書に導入の説明があるか。[kanary.to](https://kanary.to/)・[/agents](https://kanary.to/agents)・[blog](https://kanary.to/blog/harness-of-harnesses) には、導入場所や更新の説明は無かった（「Add /relay to Claude, Codex, and Cursor」の紹介のみ）。appcast の説明文にも Agent Skill・CLI の記述は無い。

したがって、1.3・1.4 の根拠は公式文書ではなく、.app の文字列と手元のファイルである。

## 2. 標準とエージェントの読み込み先

### 2.1 Agent Skills の標準

- 必須は `name`（親ディレクトリ名と一致）と `description`。任意は `license`・`compatibility`・`metadata`・`allowed-tools`。[specification](https://agentskills.io/specification)
- トップレベルの `version` は無い。参照の検証器は未知のキーをエラーにする。版を書くなら自由なマップの `metadata` に入れる。[validator.py](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py)
- `compatibility` は 500 字までの自由記述で、検証器は型と長さだけを見る。
- 配置は定めていない。「the Agent Skills specification does not mandate where skill directories live」とあり、`.agents/skills/` は広く使われる慣行として走査を勧めるだけである。配布と更新の規定も無い。[client implementation guide](https://github.com/agentskills/agentskills/blob/main/docs/client-implementation/adding-skills-support.mdx)

### 2.2 Claude Code

[Skills](https://code.claude.com/docs/en/skills) の表から。

| 場所 | パス | 名前 |
|---|---|---|
| Enterprise | managed settings の中の `.claude/skills/<name>/` | `/<name>` |
| Personal | `~/.claude/skills/<name>/` | `/<name>` |
| Project | `.claude/skills/<name>/` | `/<name>` |
| Plugin | `<plugin>/skills/<name>/` | `/<plugin>:<name>` |

- 同名は Enterprise > Personal > Project の順に勝つ。Plugin は名前空間があるので「Both load」になる。
- `<skill-name>` はディレクトリへの symlink でよい。target から読み、同じ target は 1 度だけ読む。
- `~/.claude/skills/` の変更はセッション中に反映される。ただし対象は `SKILL.md` の本文だけである。
- Personal は Cowork と cloud のセッションでは読まれない。
- **`~/.agents/skills` は読まない**（間接の確認）。公式の表に無く、`.agents` を読むと書いた文書も見つからず、対応の要望 [#107421](https://github.com/anthropics/claude-code/issues/107421)（2026-11-05 起票）が open である。「読まない」と明言した文書は無く、実機でも確かめていない。

### 2.3 Codex

[Build skills](https://learn.chatgpt.com/docs/build-skills) から。

| スコープ | パス |
|---|---|
| REPO | `$CWD/.agents/skills`、親のフォルダ、`$REPO_ROOT/.agents/skills` |
| USER | `$HOME/.agents/skills` |
| ADMIN | `/etc/codex/skills` |
| SYSTEM | Codex に同梱（`skill-creator`・`skill-installer`） |

- 「Codex supports symlinked skill folders and follows the symlink target」とある。
- 変更は自動で検出する。反映されなければ再起動する。
- 再利用する配布には plugin を勧めている（「For reusable distribution of your own skills, prefer plugins.」）。
- `$CODEX_HOME/skills` は、ソースでは「Deprecated user skills location」で、互換のために読まれる。[host_roots.rs](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)
- `agents/openai.yaml` は Codex 固有の任意の設定で、`dependencies.tools` は MCP だけに対応する。[openai_yaml.md](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/skill-creator/references/openai_yaml.md)

## 3. 各方式の詳細

### A. .app か CLI が展開したコピー（Kanary の方式）

ひな形を .app に持ち、`~/.agents/skills/<name>` に展開して、`~/.claude/skills/<name>` からリンクする。詳細は 1 章。

- 利点: 書き込む前に差分を見せられる。既存のものを壊さず、競合を見分けられる。ビルドの種類で中身を変えられる。
- 制約: 再展開の引き金が要る。Kanary は手動である。起動時に自動で再展開する形も考えられるが、利用者の編集を上書きする扱いを決める必要がある（Kanary の前例は無い）。
- 手元の例: この Mac のように `~/.claude/skills` と `~/.agents/skills` が同じディレクトリを指すと、リンクの作成先が実体と重なる。`skills` CLI はこの場合のための処理をソースに持つ（[installer.ts](https://github.com/vercel-labs/skills/blob/main/src/installer.ts) の redundant symlinks）。Kanary のこの場合の動きは確かめていない。

### B. .app の中への symlink

CLI の `~/.local/bin/kanary` と同じ形を skill にも使う。`~/.agents/skills/<name>` と `~/.claude/skills/<name>` を `.app/Contents/Resources/...` への symlink にする。**実例は見つけていない。** Claude Code と Codex の文書が symlink を認めていることからの組み立てで、手元で動かしていない。

- 利点: skill と CLI が同じ .app から来る。再展開が要らない。
- 未検証: Sparkle が .app を置き換えた直後の、動いているセッションの扱い。.app をゴミ箱に入れた後のリンク切れを各エージェントがどう扱うか。
- 制約: .app を動かすとリンクが切れる。`SKILL.md` の中のコマンドは .app に合うが、利用者が編集できない。.app を消すときのリンクの片付けが要る（[#1914](https://github.com/daiki-beppu/live-mindmap/issues/1914) の扱いに関わる）。

### C. GitHub の marketplace の plugin

repo に `.claude-plugin/marketplace.json` を置けば公開になる。登録も審査も無い（「with no submission form」[Publish](https://code.claude.com/docs/en/plugins/publish.md)）。

- 入れ方（Claude Code）: `claude plugin marketplace add <owner/repo>` の後に `claude plugin install <plugin>@<marketplace>`。v2.1.292 以上なら `claude plugin install <plugin> --marketplace <source>` の 1 行。[Install](https://code.claude.com/docs/en/plugins/install.md)
- 入れ方（Codex）: `codex plugin marketplace add owner/repo` の後に `/plugins` から入れる。`$REPO_ROOT/.claude-plugin/marketplace.json` も legacy-compatible として読む。manifest はルートの `plugin.json` で、Claude Code の `.claude-plugin/plugin.json` とは場所が違う。Codex が `.claude-plugin/plugin.json` を読むかは確かめられなかった。[plugins/build](https://developers.openai.com/codex/plugins/build)
- 版（Claude Code）: `plugin.json` の `version`、marketplace の entry の `version`、source の commit SHA の順に決まる。`version` を固定すると、文字列を変えるまで届かない。[Plugin loading](https://code.claude.com/docs/en/plugins/loading.md)
- 更新（Claude Code）: 自動更新は Anthropic の公式などを除き **「off for every other marketplace」**。作者が `marketplace.json` で on にする項目は無く、利用者が `/plugin` か設定で切り替える。[Host a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace.md)。手では `claude plugin update <plugin>@<marketplace>`。
- 更新（Codex）: 文書に自動更新の記述は無い。ソースには背景で marketplace を更新するスレッドがある（[manager.rs](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/manager.rs)）が、既定と適用範囲は確かめられなかった。手では `codex plugin marketplace upgrade`。
- 版の固定: 「One marketplace serves one version of each plugin at a time」。entry の `ref`・`sha` か、`marketplace add` の `#ref` で固定する。古い .app の利用者にだけ古い skill を渡す仕組みは無い。
- CLI の同梱: plugin の `bin/` は Bash ツールの PATH に載るが、「Plugin `bin/` directories come after the user's own `PATH` entries」で、利用者の PATH が先に勝つ。top-level の `bin/` を持つ plugin は claude.ai と Cowork では入らない。[Components](https://code.claude.com/docs/en/plugins/components.md)
- 名前は `/live-mindmap:<skill>` になる。A や B と同時に入れると「Both load」で 2 つ見える。
- この repo をそのまま marketplace にすると、repo 全体を clone する（GitHub の報告で約 18MB）。`--sparse` か `git-subdir`、または skill だけの別 repo で避けられる。

### D. ローカルの marketplace（.app の中）

`claude plugin marketplace add <ディレクトリ>` で .app の中を指す。ローカルから足した marketplace の相対パスの plugin は「loads in place」で、編集は次のセッションか `/reload-plugins` で効き、版を上げなくてよい。[Plugin loading](https://code.claude.com/docs/en/plugins/loading.md)。**実例は無く、.app の中を指して試してはいない。** .app を動かしたときの動きも未検証である。Codex の `codex plugin marketplace add ./local-root` は同じ動きかを確かめられなかった（キャッシュの版は `local` になる）。

### E. plugin の `command` source

「Use a `command` source when a tool installed on the user's machine produces the plugin directory」。plugin のディレクトリの絶対パスを 1 行で出すコマンドを entry に書く。[Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md)

- v2.1.229 以上。Claude Code だけで、Codex の source の一覧には無い。
- install・update のたびと、セッションごとに 1 回、背景で再実行する。自動更新の設定に関係しない。出力のハッシュが変われば新しい版として入れ直す。[Plugin loading](https://code.claude.com/docs/en/plugins/loading.md)
- `copy`（既定）は中身をキャッシュに複写してハッシュを版にする。`link` はその場で読み、パスを変えないと更新と見なされない。
- 利用者はコマンド全文を見て承認する。管理者は `disableCommandPluginSources` で止められる。
- コマンドは `sh` でホームから動くので、CLI が PATH に無いと失敗する。失敗したセッションで前の版が使えるかは確かめられなかった。
- entry を載せる marketplace（ローカルか GitHub）が別に要る。

### F. `skills` CLI

`npx skills add <source>` で入れる。[commands.md](https://github.com/vercel-labs/skills/blob/main/docs/commands.md)

- 取得元: `owner/repo`、`owner/repo@v1.2.3`、git URL、ローカルパス、`SKILL.md` やアーカイブの直リンク。
- 探す場所: repo のルート、`skills/`、`.agents/skills/`、`.claude/skills/`、`.claude-plugin/` の宣言など。[creating-skills.md](https://github.com/vercel-labs/skills/blob/main/docs/creating-skills.md)。この repo の `.agents/skills/` には開発者向けの skill も並ぶので、`-s` で名指しするか、`metadata.internal: true` で隠す。
- 置き場所: 既定は project、`-g` でホーム。正本は `<base>/.agents/skills/<name>` で、Claude Code には `~/.claude/skills` からの symlink を作り、Codex は追加のリンクが要らない。symlink に失敗すると copy に落ちる。[installer.ts](https://github.com/vercel-labs/skills/blob/main/src/installer.ts)、[agents.ts](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)
- 更新: `skills check` は更新があれば exit 1、`skills update` で入れ直す。自動では走らない。記録は `~/.agents/.skill-lock.json`（手元の v3 で 39 件）。
- 要件: Node 22.20 以上（`npm view skills`）。手元で動かしていないので、動きはソースからの読み取りである。
- テレメトリ: `https://www.skills.sh/tele/t` へ CLI の版、検出したエージェント名、install した source や skill などを送る。`DISABLE_TELEMETRY=1` か `DO_NOT_TRACK=1` で止まる。[troubleshooting.md](https://github.com/vercel-labs/skills/blob/main/docs/troubleshooting.md)

### G. Codex の `$skill-installer`

GitHub の repo のパスから入れる。既定の入れ先は `$CODEX_HOME/skills/<name>` で、これは文書から外れた場所である（[openai/skills#420](https://github.com/openai/skills/issues/420) が open）。宛先があれば中止し、更新の手順は無い。[SKILL.md](https://github.com/openai/skills/blob/main/skills/.system/skill-installer/SKILL.md)

### H. 手で置く

README に手順を書くか、エージェントに置かせる。道具は要らないが、更新も削除も見分けられない。

## 4. skill と CLI の版がずれたとき

| 方式 | CLI だけ新しくなる | skill だけ新しくなる | 気付く手がかり |
|---|---|---|---|
| A | Sparkle の後すぐ起きる。手元で実際に起きている | .app を戻したとき | .app の設定画面（Kanary の `updateAvailable`） |
| B | 起きないはず | 起きないはず | 不要。リンク切れは別の問題 |
| C | 既定で起きる。自動更新が off なので、`update` するまで古いまま | 起きる。commit を追う設定だと、未リリースの main が届く。Sparkle を切った利用者でも新しい skill が届く | `/plugin` の表示のみ。自動更新時は `Run /reload-plugins to apply` |
| D | 起きないはず。実行中のセッションは次の読み込みまで古い | 起きないはず | 不要 |
| E | セッションの開始直後の再実行までの間だけ | 同左 | 通知が出る |
| F | 起きる。`skills update` まで古いまま | 起きる。`owner/repo` は既定のブランチを取るので、未リリースの内容が届く | `skills check`。`@タグ` で固定したときに新しいタグを検知するかは未確認 |
| G・H | 起きる。戻す経路も無い | 起きる | 無い |

ずれると何が起きるかは、方式によらず skill の書き方で変わる。

- **skill の手順が CLI に無いもの**（消えたフラグ、変わった exit コード）: エージェントがエラーを受けて止まるか、別の手を試す。live-mindmap では exit 3（導入の同意）と exit 4（相手の了解）のように、**手順の守りが exit コードに結び付く**ので、意味が変わると安全の説明まで崩れる。
- **CLI にある機能を skill が知らない**: 使われないだけで害は小さい。
- **古さを判定する機械的な仕組みは、どのエージェントにも無い**（2.1）。

Kanary が使っている、方式に関係なく効く備えは 1.5 に書いた。コマンド一覧の正本を CLI の help に置くこと、JSON の `schema_version` が違えば古いと扱う規則を本文に書くことである。live-mindmap の CLI は今、`--version` を持つ（`server/src/cli.ts` の定数 `VERSION = "0.1.0"`）が、出力に `schema_version` は無い。版の付け方は #1865 の Not yet specified に残っている。

## 5. live-mindmap での制約

- **いつ使えるか**: A・B・D・E は .app か同梱の CLI が前提で、.app が出るまで使えない。C・F・G・H は今の repo のままでも使える。map #1930 は「まず repo の `.agents/skills/` で読める形を作る」としているので、F と C は置き場所を変えずに始められる（C は manifest の追加が要る）。
- **読み手**: #1865 の利用者はターミナルを開かない。A・B は .app のボタンにできる。C〜H はコマンドが要るが、エージェントが打てる。ただし、まだ skill を持たないエージェントに最初の 1 回を頼む経路になる。F は Node 22.20 以上を前提にする。.app 同梱の Node は `Contents/Helpers/` に置く案（[#1866](https://github.com/daiki-beppu/live-mindmap/issues/1866)）なので、それだけでは PATH に載らず、利用者の PATH に Node があるとは限らない。
- **同意**: ADR 0017 と [#1872](https://github.com/daiki-beppu/live-mindmap/issues/1872) は、導入を利用者の同意の後に行うと決めている。ホームのディレクトリに書く A・B も同じ問いになる。Kanary はボタンで入れ、更新は差分を見せる。
- **サーバー**: どの方式も自前のサーバーは要らない。F は外の skills.sh へテレメトリを送る。
- **会議の最中の更新**: Claude Code の自動更新は実行中のセッションを変えない。B と A の再展開はディレクトリの中身が変わるので、`SKILL.md` の本文がセッション中に変わる。会議中に変わることの影響は調べていない。
- **併用**: A か B と C・D・E を同時に入れると、Claude Code に 2 つ見える。組み合わせるなら、片方だけが入るようにする必要がある。

## 6. 分からなかったこと

- Claude Code が `~/.agents/skills` を読まないことの明言と実機確認（2.2）。
- Kanary の 1.6 に挙げた点。
- B・D・E を .app で実際に動かしたときの動き。とくに Sparkle の置き換え、リンク切れ、`command` の失敗時。#1934 で候補に残すなら、短い試作で確かめられる。
- Codex の plugin の自動更新の既定、実行ファイルの同梱、`.claude-plugin/plugin.json` を読むか、ローカルの marketplace の読み方。
- `skills` CLI の `@タグ` と更新検知の関係。実際の動き（ソースを読んだだけ）。
- Cursor など他のエージェントの読み込み先。今回は対象にしていない。
- Claude Code の plugin を、利用者が過去の版を指定して入れるオプション。文書の表には無いが、`--help` は見ていない。
- Agent Plugins の仕様（Codex の文書が触れている）は読んでいない。

## 出典の読み方

- Kanary は公式の文書に説明が無く、.app の文字列（`strings`）・`Localizable.strings`・手元のファイルと日付が根拠である。
- Claude Code の Skills・Plugin loading・Components・Marketplace reference は原文を直接確かめた。Codex の Build skills は要約の取得で確かめた。その他のページとソースは、調査のエージェントが読んだ結果を載せ、#107421・#420 の状態と `installer.ts`・`creating-skills.md` は別に確かめた。
