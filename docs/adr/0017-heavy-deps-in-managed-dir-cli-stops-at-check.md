# 重い依存は使うときだけ管理ディレクトリに固定版で入れ、CLI は入れずに開始前の確かめで止める

セッションで要るもの（差分更新のモデルの SDK・日本語の音声認識モデル・map.png に要る Chromium）は、`start` の前に開始前の確かめでそろっているかを見て、会議中には入れない。その形として、Claude Agent SDK（CLI のバイナリ込みで約 224MB）と Playwright（`playwright-core` と Chromium で約 211MB）を通常の依存から外し、`~/.live-mindmap/deps/<名前>/` に live-mindmap が固定した版で入れる（[#619](https://github.com/daiki-beppu/live-mindmap/issues/619)）。clone して入れるだけで容量が減るのは、この流れの結果として付いてくる。

- **固定版は同梱の lock で決める**。`server/managed/<名前>/` に `package.json`（完全一致）と npm の `package-lock.json` を置き、サーバーが管理ディレクトリで `npm ci --omit=dev --omit=peer --ignore-scripts` を走らせる。読み込みは `createRequire` と `import(pathToFileURL())` で行う。型のために devDependencies に残す版が lock と一致するかは `pnpm typecheck` で確かめる（[#620](https://github.com/daiki-beppu/live-mindmap/issues/620)・[#621](https://github.com/daiki-beppu/live-mindmap/issues/621)・[#624](https://github.com/daiki-beppu/live-mindmap/issues/624)）
- **CLI は自分では入れず、確認も出さない**。CLI を呼ぶのは AI エージェントなので（ADR 0010）、y/N は出さず、TTY があっても経路は 1 つにする。`start`・`resume`・`play` は、欠けると始められないものが未導入なら開始せず **exit 3** で終わる。stderr に足りないもの・容量の目安・打つべきコマンドを出し、「利用者に確認してから入れてください」と添える（[#623](https://github.com/daiki-beppu/live-mindmap/issues/623)）
- **入れるのは明示の `cli install <名前>` だけ**。導入はいつもサーバーが行うので、エージェントのサンドボックスがネットワークを塞いでいても入れられる。開始せずに確かめるだけの `cli check` を足す
- 欠けても一部の出力が減るだけのもの（Chromium と map.png）と版違いは、警告したうえで開始する

## Considered Options

- **optionalDependencies や pnpm の設定で入れるかを選ばせる**: 入れるかどうかが clone と `pnpm install` の時点で決まり、セッションで要るかとは結び付かない。版違いを開始前に見つける口も無い
- **利用者の手元にある Claude Code や Chromium を探して流用する**: 容量はさらに減るが、版と置き場所が環境ごとに違い、差分更新の振る舞いが手元の版に左右される。takt と同じく流用しない
- **`start --install` や、端末での y/N の確認**: 呼ぶのはエージェントで、y/N に答えるのもエージェントになる。数百 MB を入れることを利用者が知らないまま進む。開始と導入を 1 つの口に混ぜると、exit code で欠けを知らせる経路が二重になる
- **要るときに会議中に入れる**: 会議を待たせ、ネットワークが無ければ途中で止まる。開始前にそろえる流れそのものに反する

## Consequences

- exit 3 は、エージェントとの約束になる。README とエージェント向けの案内は、exit 3 を受けたら利用者に確かめてから `cli install` を打つ流れを前提に書く
- ローカルモードでは Agent SDK を読み込まない（ADR 0014）。この約束は、入れていなければ読み込みようがないことで、物の側でも守られる
- `play` だけを使う人も、導入のときだけはサーバー（`pnpm dev`）を起動する
- テストと CI は、本物の SDK を呼ばない。Chromium は読み込み口を Effect のサービスにし、heavy IT と CI は `LIVE_MINDMAP_DEPS` の下に開発用スクリプトで入れる（[#672](https://github.com/daiki-beppu/live-mindmap/issues/672)）
- 固定版を上げるのは、同梱の lock を作り直す開発者の作業になる。利用者の手元では、live-mindmap を更新すると開始前の確かめで `outdated` になり、`cli update` でそろえる
