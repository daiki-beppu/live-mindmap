# Cursor の Cloud Agents の環境をファイルで決める範囲

issue: #1785（map #1784）。調べた日: 2026-10-31。一次情報は Cursor 公式ドキュメント（`cursor.com/docs/...`、各ページは末尾に `.md` を付けると素の Markdown で読める）と公式スキーマ。公式に書かれていないこと（標準イメージの Node の版）だけ、公式フォーラムの Cursor 側の回答で補った。

## 答え（要点）

- **ファイルで決められる**: `.cursor/environment.json` で、土台（`snapshot`・`build`（Dockerfile）・`image`）、`install`・`start`・`terminals`、`ports`、外向き通信の許可（`egressAllowlist`・`egressMode`）、MCP の許可、実行ユーザーを決められる。規約は `AGENTS.md`（入れ子も可）と `.cursor/rules/*.mdc` で渡す。
- **UI（dashboard）でしか決められない / UI が勝つ**: 環境を使うかどうかそのもの。保存済みの環境（個人 → チーム）が repo の `environment.json` より優先され、保存済み環境は **environment.json location** がその file を指すときだけ file を読む。ほかに secrets、Build の install の時間切れ（既定 90 分）、古い Build の扱い（Update stale builds、既定 24 時間）、ネットワークのチーム既定、マシンの資源（Enterprise は support に依頼）。
- **Node 24 と pnpm@12.11.2 をそろえる**: 標準イメージの Node は固定で、`.nvmrc` を読まない（2026-05 時点で 22.22.2）。確実なのは Dockerfile で Node 24 を入れること。pnpm は Node 24 に同梱の corepack で `packageManager` に合わせる。
- **何も渡さなくても動くか**: 動く。secrets は任意。ネットワークは既定で全許可なので npm registry・corepack・GitHub に届く。

## 1. `.cursor/environment.json` の書式

公式スキーマ: <https://www.cursor.com/schemas/environment.schema.json>（コメント可、末尾カンマ不可、未知のキーは不可 `unevaluatedProperties: false`）。

| キー | 意味 |
|---|---|
| `snapshot` | dashboard で保存した snapshot の ID を土台にする。`build`・`image` より優先 |
| `build.dockerfile` / `build.dockerfileContents` / `build.context` | Dockerfile を土台にする。パスは `.cursor/` からの相対（`.cursor/...` で始まればそのまま）。`context` の既定は `.cursor`、`.`・`./`・`..` は repo ルート |
| `image` | レジストリのイメージを土台にする |
| `agentCanUpdateSnapshot` | エージェントが snapshot を更新できるか。`build`・`image` のときは常に false |
| `install` | Build のたびに走る準備のコマンド。repo ルートで走る。冪等であること |
| `start` | エージェントの起動ごとに 1 回走る（Docker・DB などの常駐の起動） |
| `terminals` | `start` の後に tmux の共有ターミナルで走る常駐（`name`・`command`・`description`。`description` はエージェントに見える） |
| `ports` | 公開するポート |
| `egressAllowlist` / `egressMode` | 外向き通信の許可ドメインと、チーム・個人設定との合わせ方（`allow_all`・`parent_plus_network_settings`・`default_with_network_settings`・`network_settings_only`） |
| `disableAllMcpServers` / `mcpServerAllowlist` | MCP の可否 |
| `user` / `name` / `repositoryDependencies` / `chromeExecutablePath` / `enable_testing` | 実行ユーザー、名前、追加で clone 権限が要る repo、ブラウザ試験用 Chrome、computer use の可否 |

出典: <https://cursor.com/docs/cloud-agent/setup.md>（Configuration in code with environment.json / Important path behavior）、スキーマ。

### 実行の順番とタイミング

1. **Build**（背後で事前に走る。定期・設定や secrets の保存時・手動・エージェントの依頼で起動）: 土台のイメージ → 環境の repo を**既定ブランチ**で clone → `install` を最後まで → ディスクを snapshot → 成功した Build が active になる。
2. **エージェントの起動**: active な Build から起動 → `start` → `terminals`。
3. 機能ブランチで起動したときは、Build のディスクの上でそのブランチを checkout する。依存が変わっていれば、エージェントに install のコマンドが渡され、エージェントが流し直せる。
4. 既定ブランチで起動したときは、Build が記録したコミットから始まる。Update stale builds が on で Build が閾値（既定 24 時間）より古ければ最新を pull する。

注意点:

