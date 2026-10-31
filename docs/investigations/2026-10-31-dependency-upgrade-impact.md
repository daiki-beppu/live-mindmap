# いまの古い依存を最新に上げると何が壊れるか（2026-10-31）

調査チケット: [#1824](https://github.com/daiki-beppu/live-mindmap/issues/1824)（地図 [#1822](https://github.com/daiki-beppu/live-mindmap/issues/1822)）

## 結論

- **確実に壊れる（実際に流して確かめた）**: fallow（3.34 以降で重複 7 群が出て `pnpm fallow` が落ちる）、e2e（0.18 → 0.21.3 だけで、コミット済みの replay cache 4 件がすべて `REPLAY_STALE`）、effect 4.1（server の `tsc` がテストの 4 か所で落ちる）、foldkit の版を固定したテスト（`web/test/foldkitSetup.it.test.ts`）。
- **effect 4.1 と foldkit 0.170 は一緒に上げるしかない**。foldkit 0.170 の peer が `effect ~4.1.0` になった。逆に、これで `pnpm-workspace.yaml` の `peerDependencyRules` を消せる。
- **見えにくい落とし穴**: `pnpm update` で範囲を広げると、Claude SDK の peer `@anthropic-ai/sdk`（`>=0.93.0`）が 0.131 → 1.3（major）に上がり、server のテストの型が 1 か所落ちる。`pnpm -r outdated` には出ない（推移依存のため）。
- 上の点を直せば、effect 4.1・foldkit 0.170・@effect/tsgo 0.63・range 内の patch をまとめて上げても、server の unit 3085 件と light IT 1180 件、web の unit 1884 件が通り、`vite build` も通った（後述の「試した方法」）。
- 人の手が要るのは 2 つ: e2e の再録画（ChatGPT のサブスクでのログインが要る）と、Claude SDK の更新後の `cli eval`（差分更新の出力に効きうる）。FluidAudio を上げるなら `speakerAccuracy` と `measure-bootstrap.sh` も要る。

## 試した方法

依存はリポジトリでは上げていない。次の 3 つで確かめた。

1. 各パッケージの一次情報（GitHub Releases・リポジトリの CHANGELOG・npm の `peerDependencies`・tarball の `.d.ts`）を読んだ。
2. 新しい版のツールを `npx` で、いまのコードに流した（fallow 3.34.1・3.35.0・3.36.0・3.37.0・3.38.1、@effect/tsgo 0.63.0）。
3. worktree を scratch に写し（`.git` なし）、版を書き換えて `pnpm install` し、型検査とテストを流した。
   - 試行 A: effect 系 4.1.0・foldkit 0.170.0・@foldkit/ui 0.170.0・@foldkit/vite-plugin 0.29.0・@effect/tsgo 0.63.0・@foldkit/oxlint-plugin 0.15.4、`peerDependencyRules` を削除、`pnpm -r update`（range 内の patch と推移依存）。
   - 試行 B: e2e 0.21.3・@e2e-dev/web ^0.15.3 だけ。

起点の `pnpm -r outdated`（2026-10-31）は 22 件で、チケットの一覧と同じだった。なお npm にはさらに新しい版がある（effect 4.1.1、fallow 3.38.1、e2e 0.22.0、Claude SDK 0.3.316 など。いずれも 10-30〜31 公開）。`pnpm -r outdated` の Latest がそれより古いのは、pnpm 12 の公開からの待ち時間の既定によるものとみられる（推測。設定は確かめていない）。

## 依存ごとの表

| 依存 | いま → 最新 | 変える必要のある箇所 | 危険度 | 一緒に上げるべき仲間 |
|---|---|---|---|---|
| effect・@effect/platform-node・@effect/platform-browser・@effect/vitest | 4.0.6 → 4.1.0（4.1.1 も既出） | テストの `ChildProcessSpawner.make` の偽物 4 か所（`server/test/fixtures/chatgptOAuth.ts:145,147`、`server/test/readings.test.ts:33`、`server/test/helpers.it.test.ts:169`）: `args` が `CommandLine.Word`（`string \| Redacted`）、`env` の値に `Redacted` が入る型になった。`server/package.json`・`web/package.json`・`e2e/package.json` の exact pin。`server/src/core/evaluate.ts:31` の「effect 4.0.6 の interpreter」のコメントの見直し | 中 | foldkit 一式（peer が `~4.1.0`）。4 つの effect パッケージは同じ版にそろえる |
| foldkit・@foldkit/ui | 0.167.0 → 0.170.0 | `pnpm-workspace.yaml` の `peerDependencyRules` を削除。`web/test/foldkitSetup.it.test.ts`（版の期待値と `peerDependencyRules` を求めるテスト）。`web/AGENTS.md` の「版」節（peer の許可の記述）と skill の写し直し（`skills-lock.json`・`web/test/foldkitAgents.it.test.ts` の `TAG`）。`Stream.callback` を使う Mount・Subscription（`web/src/app/liveFeed/subscription.ts`・`mapSurface/mount.ts`・`review/mount.ts`）の確認 | 中 | effect 4.1（同時でないと peer が合わない）、@foldkit/vite-plugin 0.29、@foldkit/oxlint-plugin 0.15.4 |
| @foldkit/vite-plugin | 0.27.0 → 0.29.0 | `web/package.json`・`foldkitSetup.it.test.ts` の期待値 | 低 | 依存に `@effect/platform-node ~4.1.0` を持つので effect 4.1 と同時 |
| @foldkit/oxlint-plugin | 0.15.3 → 0.15.4 | `web/package.json`・`foldkitSetup.it.test.ts` の期待値。oxlint 1.90 と組み合わせて `src/app` の lint は 0 件 | 低 | foldkit 一式 |
| @effect/tsgo | 0.56.0 → 0.63.0 | なし。いまのコード（effect 4.0.6 と 4.1.0 の両方）で `effect-tsgo diagnostics` は server・web とも 0 errors。新しいルール（`failCauseToConstructor`・`manualMetricTapToTrack`・`mapConstToAs`・`flatMapIdentityToFlatten` は suggestion、`mapMapErrorToMapBoth` は off）は exit code に効かない | 低 | effect と同じ PR が自然（どちらの版とも組める） |
| fallow | 3.33.1 → 3.37.0（3.38.1 も既出） | 3.34 以降で重複 7 群（97 行）が出て落ちる。`web/src/app/meeting/main.ts` と `review/main.ts`（2 群）、`server/bench/edgeJudge.ts` と `siblingJudge.ts`（3 群）、`server/src/sessions.ts:150-153` と `254-258`、`server/test/fixtures/managedChromiumLaunch.ts` と `managedPlaywright.ts`。AGENTS.md の手順どおり、まとめて抑制せず書き直す。`.fallowrc.json` の `$schema` の URL（`v3.33.1`）。設定のグロブは既に `**` なので、3.34 の「単一の `*` は 1 階層だけ」の変更は効かない | 中 | 単独で上げる（AGENTS.md の fallow 節の手順） |
| @anthropic-ai/claude-agent-sdk | 0.3.288 → 0.3.314（0.3.316 も既出） | `server/managed-deps/claude/README.md` の手順どおり: `managed-deps/claude/package.json`・`package-lock.json`、`server/package.json` の devDependencies、`server/test/checkManagedLock.it.test.ts:14,44`、`server/test/managedClaudeLoad.it.test.ts:9`。`server/src/claude.ts` の呼び方（`tools: []`・`settingSources: []`・`outputFormat: json_schema`・`effort`）に効く変更あり（下の注） | 中 | `@anthropic-ai/sdk` の版（下の行）。評価は `cli eval` |
| @anthropic-ai/sdk（Claude SDK の peer、推移） | 0.131.0（pnpm）・0.133.0（managed の npm lock）→ 1.3.0 | `pnpm update` で 1.x に上がると `server/test/routedDiffUpdater.test.ts:303` が型で落ちる（`ContentBlockParam` の union に `source` の無い型が入った）。`b.type === "image"` の絞り込みを型が効く形に直す | 中 | Claude SDK。managed 側の npm lock を作り直すときも `>=0.93.0` で 1.x に上がりうる |
| playwright-core | 1.63.0 → 1.64.1 | `server/managed-deps/chromium/README.md` の手順どおり: managed manifest・npm lock・`server/package.json`。headless shell の revision が 1243 → 1248（Chromium 153 → 156）。1.64.1 の `browsers.json` の `chromium-headless-shell` に `revisionOverrides` は無く、`server/src/managedDeps.ts:277` の前提は保たれる（コメントの版は直す）。1.64.0 の Breaking（device の `screen`、隠れた iframe、JSX、`--update-snapshots`）はテストランナー寄りで、`server/src/capture.ts`・`playwright.ts` の使い方には当たらない | 低〜中 | なし（Chromium の版が変わるので、地図の書き出し画像の見た目は確かめる） |
| e2e | 0.18.0 → 0.21.3（0.22.0 も既出） | **replay cache の全件の録り直し**（`e2e/.e2e/cache/`）。0.19.0 で cache の鍵からエンジンの版が外れ、鍵が変わる。試行 B で 4 件すべて `REPLAY_STALE`（いまの版では 4 件とも再生できる）。0.19.0 の Breaking（`expect.soft` の後の `test.skip`）は使っていない。型検査は通る | 高 | @e2e-dev/web（同時）、ai・@ai-sdk/openai（peer） |
| @e2e-dev/web | 0.13.0 → 0.15.3 | `e2e/package.json`。同梱の `playwright-core` が 1.63.0 → 1.64.1（Chromium 156）に上がる | 中 | e2e（同時に録り直す） |
| ai・@ai-sdk/openai | 7.0.130 → 7.0.157、4.0.86 → 4.0.105 | なし（range 内。e2e の peer） | 低 | e2e |
| FluidAudio（`helper/Package.swift` の revision） | `ea63ac3`（2026-10-07）→ `v0.18.0`（ea63ac3 から 53 commit 先）、main は 63 commit 先 | `Package.swift` の revision とコメント（「v0.9.1 のタグには入っていない」は古い。`ea63ac3` は v0.17.7 の 6 commit 前で、Sortformer は今はタグに入っている）、`Package.resolved`。v0.18.0 は TTS と Diarizer を opt-out の trait にした（`Package@swift-6.2.swift`。既定は有効なので触らなくてよい）。`Package.swift` の tools 版は 6.0 のまま。Sortformer に触れる commit は見当たらない | 中 | 話者分離のモデル（地図では対象外）。`speakerAccuracy` と `scripts/measure-bootstrap.sh`（AGENTS.md の Evals） |
| webrtc-audio-processing（`build-webrtc-apm.sh` の `COMMIT`） | `d0569cf`（2025-11-10） | なし。上流の既定ブランチの先頭がこの commit で、最新のタグは v2.1（2025-01）。上げるものが無い | 低 | — |
| GitHub Actions | `actions/checkout@v7`・`setup-node@v7`・`cache@v6`・`pnpm/setup@v3`・`astral-sh/setup-uv@v10.2.0`・actionlint 1.7.12 | major の tag を使う 4 つはすでに最新の major。`setup-uv` だけ exact で v10.3.3 が出ている（版の取得先を Astral の mirror にした等。Breaking なし）。actionlint は 1.7.12 が最新 | 低 | — |
| vite・vitest・vite-plugin-singlefile・jose・@types/node・oxlint | 各 patch・minor | なし（試行 A で range 内を上げて型検査・unit・light IT・`vite build`・oxlint が通った）。ただし同じ `pnpm update` で上の `@anthropic-ai/sdk` も動く | 低 | — |

### Claude SDK の注（0.3.289〜0.3.314 の CHANGELOG から、`server/src/claude.ts` に関わるもの）

- 0.3.314: `settingSources` から外した設定ファイルが、一部の設定（auto mode のルールなど）をまだ渡していた不具合を直した。`settingSources: []` の隔離が強まる方向。
- 0.3.302: API が拒んだ応答で `structured_output` を返していたのを、payload の無いエラーにした。拒否時の扱いが変わる。
- 0.3.300: `thinking: disabled` を、思考を切れないモデルでは adaptive にした（live-mindmap は `effort` を使い、`thinking` は渡していない）。
- 0.3.295: オプションの値を `--flag=value` の形で CLI に渡すようにした。
- 0.3.311: Node の最小版を 18.14 にした（live-mindmap は 24 以上）。
- 各版で同梱の Claude Code が v2.1.288 → v2.1.314 に上がる。差分更新の出力が変わりうるので `cli eval` で比べる。

### effect 4.1 の注（unstable の 4 モジュール）

- `effect/process`: `ChildProcess.make` の配列の引数はそのまま動く。テンプレート文字列の書き方は、`|`・`$HOME`・`*` などのシェルの構文で `CommandLineError` を投げるようになったが、live-mindmap はテンプレートを使っていない（`server/src` の `ChildProcess.make(cmd, [...args], opts)` の 8 か所はすべて配列の形）。変わるのは型だけで、上の 4 か所がそれに当たる。4.0.7 で `ChildProcessSpawner` の `exitCode`・`string`・`lines` が読まない出力を読み捨てるようになった（使っていない）。
- `effect/http`: `HttpServerRequest.method` が `string` になり、`upgradeWith` が増えた（自前の `HttpServerRequest` 実装は無い）。`HttpClient.withCookiesRef` の型が変わった（使っていない）。`HttpClientError` の `toJSON` が headers や query を出さなくなった。
- `effect/socket`: `@effect/platform-node` 4.1.0 で WebSocket の**クライアント**が Node の global `WebSocket` に替わり、`NodeSocket.NodeWS`・`layerWebSocketConstructorWS` が消えた。live-mindmap は `ws` を直接 import し（`server/src/helperSocket.ts`・`httpServing.ts`）、`NodeSocket` を使っていないので当たらない。
- `effect/cli`: 単一値のフラグを 2 回渡すと失敗するようになった（4.0.7）。ヘルプに `INHERITED FLAGS` 節ができた（4.1.0）。CLI の IT はすべて通った。
- その他: `effect/Crypto` は `effect/crypto/*` に分かれ、`*Services` から外れた（live-mindmap は `node:crypto` の `randomUUID` を使い、`effect/Crypto` は使っていない）。`FileSystem` に `readDirectoryEntries` が増えたが、テストの `FileSystem.makeNoop` と `FileSystem.of({ ...fs })` はそのまま通る。`@effect/platform-node` の最小 Node は 22.19。
- Foldkit 0.170.0 の CHANGELOG は「Effect 4.1 では `Stream.callback` のセットアップがすぐ始まる」と書いている。effect の release notes には見当たらず、`Stream.callback` の実装も 4.0.6 と 4.1.0 で同じだった。web の該当箇所は unit と IT が通ったが、画面での確認（`verify-live-mindmap`）を勧める。
- `effect` に同梱の `AGENTS.md` は 4.0.6 と 4.1.0 で同じだった。

## 上げる順の目安（判断材料）

1. **単独で安全**: GitHub Actions（setup-uv）、range 内の patch（ただし `@anthropic-ai/sdk` を 0.x に留めるか、テストを 1 か所直す）。
2. **fallow**: 重複 7 群を書き直す PR として単独で。
3. **effect 4.1 + foldkit 0.170 + @foldkit/* + @effect/tsgo 0.63**: 1 つの PR。直すのはテスト 4 か所、`peerDependencyRules`、`foldkitSetup.it.test.ts`、skill の写し直し。
4. **Claude SDK**: managed-deps の手順と `cli eval`。`@anthropic-ai/sdk` 1.x の扱いをここで決める。
5. **playwright-core**: managed-deps の手順。
6. **e2e + @e2e-dev/web**: 人の録り直しが要る。`e2e/README.md` の手順で。
7. **FluidAudio**: `speakerAccuracy` と `measure-bootstrap.sh` が要る。地図の範囲（話者分離のモデルは対象外）と合わせて決める。

## 出典

- effect: GitHub Releases `effect@4.0.7`・`effect@4.1.0`・`effect@4.1.1`・`@effect/platform-node@4.0.7`・`@effect/platform-node@4.1.0`・`@effect/platform-node@4.1.1`・`@effect/platform-browser@4.1.0`・`@effect/vitest@4.1.0`（https://github.com/Effect-TS/effect/releases ）、npm の tarball `effect@4.0.6`・`effect@4.1.0` の `dist/process/ChildProcess.d.ts`・`dist/process/CommandLine.d.ts`・`dist/FileSystem.d.ts`・`dist/http/HttpServerRequest.d.ts`・`dist/http/HttpClient.d.ts`・`dist/cli/CliError.d.ts`・`dist/Stream.js`・`AGENTS.md`
- Foldkit: https://github.com/foldkit/foldkit/blob/main/packages/foldkit/CHANGELOG.md （0.168.0〜0.170.0）、npm の `peerDependencies`（`foldkit@0.167.0`〜`0.170.0`、`@foldkit/ui@0.170.0`、`@foldkit/vite-plugin@0.29.0`）
- @effect/tsgo: https://github.com/Effect-TS/tsgo/blob/main/_packages/tsgo/CHANGELOG.md （0.56.1〜0.63.0）、同梱の README（exit code の扱い）
- fallow: https://github.com/fallow-rs/fallow/blob/main/CHANGELOG.md （3.34.0〜3.38.1）
- Claude Agent SDK: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md （0.3.289〜0.3.316）、npm の `dependencies`（`@anthropic-ai/sdk: >=0.93.0`）、https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md （1.0.0）
- Playwright: GitHub Releases `v1.64.0`・`v1.64.1`（https://github.com/microsoft/playwright/releases ）、npm の tarball `playwright-core@1.64.1` の `browsers.json`
- e2e: https://github.com/tester-army/e2e/blob/main/packages/e2e/CHANGELOG.md （0.19.0〜0.22.0）、npm の `@e2e-dev/web@0.13.0`・`0.15.3` の `dependencies`
- FluidAudio: GitHub Releases `v0.18.0`、compare API（`ea63ac3...v0.17.7`・`...v0.18.0`・`...main`）、`Package.swift`（`ea63ac3` と `v0.18.0`）
- webrtc-audio-processing: GitLab API の commits と tags（https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing ）
- GitHub Actions: 各リポジトリの latest release（checkout v7.0.1、setup-node v7.1.0、cache v6.1.0、pnpm/setup v3.1.2、setup-uv v10.3.3、actionlint v1.7.12）
- 手元の実行: fallow 3.33.1（通る）と 3.34.1・3.35.0・3.36.0・3.37.0・3.38.1（重複 7 群で落ちる）、`effect-tsgo diagnostics` 0.56.0・0.63.0、試行 A（server の `tsc` で 4 件・`@anthropic-ai/sdk` 1.x で 2 件の型エラー、server unit 3085 件・light IT 1180 件・web unit 1884 件が通過、web IT は `foldkitSetup.it.test.ts` の 5 件だけ失敗、`vite build` と oxlint 1.90 が通過）、試行 B（e2e の `--strict-cache` で 4 件とも `REPLAY_STALE`。同じ手順でいまの版は 4 件とも再生）
