# e2e

会議中の流れ（`start` → 発言 → 字幕とノード → `stop` → 書き出し）を、実物の server・CLI・web で通す smoke。
[e2e](https://e2e.tester.army/docs)（`e2e` パッケージ）で動かす。vitest の `projects` には入れない。本体（server・CLI・web）にテスト用の口は足さない。

## 構成

| ファイル | 役割 |
| --- | --- |
| `e2e.config.ts` | target は web 1 つ。`app.command` が `scripts/serve.ts` を起動する（web のポートは runner が空きポートを選んで `{port}` に入れる） |
| `scripts/serve.ts` | 起動スクリプト。server の `startup` / `realLayers` を使い、helper を `server/test/fixtures/fake-helper.ts`、差分更新を偽の `updaterLayer`（新しい発言 1 件ごとにノードを 1 つ作り、文言は発言そのまま）に差し替える。終了時の書き出し（`ExportServices`）は `server.ts` の `import.meta.main` と同じ組み方で自前に組み、`AudioMix` には fake-helper を渡す。同じプロセスで web の Vite 開発サーバーも立てる |
| `fixtures/meeting.json` | 手書きの台本。架空の発言 10 件（`相手`・`自分`・`partial` を含む）。smoke は先頭 3 件だけ流す（3 件目は `自分` の partial。確定せず、字幕に残り続ける）（`e2e.config.ts` の `--events 3`） |
| `.run/server.json` | run-info。起動スクリプトが書く server のポート・セッションのフォルダ（一時）・書き出し配信のポート・流す件数。テストが CLI を呼ぶために読む（gitignore 済み） |
| `tests/smoke/meeting.e2e.ts` | smoke。CLI は子プロセスで呼ぶ（`LIVE_MINDMAP_PORT`・`LIVE_MINDMAP_SESSIONS` を渡す） |
| `.e2e/cache/` | replay cache。コミットする（`.gitignore` で、ほかの `.e2e/` の出力だけ無視する） |

server のポートとセッションのフォルダは一時的なもの（空きポートと一時フォルダ）。開発中の server（4319）や `~/.live-mindmap` には触れない。

## 回し方

```sh
pnpm install
pnpm --filter @live-mindmap/e2e test:e2e:smoke   # コミットした cache を --strict-cache で再生する。記録が一致するステップはモデルを呼ばない
pnpm --filter @live-mindmap/e2e test:e2e         # 今は smoke だけ
```

`pnpm --filter e2e …` でも同じ package に当たる。ルートの `pnpm test`・`pnpm typecheck` には入らない。

## 書き方

- 判定は、すべて locator の `expect`（`toBeVisible`・`toHaveAttribute`・`toContainText` など）で行う。待ちも locator の `expect`（`{ timeout }`）で行う。`agent.assert`・`agent.waitFor`・`agent.extract` と、sleep・`expect.poll` による待ちは使わない。
- 操作には `agent.act` を使ってよい。replay cache は、後続の locator の `expect` が通った `act` からしか作られない。
- エクスポートのファイルも locator で見る。起動スクリプトが、セッションのフォルダの下を text/plain で返す読み取り専用の HTTP サーバーを立てる（run-info の `filesPort`）。テストはそのページを開き、`pre` を `toContainText` で確かめる。値の `expect` は使わない。
- 見るのは構造だけ（字幕とノードが出る、選べる、ファイルができる）。要約や分類の良し悪しは見ない。
- 書き出しの判定は `map.md`・`map.json`・`map.drawnix` に絞る。`map.png`・`map.html` は環境（Chromium・ビルド）しだいで、本体が警告を出して処理を続ける。

## 記録の取り直し方

記録が一致するステップは、モデルを呼ばずに再生する。記録はあるが再生できないステップ（画面の構造の変化など）は、`--strict-cache` で `REPLAY_STALE` になり止まる。モデルは呼ばない。test 名・target 名・`agent.act` の指示文・params を変えたステップは、記録と照合できず、`--strict-cache` でもモデルを呼んで実行される（`REPLAY_STALE` にはならない）。このため、名前・指示文・params を変えたら `REPLAY_STALE` を待たずに記録し直す。記録は ChatGPT のサブスクで取る。API キーは置かない（`.env` に `ANTHROPIC_API_KEY` なども置かない）。

```sh
pnpm --filter @live-mindmap/e2e exec e2e login openai   # 初回だけ。ブラウザで ChatGPT にサインインする
pnpm --filter @live-mindmap/e2e exec e2e run tests/smoke   # --strict-cache なし。照合できないステップだけモデルを呼んで記録し直す
pnpm --filter @live-mindmap/e2e test:e2e:smoke             # 再生だけで通ることを確かめる（Cache の再生数が出て、モデル呼び出しがない）
git add e2e/.e2e/cache                                   # 記録し直した cache を、同じコミットに含める
```

認証で失敗したら、API キーで回避せずに止めて報告する。