- Build が残すのは**ディスクだけ**。走っているプロセス・`export` した環境変数・メモリ上のキャッシュは残らない。PATH などは `~/.bashrc` などのファイルか Dockerfile の `ENV` に書く。
- Build が使う `environment.json` は**環境の既定ブランチ（main）のもの**。ブランチで試すには、設定を push してそのブランチでエージェントを起動する。
- Build が失敗しても active な Build は置き換わらない。**最初の Build が成功するまでは**、エージェントは Cursor の標準イメージで、snapshot・Dockerfile・`install` なしで起動する。
- Dockerfile では repo を `COPY` しない（Cursor が checkout する）。Docker のレイヤーはキャッシュされる。Dockerfile の土台は Debian / Ubuntu 系（computer use の条件）。git が要る（clone に使う。フォーラムの回答）。

出典: <https://cursor.com/docs/cloud-agent/builds.md>、<https://cursor.com/docs/cloud-agent/setup.md>（Install script / Startup commands / Manual setup with Dockerfile）。

### 環境の解決順（ファイルが効く条件）

repo（または repo の組）ごとに、最初に一致したものを使う。

1. 個人の保存済み環境
2. チームの保存済み環境
3. repo の `.cursor/environment.json`（単一 repo のときだけ）

保存済み環境は、その **environment.json location** が file を指すときだけ file を読む。dashboard で新しく作った環境は既定で **None (skip environment.json)**。ただし、環境がまだ無い単一 repo でエージェントを起動すると、Cursor は commit 済みの有効な `.cursor/environment.json` を探し、見つかれば新しい環境の location をそれに向ける。つまり、**file を main に入れてから最初のエージェントを起動する**のが、file を効かせる一番素直な順番。先に dashboard で環境を作った場合は、location を file に向け直す（UI の操作）。

出典: <https://cursor.com/docs/cloud-agent/setup.md>（Environment resolution order）。

## 2. 標準イメージの Node・pnpm と、Node 24 / pnpm@12.11.2 へのそろえ方

- 標準イメージは Ubuntu。公式ドキュメントには Node・pnpm の版の記載が**無い**。
- 公式フォーラムでの Cursor 側の回答: 標準イメージの Node は固定版で `.nvmrc` を読まない（2026-02-03）。2026-05-05 時点の既定は 22.22.2、「最新の LTS を使うはず」とのこと。<https://forum.cursor.com/t/cursor-cloud-agent-node-version-22-22/150647>
- 別の報告では、エージェントのシェルが同梱の古い Node を掴み、エージェントが `engines.node` を下げようとした。これは修正予定と回答されている（2026-06-03）。<https://forum.cursor.com/t/bug-report-agent-incorrectly-tries-to-lower-node-js-versions-legacy-incompatible-versions/159710>
- pnpm・corepack の標準イメージでの扱いは公式に記載が無い。

この repo には `.nvmrc` も `engines` も無く、CI は `actions/setup-node`（`node-version: 24`）と `pnpm/setup` で Node と pnpm をそろえている。版が標準イメージ任せでは決まらないので、そろえ方は次の 2 案。

**案 A（推奨）: Dockerfile で Node 24 を固定する**

```json
// .cursor/environment.json
{
  "build": { "dockerfile": "Dockerfile" },
  "install": "bash scripts/<共通のセットアップ>.sh"
}
```

```docker
# .cursor/Dockerfile（例。版や取得元は ticket で決める）
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y curl git ca-certificates sudo && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
RUN corepack enable   # Node 24 は corepack を同梱。pnpm は package.json の packageManager の版を使う
```

- `build` / `image` のときは `agentCanUpdateSnapshot` が常に false になる。エージェントが環境を勝手に変えないので、再現性がある。
- 実行ユーザーなどは公式の Docker 例（`ubuntu` ユーザー、パスワードなしの sudo）に合わせる必要があるかもしれない。最初の Build で確かめる。

**案 B: 標準イメージのまま `install` で Node 24 を入れる**

- `install` で nvm などで Node 24 を入れ、既定にする。PATH はシェルの起動ファイル（ディスク）に残す。`export` は Build の後に消える。
- 同梱の Node を掴む既知の不具合と合わせると、エージェントのシェルで本当に 24 になっているかが揺れやすい。動作確認で `node -v` を確かめる受け入れ条件が要る。

pnpm は、どちらの案でも corepack（`corepack enable` の後、`pnpm` が `packageManager: pnpm@12.11.2` を取ってくる）でそろう。取得先は `registry.npmjs.org` で、既定のネットワークで届く。

## 3. ネットワークと secrets（何も渡さない状態で動くか）

