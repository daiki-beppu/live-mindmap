# takt の run

takt でチケットを実装させるとき、その run の報告を読むとき、run が層を「未実証」で返したときに読む文書。takt の作業場所で検査の層を通すための前提と、run の報告に出る失敗の読み方を書く。takt の並べ方と PR の更新は [ADR 0022](../adr/0022-align-behind-prs-from-local-resident-script.md) にある。

- 用語: 無し
- ADR: [0022 予約済みで BEHIND の PR は、手元の常駐スクリプトが 1 件ずつ揃える](../adr/0022-align-behind-prs-from-local-resident-script.md)

## takt の作業場所には依存が入っていない。ルートの層の前に `pnpm install --frozen-lockfile` が要る

takt が作る worktree（`takt-worktrees/` の下）は Orca の worktree ではないので、`orca.yaml` の setup（`vp install`）が走らない。[#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287) の run の 1 回目の実装は、server と e2e の `node_modules` が無いまま層を回し、ルートの `pnpm test` は server の `vitest` が無くて落ち、`pnpm typecheck` は exit 127 で落ち、`pnpm test:it` と smoke は回せなかった。実装の担当は「依存を入れるのは要求の範囲外」と判断して層を未実証のまま返し、2 回目の計画が `pnpm install --frozen-lockfile`（`e2e/README.md` の回し方の最初の手順）を採ってから、すべての層が通った。lockfile は変わらない。

チケットの完了条件にルートの層を書くときは、依存を入れることも作業に含まれると読ませる。

## ルートの `pnpm typecheck` の SIGKILL は環境の側。同じコマンドを 1 回流し直してから原因を探す

#1287 の run では、ルートの `pnpm typecheck` で server と helper が SIGKILL で終わり、それぞれを単体で流すと通った。テストの型エラー（TS4104）を直して同じ 1 コマンドを流し直すと、終了コード 0 で SIGKILL は出なかった。原因は確かめていない。並列 3 の takt で Swift のビルドが同時に走り、同じ SIGKILL で実装をやり直した前例がある（[2026-10-08 の開発ログ](../devlog/2026-10-08.md)）。完了条件はルートの 1 コマンドの終了コードなので、単体で通ったことを代わりにせず、流し直した結果で判断する。

## テストは行番号でなくテスト名で指す。行番号は先に入った子の PR でずれる

#1147 の振り分けの表は 2026-10-15 時点の行番号でテストを指していた。同じ親の子が先に何本もマージされると、同じファイルの行番号はずれる。後から流した子の run は、行番号の指す先が別のテストになっていても気づけない。issue に写すときは、ファイル名とテスト名（`describe` と `it` の文字列）で指す。

## 出典

- チケット [#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287)、[PR #1292](https://github.com/daiki-beppu/live-mindmap/pull/1292)
- #1287 の takt の run（`20261017-060712-implement-using-only-the-files-sugyi4`）の計画・2 回の実装の報告と決定ログ
