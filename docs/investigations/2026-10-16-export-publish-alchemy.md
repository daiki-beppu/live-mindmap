# エクスポートの公開を Alchemy で置き・消しできるか（Issue #1218）

エクスポートの公開（地図 [#1206](https://github.com/daiki-beppu/live-mindmap/issues/1206)）では、合言葉で暗号化した HTML を `lmm-<乱数>` の Worker（Workers Static Assets、`run_worker_first: true`、期限後は 410）に置くと決めた（[#1209](https://github.com/daiki-beppu/live-mindmap/issues/1209)）。その置き・消しを、ADR 0018 のホスティングの道具である Alchemy でできるかを調べた。

調べたのは 2026-10-16 時点の `alchemy@2.0.0-beta.83`（npm の `latest`）。一次資料は Alchemy の公式ドキュメント（alchemy.run。中身はリポジトリの `website/` にある）、[alchemy-run/alchemy](https://github.com/alchemy-run/alchemy) のソース（コミット `9e3c058`、2026-10-15）、npm レジストリ、Cloudflare の API リファレンス。手元で npm に入れて大きさを測り、偽のトークンで Node から呼んで、Cloudflare の API に届くところまでを確かめた。実アカウントへの配置はしていない。資料から読み取った推測は「推測」と書いた。

ソースへのリンクは、以下 `src/` を `https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/` の略として書く。

## 結論

- **置く・消すこと自体はできる。** `Cloudflare.Worker` は `name`・`script`（バンドルせずに 1 つの ESM として上げる）・`assets: { directory, runWorkerFirst: true }` を受け取り、静的ファイルの上限は Cloudflare と同じ 25 MiB。`destroy` は state にある resource をすべて消す。CLI を通さずに Node から `deploy`・`destroy` を呼ぶと、Cloudflare の API まで届いた。
- **ただし、ライブラリとして呼ぶ口は文書化されていない。** 公式に書かれているのは `alchemy deploy`／`destroy` の CLI と、テストのハーネス（`alchemy/Test/*`）だけ。CLI なしで呼ぶには、ハーネスの内部の関数か、内部の Layer の組み立てをまねることになる。
- **重い。** npm で入れると `node_modules` が **約 1.4 GB、約 155 パッケージ**。AWS・GCP・Stripe などの SDK と workerd を、Cloudflare しか使わなくても全部引き込む。ADR 0017 の基準なら管理ディレクトリ行きで、それでも Agent SDK（約 224MB）や Chromium（約 211MB）より桁が 1 つ大きい。
- **版が落ち着いていない。** v2 は 2026-04-13 の beta.1 から半年で beta.83。直近の版にも Breaking Changes がある。使うなら完全一致で固定し、上げるたびに確かめ直すことになる。
- **認証は環境変数で渡せる。権限は Workers Admin 1 つで足りる見込み（推測を含む）。** state は既定でローカルのファイル。Cloudflare 側の state store を使うと、Secrets Store などの追加の権限と、アカウントに常駐する Worker が要る。
- **このチケットの用途では、Direct Upload を `fetch` で直接叩くほうが向く。** Alchemy で得られるのは、アップロードの再試行や state による後片付けの記録だが、1 ファイルの HTML を 1 つの Worker に置くだけなら、得る物より重さと版の揺れのほうが大きい。

## 1. CLI（Node）からライブラリとして呼べるか

### 置く: Worker・静的ファイル・`run_worker_first`・期限の焼き込み

- `Cloudflare.Worker` の props に、名前の上書き `name`（省くとスタック名・stage・論理 ID から決まる名前になる）、生の ESM を渡す `script`（「bundling is bypassed entirely and this string is uploaded as a single ESM module」）、静的ファイルの `assets` がある（[`src/Cloudflare/Workers/Worker.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Cloudflare/Workers/Worker.ts) の `name`・`script`・`assets`・`workersDev`）。期限は `script` の文字列に焼き込めばよい。
- `assets` の設定に `runWorkerFirst?: boolean | string[]` がある。`true` で全リクエストが静的ファイルより先に Worker を通る（[`src/Cloudflare/Workers/Assets.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Cloudflare/Workers/Assets.ts) の `AssetsConfig`）。
- 静的ファイルのアップロードは Cloudflare の Direct Upload（upload session → バケットごとのアップロード → 完了の JWT をスクリプトの PUT で渡す）をそのまま実装している。ゲートウェイのエラーで再試行し、セッションの JWT が切れたら作り直す（同じファイルの `uploadAssets`）。
- 公式の例も、ビルドの無い静的サイトは `Cloudflare.Worker("Site", { assets: { directory: "./public" } })` で書いている（[Static sites](https://alchemy.run/cloudflare/frontend/static-site/)）。

### 25 MiB 近い HTML

- ソースの上限は `const MAX_ASSET_SIZE = 1024 * 1024 * 25; // 25MB`、ファイル数は 20,000 まで。超えると `Asset ... is too large` で止まる（`Assets.ts` の 17 行目と 330 行目付近）。Cloudflare の上限（25 MiB = 26,214,400 バイト、[#1207 の調査](https://github.com/daiki-beppu/live-mindmap/blob/research/export-publish-cloudflare/docs/investigations/2026-10-16-export-publish-cloudflare.md)）と同じなので、Alchemy を通しても置ける大きさは変わらない。
- 実際に 25 MiB 近いファイルを Cloudflare に上げることは試していない（実アカウントが要る）。

### 消す

- `destroy` は「`deploy` の望む状態を空にしたもの」で、state にある resource をすべて消す（[destroy](https://alchemy.run/cli/destroy/)）。ソースでも `Plan.destroy` は `resources: {}` で計画を作る（[`src/Plan.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Plan.ts) の `destroy`）。消すのに要るのは state で、置いたときの HTML は要らない（推測。計画が state だけから作られることからの読み）。
- Worker の削除は `workers.deleteScript({ accountId, scriptName, force: true })`（[`src/Cloudflare/Workers/WorkerProvider.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Cloudflare/Workers/WorkerProvider.ts)）。Direct Upload を直接叩く場合と同じ API。

### ライブラリとしての呼び方

- パッケージは `deploy`（[`src/Deploy.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Deploy.ts)）と `destroy`（[`src/Destroy.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Destroy.ts)）を Effect として export している（`src/index.ts`）。ただし、これを動かすには `AlchemyContext`・状態の store・`AuthProviders`・ファイルシステムや HTTP の Layer・プロファイルと資格情報の store などを自分で組んで渡す必要がある。
- その組み立ては、テストのハーネスの `toEffect` が CLI（`bin/alchemy.js`）をまねて行っている（[`src/Test/Core.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Test/Core.ts)、コメントに「Mirrors bin/alchemy.js composition」）。公式ドキュメントで CLI 以外から deploy・destroy を呼ぶ形として書かれているのは、このテストのハーネスだけ（[Testing a Stack](https://alchemy.run/testing/testing-a-stack/)）。
- **試したこと**: `alchemy/Test/Core` の `deploy`・`toEffect` を使い、`Cloudflare.Worker`（`name: "lmm-exp"`、期限を焼き込んだ `script`、約 25.7MB の `index.html`、`runWorkerFirst: true`）のスタックを Node（手元は v26.9.0）から `Effect.runPromise` で流した。偽のトークンとアカウント ID を環境変数で渡すと、`Cloudflare: using environment variables (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN) instead of the profile.` と出たあと、Worker の読み取りで Cloudflare から `Unauthorized`（status 400）が返って止まった。CLI なしで Cloudflare の API まで届くことは確かめられた。
- 試すときにつまずいた点: `npm i --omit=peer` だと `@effect/platform-node` が入らず、`alchemy/Cloudflare` の読み込みで落ちた（peer の 1 つ）。また、カレントディレクトリに `.alchemy/log/` が作られた。
- `package.json` に `engines` は無い。Node 24 で動くかは試していない（v26 で動いたことからの推測）。

## 2. state をどこに置くか。公開ごとに別の Worker を作って後で消す使い方に合うか

### 置き場所の選択肢

- **ローカルのファイル（既定）**: `.alchemy/state/<スタック名>/<stage>/<論理 ID>.json`（[State Store](https://alchemy.run/state-store/)）。場所は `AlchemyContext` の `dotAlchemy` で決まり、既定は `.alchemy`。カレントディレクトリからの相対で解決される（[`src/AlchemyContext.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/AlchemyContext.ts)、[`src/State/LocalState.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/State/LocalState.ts)）。`dotAlchemy` に絶対パスを渡せばセッションのフォルダにも置ける（推測。`path.resolve(initialCwd, dotAlchemy, "state")` なので、絶対パスならそのまま使われる）。
- **Cloudflare 側（`Cloudflare.state()`）**: アカウントに `alchemy-state-store` という Worker（Durable Object と SQLite）を置き、トークンと暗号鍵を Secrets Store に入れる。初回は確認を出して自動で作る。資格情報は `~/.alchemy/<profile>/cloudflare-state-store.json` に書く（[State Store](https://alchemy.run/state-store/)、[cli/cloudflare](https://alchemy.run/cli/cloudflare/)）。
- **自作の store**: State は Effect の Layer なので、好きな置き場所で書ける（[Custom State Store](https://alchemy.run/state-store/custom-state-store/)）。ほかに Postgres とメモリ上のもの（テスト用）がある。
- 認証のプロファイルなどの利用者単位の物は `~/.alchemy`（`ALCHEMY_HOME` で移せる）（[`src/Auth/Paths.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Auth/Paths.ts)）。

### 公開ごとに別の Worker を作り、後で消す使い方

- state はスタック名と stage で分かれる（[State Store](https://alchemy.run/state-store/)）。1 回の公開を 1 つの stage（たとえば乱数）にすれば、公開ごとに独立した state になり、その stage を `destroy` すれば Worker が消える。PR ごとのプレビュー環境を stage で作って `destroy --stage pr-42` で消す例が公式にあり、形としては同じ（[destroy](https://alchemy.run/cli/destroy/)）。
- 合わない点:
  - **state を失うと Alchemy からは消せない。** ローカルの state を消した・別の Mac に移ったときは、Worker 名（`lmm-<乱数>`）を手がかりに API で消すことになり、結局 Direct Upload と同じ削除の口が要る（推測）。
  - **Cloudflare 側の state store は、公開のたびの用途には重い。** アカウントに常駐の Worker と Secrets Store を足し、その分の権限も要る（推測。Secrets Store の作成と書き込みの権限は、Workers Admin とは別）。
  - 後片付けの一覧を作るのに、Alchemy の state を読むか、Cloudflare の Worker 一覧を `lmm-` で絞るかの 2 通りになる。後者なら state は要らない。

## 3. 認証。Workers Admin 1 つで済むか

### 渡し方

- `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN`（または Global API Key の `CLOUDFLARE_API_KEY` と `CLOUDFLARE_EMAIL`）の環境変数。必要な変数がそろっていればプロファイルより優先され、`CI=true` のときはいつもこちらを使う（[Auth Providers](https://alchemy.run/environments/auth-providers/)、[`src/Cloudflare/Auth/AuthProvider.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Cloudflare/Auth/AuthProvider.ts) の `readEnvironment`）。上の試しでも環境変数で渡せた。
- ほかに `~/.alchemy/profiles.json` のプロファイル（OAuth・API トークン・Global API Key）がある。CLI の `alchemy provider cloudflare token` は Global API Key でトークンを作る（[cli/cloudflare](https://alchemy.run/cli/cloudflare/)）。live-mindmap からは環境変数で渡すのが素直。
- Resource の props に API キーは渡さない設計（「Resources never take API keys as props」）。live-mindmap 側で読み込んだトークンは、環境変数か `ConfigProvider` 経由で渡すことになる（推測）。

### 権限

- Worker の provider が呼ぶ API は、ソースを見るかぎり `workers.*` だけ: スクリプトの PUT・削除・設定、デプロイの一覧と作成、workers.dev のサブドメインの取得とスクリプトごとの有効化、静的ファイルのアップロード（`WorkerProvider.ts`・`Assets.ts`）。カスタムドメインを指定しないかぎり、ドメインの一覧も呼ばない（`WorkerProvider.ts` のコメント「spares a plain workers.dev Worker the listDomains call」）。
- アカウントの workers.dev サブドメインの取得（`GET /accounts/{id}/workers/subdomain`）は `Workers Scripts Write` か `Workers Scripts Read` で通る（[Cloudflare API: Get Subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/)）。
- したがって `Cloudflare.Worker` を workers.dev に置いて消すだけなら、**Workers Admin（`Workers Scripts Write`）1 つで足りる見込み**（推測。実アカウントでは試していない）。#1207 で調べた Direct Upload の最小権限と同じ。
- `Cloudflare.state()` を使うと、Secrets Store などの権限が加わる（推測、上の 2）。

## 4. 依存の重さと ADR 0017、版の安定性

### 大きさ

- `alchemy@2.0.0-beta.83` 単体の展開後の大きさは **約 143MB**（npm の `dist.unpackedSize` = 143,106,391）。ソースの `.ts` と、ビルド後の `.js` を両方含む。
- 依存は 38 個。`@distilled.cloud/{aws,gcp,cloudflare,stripe,...}` の各クラウドの SDK、`rolldown`、`@prisma/dev`、`@libsql/client`、`@octokit/rest` などを、使うクラウドに関係なく直に引き込む（npm の `dependencies`）。peer は 19 個（`effect`・`@effect/platform-node`・`vite`・`pg` など）。
- 空のディレクトリで `npm i --ignore-scripts alchemy@2.0.0-beta.83 effect` を流すと、`node_modules` は **約 1.3 GB**、`--omit=peer` に `@effect/platform-node` を足しても **約 1.4 GB・約 155 パッケージ**だった。大きいもの: `@distilled.cloud` 全体 753MB（gcp 335MB・aws 207MB・cloudflare 108MB）、`alchemy` 自身 298MB、`@cloudflare/workerd-darwin-arm64` 129MB（`@alchemy.run/cloudflare-runtime` が workerd を固定版で持つ）、`effect` 53MB、`@electric-sql/pglite` 21MB（`@prisma/dev` 経由）。

### ADR 0017 との関係

- ADR 0017 は、重い依存を通常の依存から外し、`~/.live-mindmap/deps/<名前>/` に固定版で入れて、明示の `cli install` でだけ入れると決めている。Alchemy は大きさから見てこれに当たり、使うなら管理ディレクトリ行きになる。
- 大きさの桁が違う。管理ディレクトリに入れている Agent SDK は約 224MB、`playwright-core` と Chromium は約 211MB。Alchemy は約 1.4 GB で、HTML を 1 つ置くための依存としては不釣り合い。
- `effect` の扱い: Alchemy は `effect@^4.0.0` を peer に取るが、管理ディレクトリに別に入れると、そこにも別の `effect` が入る（試しでは 4.0.5 になった。server は 4.0.1 で完全一致）。server の Effect の実行の中で、別の版の `effect` で作られた Effect を直接 `yield*` すると、ランタイムが 2 つになって動かないおそれがある（推測）。そのため、管理ディレクトリの Alchemy は自分の `Effect.runPromise` で流すか子プロセスで動かし、Promise か終了コードで受け取る形になる。同じ版にそろえて通常の依存に入れる道は、重さから見て ADR 0017 に反する。
- テレメトリ: CLI とテストのハーネスは、既定で `otel.alchemy.run` にトレース・メトリクス・ログを送る。`DO_NOT_TRACK`・`ALCHEMY_TELEMETRY_DISABLED` などで止められる（[`src/Telemetry/Layer.ts`](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/packages/alchemy/src/Telemetry/Layer.ts)）。使うなら止める設定を live-mindmap 側で決める必要がある。

### 版の安定性

- v2 は 2026-04-13 の `2.0.0-beta.1` から 2026-10-12 の `beta.83` まで、半年で 83 版（npm の `time`）。週に数版のペース。
- CHANGELOG では beta.52 から beta.83 までの 16 の版に「Breaking Changes」の節があり、直近の beta.82・beta.83 にもある（beta.83 は Containers、beta.82 は engine の `InstanceId` の置き換えなど）（[CHANGELOG.md](https://github.com/alchemy-run/alchemy/blob/9e3c0584342d67b24a4215f931047aabd230327b/CHANGELOG.md)）。Worker と静的ファイルの部分が今後も変わらない保証は無い。
- 版の指定に `^` を使うと、beta の間は毎回別の版が入りうる。使うなら完全一致で固定し、ADR 0017 の同梱の lock で決めることになる。ライブラリとして呼ぶ口が文書化されていない（上の 1）ので、上げるたびに内部の組み立てが壊れていないかを確かめる手間も乗る。
- v1 系（`alchemy@0.94.0`、2026-08-01）も別に出ている。こちらは `wrangler` と `miniflare` を依存に持ち、ADR 0018 が選んだ Effect の v2 とは別物。

## 5. Direct Upload を直接叩く場合と比べて

| | Alchemy v2 | Direct Upload を `fetch` で |
|---|---|---|
| 依存 | 約 1.4 GB・約 155 パッケージ。管理ディレクトリ行き | 無し |
| 呼び方 | 文書化された口は CLI とテストのハーネス。ライブラリとしては内部の組み立てをまねる | 公開の REST API（文書化済み） |
| 版 | beta。直近の版にも破壊的変更。完全一致で固定 | Cloudflare の API の版 |
| 25 MiB 近い HTML | 置ける（上限は同じ） | 置ける（上限は同じ） |
| 再試行 | ゲートウェイのエラー・JWT の期限切れ・作成直後の不整合を再試行する実装が付いてくる | 自分で書く |
| 後片付けの記録 | state に残る。消すのは `destroy` 1 回 | 自分で記録する。または Worker 一覧を `lmm-` で絞る |
| 権限 | Workers Admin 1 つの見込み（state を Cloudflare に置くと増える） | Workers Admin 1 つ |
| ADR 0018 との一致 | 道具がそろう | そろわない |

**得**: アップロードの手順と再試行を書かなくて済む。workers.dev の有効化の再試行（作成直後に `WorkerNotFound` が返る問題）も入っている。state に何を置いたかが残るので、`destroy` 1 回で消せる。ADR 0018 の道具とそろう。

**損**: 依存が約 1.4 GB で、ADR 0017 の管理ディレクトリと `cli install` の流れに乗せることになる。`effect` の版が server とずれる。beta で破壊的変更が続き、ライブラリとして呼ぶ口が文書化されていないので、上げるたびに壊れうる。テレメトリを止める設定が要る。state を失えば結局 API で消す口が要る。

置く物は「1 ファイルの HTML と、期限を焼き込んだ数行の Worker」で、手順は Direct Upload の 3 段（upload session → アップロード → スクリプトの PUT）と削除 1 つ。Alchemy で得られる再試行と記録は、この大きさなら自分で書ける量に収まる（推測）。

ADR 0018 は「live-mindmap をホスティングするときの道具」を決めたもので、今は載せないとしている。エクスポートの公開は、利用者のアカウントに出来上がった HTML を置く操作で、live-mindmap 自体を載せるのとは別だと読める（推測。どちらと見るかは地図の側で決める）。

なお中間の道として、Alchemy が使う Effect 製の Cloudflare クライアント `@distilled.cloud/cloudflare`（`1.0.0-rc.15`、展開後 約 111MB）だけを使う形もあるが、それでも依存は大きく、release candidate の版になる（npm の `dist.unpackedSize`）。

## 調べ残し

- 実アカウントで、Alchemy を通して 25 MiB 近い HTML を置き、消すこと（偽のトークンで API に届くところまでしか試していない）。
- Workers Admin 1 つで `Cloudflare.Worker` の配置と削除がすべて通るか（ソースから呼ぶ API を読んだだけ）。
- Node 24 での動作（手元は Node 26 で試した）。
- `Cloudflare.state()` に要る権限の正確な一覧。