- **ネットワーク**: 既定で全許可（"The agent has internet access by default"）。dashboard（個人・チーム・保存済み環境）か `environment.json` の `egressMode`・`egressAllowlist` で絞れる。「Default + allowlist」の既定ドメインには `registry.npmjs.org`・`nodejs.org`・`github.com`・`*.githubusercontent.com`・`archive.ubuntu.com` などが入っている。Enterprise はチーム設定で固定できる。出典: <https://cursor.com/docs/cloud-agent/security-network.md>、既定ドメイン: <https://cursor.com/docs/agent/security/run-modes.md>（Network access）
- **secrets**: dashboard の Secrets タブで渡す（環境変数・Runtime Secret（出力で伏せ字）・Build Secret（Dockerfile のビルドだけ））。範囲は個人・チーム・環境。チームと環境の secrets は Build でも読めるが、個人の secrets は起動時だけ入る。**ファイルには書けない**。渡さなくても起動・Build はできる。この repo の `pnpm install`・型検査・単体テストは API キーを要らないので、何も渡さずに通る見込み。`test:external`・bench・eval はキーが要るので回らない（map の範囲外の決定と合う）。出典: <https://cursor.com/docs/cloud-agent/setup.md>（Environment variables and secrets）、<https://cursor.com/docs/cloud-agent/builds.md>（How secrets work with Builds）
- snapshot を取るときに `.env.local` があると snapshot に入る。公式は Secrets タブを勧めている。
- GitHub への push は Cursor の GitHub App（read-write）で行う。commit の作者は `Cursor Agent <cursoragent@cursor.com>` になり、起動者が `Co-authored-by` に付く。

## 4. AGENTS.md と `.cursor/rules` の読み方

- Cloud Agents は `AGENTS.md` を読む。公式は、クラウドだけの準備・試験の手順を `Cursor Cloud specific instructions` のような専用の節にまとめることを勧めている。出典: <https://cursor.com/docs/cloud-agent/setup.md>（Add cloud-specific instructions to AGENTS.md）
- `AGENTS.md` はルートと入れ子の両方に対応する。入れ子は、そのディレクトリ以下を触るときに親の内容と合わせて効き、より深いものが優先される。この repo の `web/AGENTS.md` もこれで効く。出典: <https://cursor.com/docs/rules.md>（AGENTS.md / Nested AGENTS.md support）
- `.cursor/rules/*.mdc` は repo 内のすべてのエージェントに効く。`.mdc` でないと無視される。frontmatter の `alwaysApply`・`globs`・`description` で効く範囲が決まる。優先はチームルール → プロジェクトルール → ユーザールールの順。出典: <https://cursor.com/docs/rules.md>、<https://cursor.com/docs/cloud-agent/best-practices.md>
- ルールの本文に書いた `@file` は中身が展開されず、エージェントが必要なときに読みに行く（エディタ・CLI・Cloud で同じ）。AGENTS.md から `docs/agents/checks.md` などへ参照で飛ばす今の書き方は、そのまま通じる。
- project skills（repo に commit したもの）も Cloud Agents で使える。出典: <https://cursor.com/docs/cloud-agent/best-practices.md>
- `.cursor/hooks.json` のコマンド型 hook も Cloud で走る。出典: <https://cursor.com/docs/cloud-agent.md>

## 5. この repo に当てはめたときの注意（後続の ticket へ）

- ルートの `pnpm typecheck` と `pnpm test` は `pnpm -r` で helper まで回り、helper は `swift build` と `/Library/...` のパスを使う。Linux では落ちる。クラウドでは CI の `ts` job と同じく `--filter @live-mindmap/server --filter @live-mindmap/web`（＋ e2e）に絞り、`pnpm fallow` は別に回す形になる。AGENTS.md の Checks に足すクラウド向けの記述（map の Not yet specified）はこれを前提に書く。
- `install` は Build のたびに走り、既存のディスクの上でも走る。共通のセットアップスクリプトは冪等にし、helper の段（`build-webrtc-apm.sh`・`swift package resolve`）は Linux では飛ばす。
- 設定を効かせるには **main に入れてから**最初のエージェントを起動する（Build は既定ブランチの設定を使う。先に dashboard で環境を作ったなら location を file に向ける）。
- 動作確認では、Build のログで `install` の成功を見て、起動したエージェントで `node -v`（24）と `pnpm -v`（12.11.2）、filter 付きの typecheck・test が通ることを見る。エージェントは Cursor Cloud MCP の `environment-info` で、どの Build から起動したかを返せる（<https://cursor.com/docs/cloud-agent/builds.md>）。
