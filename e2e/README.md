# e2e

会議中の流れ（`start` → 発言 → 字幕とノード → `stop` → 書き出し）を、実物の server・CLI・web で通す。台本の先頭 3 件だけの smoke と、全件の流れの 2 本立て。もう 1 本、見返しの流れ（手書きの `log.jsonl` → CLI の `review` → `map.html` → シークバーで時刻を動かす）を通す。
[e2e](https://e2e.tester.army/docs)（`e2e` パッケージ）で動かす。vitest の `projects` には入れない。本体（server・CLI・web）にテスト用の口は足さない。

## 構成

| ファイル | 役割 |
| --- | --- |
| `e2e.config.ts` | target は 2 つ。`web`（smoke。台本の先頭 3 件）と `web-full`（台本の全件。件数は `fixtures/meeting.json` の `events.length`）。どちらも `app.command` が `scripts/serve.ts` を起動する（web のポートは runner が空きポートを選んで `{port}` に入れる） |
| `scripts/serve.ts` | 起動スクリプト。ファイル配信は拡張子 `.html` だけ `text/html`、ほかは `text/plain` で返す（別ポートと、web と同じ origin の `/session-files/`。見返しのテストは後者を開く。replay cache は origin 込みで画面を照合し、別ポートは毎回変わるため）。server の `startup` / `realLayers` を使い、helper を `server/test/fixtures/fake-helper.ts`、差分更新を偽の `updaterLayer`（新しい発言 1 件ごとにノードを 1 つ作り、文言は発言そのまま）に差し替える。終了時の書き出し（`ExportServices`）は `server.ts` の `import.meta.main` と同じ組み方で自前に組み、`AudioMix` には fake-helper を渡す。同じプロセスで web の Vite 開発サーバーも立てる |
| `fixtures/meeting.json` | 手書きの台本。架空の発言 10 件（`相手`・`自分`・`partial` を含む）。smoke（target `web`）は先頭 3 件だけ流し（3 件目は `自分` の partial。確定せず、字幕に残り続ける）、`web-full` は 10 件すべてを流す（`e2e.config.ts` の `--events`） |
| `.run/<web のポート>.json` | run-info。起動スクリプトが target ごと（web のポートごと）に書く server のポート・セッションのフォルダ（一時）・書き出し配信のポート・流す件数。テストが開いた画面のポートから自分の target のものを読み、CLI を呼ぶ（gitignore 済み） |
| `tests/smoke/meeting.e2e.ts` | 会議中の流れ（両方の target で同じ本文が動く）。CLI は子プロセスで呼ぶ（`LIVE_MINDMAP_PORT`・`LIVE_MINDMAP_SESSIONS` を渡す） |
| `fixtures/review.log.jsonl` | 見返し用の手書きログ（録音なし）。発言 6 件と、ノードを足す `diff` 3 回を、時刻をずらして並べる。server のテストの `session.log.jsonl` は流用しない |
| `tests/review/review.e2e.ts` | 見返しの流れ（両方の target）。`<sessionsDir>/review/` に fixture を `log.jsonl` として置き、CLI の `review` で `map.html` だけを作り（録音が無いので `mix`・`map-audio.html` は扱わない）、開いてシークバー（「時刻」）を先頭へ動かす前後のノードの数を判定する。会議中の流れの出力には頼らない |
| `.e2e/cache/` | replay cache。コミットする（`.gitignore` で、ほかの `.e2e/` の出力だけ無視する） |

server のポートとセッションのフォルダは一時的なもの（空きポートと一時フォルダ）。開発中の server（4319）や `~/.live-mindmap` には触れない。

## 回し方

```sh
pnpm install
pnpm --filter @live-mindmap/e2e test:e2e:smoke   # target web（先頭 3 件）だけ。コミットした cache を --strict-cache で再生する。記録が一致するステップはモデルを呼ばない
pnpm --filter @live-mindmap/e2e test:e2e         # 全 target（web と web-full の全件。見返しのテストを含む）を --strict-cache で再生する
```

`pnpm --filter e2e …` でも同じ package に当たる。ルートの `pnpm test`・`pnpm typecheck` には入らない。

## 書き方

- 判定は、すべて locator の `expect`（`toBeVisible`・`toHaveAttribute`・`toContainText` など）で行う。待ちも locator の `expect`（`{ timeout }`）で行う。`agent.assert`・`agent.waitFor`・`agent.extract` と、sleep・`expect.poll` による待ちは使わない。
- 操作には `agent.act` を使ってよい。replay cache は、後続の locator の `expect` が通った `act` からしか作られない。
- 会議中の流れでは、エクスポートのファイルも locator で見る。起動スクリプトが、セッションのフォルダの下を（`.html` 以外は）text/plain で返す読み取り専用の HTTP サーバーを立てる（run-info の `filesPort`）。テストはそのページを開き、`pre` を `toContainText` で確かめる。値の `expect` は使わない。
- 見るのは構造だけ（字幕とノードが出る、選べる、ファイルができる）。要約や分類の良し悪しは見ない。
- 会議中の流れの書き出しの判定は `map.md`・`map.json`・`map.drawnix` に絞る。`map.png`・`map.html` は環境（Chromium・ビルド）しだいで、本体が警告を出して処理を続ける。
- 見返しの流れは、CLI の `review` で作った `map.html` を HTML として開き、locator で判定する（シークバーの前後で `.map-node__text` の数が変わる）。

## 記録の取り直し方

記録が一致するステップは、モデルを呼ばずに再生する。記録はあるが再生できないステップ（画面の構造の変化など）は、`--strict-cache` で `REPLAY_STALE` になり止まる。モデルは呼ばない。test 名・target 名・`agent.act` の指示文・params を変えたステップは、記録と照合できず、`--strict-cache` でもモデルを呼んで実行される（`REPLAY_STALE` にはならない）。このため、名前・指示文・params を変えたら `REPLAY_STALE` を待たずに記録し直す。記録は ChatGPT のサブスクで取る。API キーは置かない（`.env` に `ANTHROPIC_API_KEY` なども置かない）。

```sh
pnpm --filter @live-mindmap/e2e exec e2e login openai   # 初回だけ。ブラウザで ChatGPT にサインインする
pnpm --filter @live-mindmap/e2e exec e2e run   # 全 target。--strict-cache なし。照合できないステップだけモデルを呼んで記録し直す
pnpm --filter @live-mindmap/e2e test:e2e:smoke             # 再生だけで通ることを確かめる（Cache の再生数が出て、モデル呼び出しがない）
git add e2e/.e2e/cache                                   # 記録し直した cache を、同じコミットに含める
```

認証で失敗したら、API キーで回避せずに止めて報告する。
