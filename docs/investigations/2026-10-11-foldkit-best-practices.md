# Foldkit のベストプラクティスとアンチパターン（Issue #802）

Foldkit（npm `foldkit` 0.167.0、peer `effect` 4.0.0）が自分で勧めている書き方と、避けるよう言っている書き方を、一次資料から集めた。#746（web のコーディング規約を決める）の材料にする。後半では、試作（`origin/prototype/foldkit-review`、#736）が公式の勧めに沿っているかを file:line で照らした。

## 資料と版

- **リポジトリ**: [foldkit/foldkit](https://github.com/foldkit/foldkit) のタグ `foldkit@0.167.0`（コミット `74071173b1253e9efeec050a31ca86df1931ce5a`、2026-10-07）を読んだ。以下の `B/` はこのコミットの blob URL `https://github.com/foldkit/foldkit/blob/74071173b1253e9efeec050a31ca86df1931ce5a/` を表す。
  - 公式サイトのページは `packages/website/src/page/**.md` が原稿。サイトの URL も併記したが、サイトは `main` から配信される（`B/packages/website/src/page/about.md` L17）ので、0.167.0 より新しい内容になっていることがある。
  - Foldkit 自身の開発規約 `B/AGENTS.md` は、出典として何度も使った。ここには Foldkit を使うアプリ全般への規約（命名・状態の持ち方・view・ファイル構成）も書かれていて、`skills/` は「Foldkit を使うアプリ向け」と明記されている（`B/AGENTS.md` L9-13）。
- **llms.txt**: [foldkit.dev/llms.txt](https://foldkit.dev/llms.txt) がある（2026-10-11 取得）。全ページの索引で、各ページの末尾に `.md` を付けると Markdown が取れ、全文は `llms-full.txt` にある。本文の出典としては、上のリポジトリの原稿を使った。
- **Lint**: `@foldkit/oxlint-plugin`（`B/packages/oxlint-plugin-foldkit/src/rules/`）。各ルールの説明は [Oxlint Plugin](https://foldkit.dev/tooling/oxlint-plugin) の原稿 `B/packages/website/src/page/toolingLinting.md` にある。
- **Issue**: [#1362](https://github.com/foldkit/foldkit/issues/1362)（open）と [#1601](https://github.com/foldkit/foldkit/issues/1601)（open）。2026-10-11 に見た。
- **試作**: `origin/prototype/foldkit-review` のコミット `461f40ccd167de8807fe7b9b93abb8a4467de035`。以下の `P/` は `web/src/prototype-foldkit/` を表す。

本文は、書いてあることをそのまま書いた。書いていないことから自分で考えたことには **推測** と付けた。

---

## 1. 生の DOM イベントの拾い方

### 公式の決め方: 何が原因で起きるかで選ぶ

- 基準は「タイミングではなく原因で選ぶ」こと。次のように振り分ける（`B/AGENTS.md` L170-180、[Mount](https://foldkit.dev/core/mount) `B/packages/website/src/page/core/mount.md` L21-37、[Anti-patterns](https://foldkit.dev/patterns/anti-patterns) `antiPatterns.md` L90-101）。
  - Message が起きたことがきっかけなら Command。
  - 描画した要素があり、`execute` がその要素を使って DOM の処理をするなら Mount。結果が 1 回なら `Mount.define`、リスナーや Observer から続けて出るなら `Mount.defineStream`。
  - Model の条件で開け閉めする外のイベント源なら Subscription。
  - Model の条件があり、Command がハンドルを要るなら ManagedResource。
- 「Mount の `execute` が要素を読みも書きもしないなら、原因を取り違えている」（`B/AGENTS.md` L180、`mount.md` L49-51）。これは Lint の `foldkit/mount-factory-must-use-element` で検出される（`toolingLinting.md` L295-299）。
- 1 つの要素に `OnMount` は 1 つしか付けられない。2 つ付けると後のほうが黙って前を置き換えるので、処理は 1 つの Mount にまとめ、解放も同じスコープで登録する（`mount.md` L53-55、Lint `foldkit/no-duplicate-onmount-per-element`）。
- Mount は DevTools のタイムトラベルで実行し直される。だから Mount には、何度実行しても安全な、その要素だけで閉じる処理を書く。通信・保存・計測は Command に置く（`mount.md` L57-59）。

### 要素の属性のハンドラ（`h.OnClick` など）

- イベントの属性は Message を作るだけで、純粋なものとして扱う。処理は分岐してよいし、`Option<Message>` を返して出さないこともできる。ただし Effect を実行したり、帰結を決めたりはしない（[View](https://foldkit.dev/core/view) `view.md` L93-113）。
- 同期で行うしかないブラウザの処理（`preventDefault`、iOS の `focus`）には専用の属性やオプションがある。たとえば `OnClick` の `defaultAction` / `propagation` / `focusSelector`、`OnKeyDownPreventDefault`、`OnPastePreventDefault` など。これらは「一般の抜け道ではない」とされている（`view.md` L127-143）。
- 生の `onclick` のような属性は Lint `foldkit/no-raw-dom-event-attributes` で禁止されている（`toolingLinting.md` L165-169）。

**属性のハンドラが渡さないもの**（`B/packages/foldkit/src/html/index.ts` の型 L590-720 と、実装 L1655-1910 で確認）:

| 属性 | 渡すもの | 渡さないもの（例） |
|---|---|---|
| `OnWheel` | Message だけ（L692、実装 L1906-1907 は `() => ctx.dispatch(message)`） | `deltaX/Y`、`deltaMode`、修飾キー、座標、`preventDefault` |
| `OnClick` | Message とオプション（L595） | 修飾キー、座標 |
| `OnMouseDown/Up/Move/Enter…`、`OnTouch*`、`OnDrag*` | Message だけ（L596-603、L705-718） | イベントの値のすべて |
| `OnPointerMove` | `screenX, screenY, pointerType`（L604-609） | `clientX/Y`、`pointerId`、`buttons`、修飾キー |
| `OnPointerUp` | `screenX, screenY, pointerType, timeStamp`（L628-634） | `clientX/Y`、`pointerId`、修飾キー |
| `OnPointerDown` | `pointerType, button, screenX, screenY, timeStamp, clientX, clientY, pointerId, target`（L614-626） | 修飾キー |
| `OnKeyDown*` / `OnKeyUp*` | `key` と `{ shiftKey, ctrlKey, altKey, metaKey }`（L151-163、L635-675） | `code`、`isComposing`、`repeat`、`location` |
| `OnScroll` | `scrollTop`（L691） | `scrollLeft` など |
| Safari の `gesture*` | 属性がない（`html/index.ts` に gesture の属性は無い） | — |

これらの値を取る公式のやり方は 2 つある。

- **要素に付いたリスナー**: `Mount.defineStream` の `execute` で、`Dom.streamFromEvent` に `target: element` を渡す。`mapEvent` には生のイベントの型が届く（[Dom](https://foldkit.dev/core/dom) `dom.md` L46-70、例 `B/packages/website/src/snippet/domMountEvent.ts`）。
- **window・document のリスナー**: Subscription で `Dom.streamFromEvent` 系を使う（`dom.md` L54-62）。
- `preventDefault` が要るときは `Dom.streamFromEventFilterMapPreventDefault` を使う。これは `passive: false` が既定で、リスナーの中で同期して `preventDefault()` を呼ぶ（`dom.md` L72-80）。Stream の演算子（`Stream.map` など）の中で `preventDefault` を呼ぶと遅すぎる。これは Lint `foldkit/no-prevent-default-in-stream-operator` で検出される（`toolingLinting.md` L179-187）。
- wheel を明示した文書は見つからなかった（website・ui・examples・skills を `deltaY`・`'wheel'`・`OnWheel` で grep して、該当なし）。wheel の量は上の一般則（要素のリスナーなら Mount、`preventDefault` は同期で）に従って取る、というのが資料から言えるところ（**推測**）。

### `Stream.callback` と `addEventListener` を手で書くこと

- **禁じられてはいない。公式の例そのものがこの形**。`Mount.defineStream` の TSDoc の例は `Stream.callback` ＋ `Effect.acquireRelease` ＋ `addEventListener` で書かれている（`B/packages/foldkit/src/mount/index.ts` L435-458、IntersectionObserver の例 L463-494）。examples と `@foldkit/ui` にも同じ形がある。
  - `examples/map/src/main.ts` L343-441: MapLibre とクリック。
  - `examples/charting/src/view/chart.ts`: ECharts と resize。
  - `packages/ui/src/virtualList/index.ts` L1151-1272: scroll、ResizeObserver、MutationObserver。
- Issue [#1362](https://github.com/foldkit/foldkit/issues/1362)（2026-09-08、open）で、作者側も「要素の Observer は毎回同じ 25 行の `Stream.callback` 定型になる」と認め、`observeResize` などの Stream を作る関数を足す案を出している。
- ただし、ハンドルは acquire の本体の中で作る。acquire の前に作ると、割り込まれたときに漏れる（`B/AGENTS.md` L116、`mount.md` L111-113、Lint `foldkit/acquire-release-constructs-in-acquire-body`）。
- 単発のイベント 1 つなら `Dom.streamFromEvent` 系がある。これはリスナーの付け外しを Stream の開始・停止に結び付け、`target` は関数でも渡せ、`options`（`AddEventListenerOptions`）も渡せる（`dom.md` L56-62、`B/packages/foldkit/src/dom/streamFromEvent.ts` L157, L193-228）。手書きのリスナーをこれで置き換えられる場面がある。

### Subscription の helper

- `Subscription.animationFrameEntry`: 依存 `{ isActive }` が真の間、rAF ごとに前のフレームからの ms を渡して Message を出す。`Stream.tick` は経過時間、`animationFrameEntry` は表示の都合に合わせる（[Subscriptions](https://foldkit.dev/core/subscriptions) `subscriptions.md` L75-85）。
  - 既知の不具合: [#1601](https://github.com/foldkit/foldkit/issues/1601)（open）。`animationFrame` だけで動くアプリは描画が 1 フレームおきになる（120Hz で 60fps）。0.166.0 で報告され、0.167.0 で直ったという記録は見つからなかった。
- `Subscription.persistentEntry`: 自分の Model に依存しない Stream に使う。親は lift するときに条件で開け閉めできる（`subscriptions.md` L87-93）。
  - 公式の skill（`B/skills/generate-program/SKILL.md` L617-624、`architecture.md` L346）は今も「依存なしは `{}` を渡す」と書いていて、docs と食い違う。0.167.0 で `Subscription.persistent` から `persistentEntry` に名前が変わったばかり（[0.167.0 の告知](https://foldkit.dev/blog/foldkit-0-167-0) `blog/post/foldkit-0-167-0.md` L47-57）。
- `Subscription.lift` は子の Subscription の記録をまとめて親の型に持ち上げる。`read` は `Option` を返し、`when` で親側から開け閉めできる。`Subscription.aggregate` は複数の記録を合わせる（`subscriptions.md` L117-121、`SKILL.md` L624）。
- 依存は構造で比べ、変わったら Stream を張り直す。張り直したくない値は `keepAliveEquivalence` と `readDependencies` で持つ（`subscriptions.md` L5-7, L99-115）。
- `Dom.streamFromKeyBindings`: 修飾キーは厳密に照合する。既定では入力欄の中では反応せず、IME の変換中（`isComposing`）とキーの長押しによる繰り返しは無視する。キーの意味が Model に依存するなら、`PressedEscape` のような事実の Message を出して update で決める。`mapEvent` でアプリの状態を読まない（`dom.md` L92-108）。

## 2. 導いた値: Model に持つか、view で計算するか

- 既定は view で計算する。「Model にはアプリが覚えておく事実を置く。1 フレームの描画にしか使わない値は、たいてい view で導ける」（[Model](https://foldkit.dev/core/model) `model.md` L37-39）。
- アンチパターン「同じ状態を 2 か所に持つ」: `items` と `query` から作れる `visibleItems` を Model に持つと古くなる。元の値だけを持ち、view で導く。Model の値を写したモジュール変数や、ブラウザのストレージを正としてしまうことも同じ問題（`antiPatterns.md` L36-46）。公式 skill のレビュー観点にも `derived-data-in-model` がある（`B/skills/generate-program/blindSpots.md` L39-41）。
- 導いた値を Model に置いてよいのは、**計測で高いと分かってから**。高いのが view の組み立てや差分なら、まず view のメモ化を使う（`antiPatterns.md` L50）。
- [Performance](https://foldkit.dev/faq/performance) が速くする手順を順番に並べている（`performance.md` L69-77）。
  1. Slow Warnings で遅い段を特定する。
  2. `createLazy` / `createKeyedLazy` を使う（「最も効く道具」とされる）。
  3. 安定した ID で keyed にする。
  4. メモ化で足りないときに限り、導いた値を Model に置く。update で、入力を変える分岐の中で 1 回だけ計算する。そうした分岐はすべて同期を保たなければならないので、`createLazy` より後に使う。
  5. VirtualList を使う。
- [View Memoization](https://foldkit.dev/core/view-memoization)（`viewMemoization.md`）について。
  - lazy の枠と view 関数はモジュールの最上位に置く（L16-20、Lint `foldkit/lazy-view-stable-references`）。
  - 引数は参照で比べる。`modifyFields` が変わらない枝の参照を保つので効く（L22）。
  - `createKeyedLazy` のキーは消えないので、有限の集合に使う（L46-48）。
  - 全部の関数に付けない。先に計測する（L50-58）。
- 本番の更新の経路は Model の大きさに比例する仕事をしない。変化の検出は参照の等しさによる（`performance.md` L9-16）。

## 3. Model の Schema

### なぜ Schema が要るか

- Model の Schema は、**開発中のリロードで Model を保存・復元するとき**に使う。「TypeScript の型はコンパイル後に消えるので、Foldkit は Model の Schema で、ホット更新をまたいで保つ状態を encode・decode する」（`model.md` L13-15）。「API を decode しないアプリでも、Model の型を Schema から導くことが大事。Foldkit は開発中のリロードの後に状態を戻すとき Model の Schema を使う」（`antiPatterns.md` L62）。
  - 実装: `runtime.ts` L450-455 で `Schema.toCodecJson(Model)` を作る。保存された Model の decode が失敗すると、`init` を実行し直す（L476-481、復元を捨てる）。encode は書き込み 200ms 後の debounce と、Vite のフルリロードの直前に走る（L485-536）。すべて `import.meta.hot` があるときだけで、本番の bundle からは除かれる（`performance.md` L58-66）。
- **DevTools の Model の表示は Model の Schema を使わない**。`B/packages/foldkit/src/devTools/serialize.ts` L20-40 は値を構造から見る形にする（Redacted、File、Date、URL、配列、オブジェクト）。DevTools MCP の dispatch は **Message** の Schema（`toCodecJson`）で decode する（`devTools/webSocketBridge.ts` L100-145）。
- アンチパターン「型が約束することを Schema が確かめていない」: 手書きの型が中身を約束しているのに、Schema が何でも受けている状態のこと。Schema で定義して型を導くこと。`Schema.Unknown` は、その境界にもっと狭い Schema が無いときだけ使う（`antiPatterns.md` L52-62）。
- Lint `foldkit/prefer-option-over-nullable-in-model`: `const Model = Schema.Struct({...})` の直下の欄では、無いことを `Schema.Option` で表す。nullable や optional は使わない（`toolingLinting.md` L125-129、`B/AGENTS.md` L66-67, L92）。

### Set・Map・外部の型

- 公式の例は Effect の Schema の集合型を Model に置いている。`Schema.HashMap(Schema.String, PostDetailData.schema)`（`B/examples/api-cache/src/main.ts` L66）、「id で引く集まりは `Schema.HashMap`」（[Coming from TanStack Query](https://foldkit.dev/react/coming-from-tanstack-query) `comingFromTanStackQuery.md` L17, L32, L93）。Effect 4 には `Schema.ReadonlySet` / `ReadonlyMap` / `HashSet` / `HashMap` がある（`B/repos/effect/packages/effect/src/Schema.ts` L9064, L9142, L13597, L13689）。
- Freeze Model は、普通のオブジェクトと配列を再帰的に凍らせる。`Map`・`Set`・`Date`・クラスのインスタンス・Effect の `HashSet`/`HashMap` などは凍らせない（[Freeze Model](https://foldkit.dev/core/freeze-model) `freezeModel.md` L11-19）。
- **`Schema.declare` で素通しすることは、名指しでは書かれていない**。ただし次のことは事実として言える。
  - 上の「型が約束することを Schema が確かめない」は、まさにアンチパターンとして挙がっている（`antiPatterns.md` L54-62）。
  - Effect 4 の `toCodecJson` は、`toCodecJson` / `toCodec` の注釈が無い Declaration を `Json` として encode する。値が JSON でなければ encode・decode は失敗しうる（`Schema.ts` L15489-15496 の Gotchas）。
  - 帰結（**推測**）: `Schema.declare` で素通しすると Set やクラスのインスタンスが JSON にならず、開発中の Model の保存が失敗するか、壊れた値になる。その場合リロードのたびに `init` からやり直しになる（保存の encode は `Effect.sync` の中の `encodeUnknownSync` なので、失敗すると例外が debounce の fiber の defect になる。`runtime.ts` L489-501、`preserveScheduler.ts` L64-67）。本番の動作と DevTools の表示には影響しない。

## 4. 版の上げ方

- **1.0 より前で、マイナー版で互換を壊すことがある**: 「Foldkit は pre-1.0。アーキテクチャは固まっていて、中核の API は実際には安定しているが、マイナー版で破壊的変更が起こりうる」（`B/README.md` L28、`about.md` L23）。1.0 で安定した公開 API は semver に従う（[Roadmap](https://foldkit.dev/introduction/roadmap) `roadmap.md` L15）。「1.0 までは名前とシグネチャは変わりうるが、アーキテクチャは固定」（`roadmap.md` L64-66）。
  - リポジトリでは major を出せないようにしていて、破壊的変更も `minor` の changeset で出す（`B/AGENTS.md` L194）。消費側のコードが変わる PR にはタイトルに `!` を付ける（L208）。
- **effect は peer で版を固定**: `foldkit` の peer は `effect: "4.0.0"`、`@effect/platform-browser: "4.0.0"`（`B/packages/foldkit/package.json` L174-177）。`@foldkit/ui` の peer は `effect: "4.0.0"`、`foldkit: ">=0.167.0"`（`B/packages/ui/package.json` L131-134）。
  - [Get Started](https://foldkit.dev/get-started) には「Foldkit は Effect 4 stable を使い、peer を厳密な版に固定している: `effect@4.0.0` と `@effect/platform-browser@4.0.0`。これらを一緒に入れる。既存のアプリを上げるときは、Effect のパッケージをすべて同じ版にする」とある（`getStarted.md` L53-57）。導入のコマンドは `npm install foldkit effect@4.0.0 @effect/platform-browser@4.0.0`（`B/packages/website/src/snippet/getStartedInstallFoldkit.sh`）。`foldkit` 自身の版は固定していない。
  - `create-foldkit-app` で作ると、互いに合う版が入る（`getStarted.md` L53）。
- **foldkit 自身を固定するかの指示は無い**。公式 skill には次の指示がある（`B/skills/foldkit/SKILL.md` L35-41）。
  - 参照用の foldkit のソース（`repos/foldkit/` の subtree）を、**入れた `foldkit` の版のタグに合わせる**。
  - 上げたら合わせ直す。
  - canary ならコミットのハッシュに合わせる。
  - 推測: caret（`^0.167.0`）は 0.x では 0.167.x しか受けないので、実際にはマイナー版を固定するのと同じ。
- `RELEASING.md` L54-58 には、複数パッケージの `latest` を一度に切り替えられない npm の制約から「重なる範囲のリリースを出すか、npm が一括昇格に対応するまで利用者を厳密な版に留める」とある。これは保守者向けの手順書の文。
- **上げる頻度**: npm の公開日で見ると、0.136.0（2026-07-30）から 0.167.0（2026-10-08）までの約 70 日でマイナー版が 31 回出た。だいたい 2〜4 日に 1 回（`npm view foldkit time`）。各リリースには GitHub Releases の「upgrade guidance」と blog の告知がある。0.167.0 の告知では、`Subscription.fromEvent` → `Dom.streamFromEvent`、`Subscription.persistent` → `persistentEntry`、`Subscription.animationFrame` → `animationFrameEntry`、`Port.subscription` → `subscriptionEntry` と名前が変わった（`blog/post/foldkit-0-167-0.md` L47-57, L66）。
- 本番化の手順: canary を `canary.foldkit.dev` で smoke してから `latest` に上げる（`about.md` L17-19、`RELEASING.md`）。

## 5. そのほか明示されている作法と禁止

### 副作用と純粋さ（[Side Effects & Purity](https://foldkit.dev/best-practices/side-effects-and-purity) `sideEffectsAndPurity.md`、`antiPatterns.md` L64-101）

- init・update・view は決定的に書く。
  - view の中で `fetch` しない。
  - update の中で `Date.now()`・`Math.random()` を呼ばない。Command で取り、結果の Message で返す。
  - update の中で DOM やストレージに書かない。
  - 本番のログも update に置かない。DevTools の再生で、もう一度実行されてしまう。
  - view・update の中で `document`・`window` を読まない。
  - （`sideEffectsAndPurity.md` L28-35, L57-69）
  - Lint: `foldkit/no-impure-call-at-decision-time`（`Date.now`・`Math.random`・`performance.now`・`crypto.randomUUID` など）。entry ファイルは対象外（`toolingLinting.md` L189-219）。
- 例外は 1 つだけ: DOM イベントのマッパーの中で同期して `preventDefault` する。これは `Dom.streamFromEventFilterMapPreventDefault` を使う（`sideEffectsAndPurity.md` L18）。
- 生きたハンドル（WebSocket など）は、モジュール変数にも Model にも置かず、ManagedResource / Subscription / Mount に持たせる（`antiPatterns.md` L78-101）。Lint `foldkit/no-module-level-mutable-state`（モジュールの最上位の `let`/`var` を禁止）。
- Command のエラーは `Effect.catch(() => Effect.succeed(FailedX(...)))` で Message にする。副作用でアプリを落とさない（`B/AGENTS.md` L69）。
- 順序が要る Command は、同じ配列で返さない。結果の Message を受けてから次を返す（`antiPatterns.md` L139-149）。古い非同期の結果は、世代番号などの文脈を Message に載せて捨てる（L127-137）。
- 開発時の安全装置（`freezeModel`、slow）を切らない。Lint `foldkit/no-disabling-dev-guardrails`（`toolingLinting.md` L227-231、`freezeModel.md` L9）。

### Mount の args（[Mount](https://foldkit.dev/core/mount#args) `mount.md` L61-79）

- args は、要素ごとに違う入力に使う。args は**差し込んだときの値で固定される**。後の描画で DOM のノードが使い回されると、`execute` は実行し直されない。そのため名前は `initialScroll` や `seedValue` のように、固定されることが分かるものにする。
- Model が変わって DOM の処理をし直したいなら、その Message の update で Command を返す。Mount の args は反応する属性ではない。

### keyed（[Keying](https://foldkit.dev/best-practices/keying) `keying.md`、`B/AGENTS.md` L138-144）

- キーを書くのは 2 か所だけ。map で並べる行と、1 つの view 関数が同じ位置に別のエンティティを描くとき（詳細ページなど）。どちらも安定した Model の ID で付け、配列の位置は使わない。分岐には付けない。
- **表示しているデータからキーを作らない**。中身が変わるたびにノードが作り直され、フォーカスや選択範囲が消える（`keying.md` L35-39、`B/skills/generate-program/architecture.md` L370-385）。
- 分岐の同一性は `@foldkit/vite-plugin` が view 関数ごとに付ける。「**プラグイン無しで Foldkit のアプリを build しない**」（`keying.md` L41-43、`performance.md` L74）。プラグインが無いと、分岐の同一性は位置とキーによる扱いに戻り、分岐ごとに手でキーを付けることになる。
- Lint: `foldkit/no-array-index-view-keys`、`foldkit/keyed-required-for-mapped-rows`。

### 命名（[Messages](https://foldkit.dev/best-practices/messages) `bestPractices/messages.md`、`B/AGENTS.md` L37-50）

- Message は**動詞で始まる過去形の事実**にする（`SubmittedUsernameForm`、`PressedKey`）。
  - 接頭辞の使い分け: `Clicked*`、`Updated*`、`Succeeded*`/`Failed*`（失敗に意味があるとき）、`Completed*`（それ以外の Command の結果）、`Got*`（子の Submodel の結果だけ）。
  - `SetX` や `UpdateX` のような命令形は使わない。
- Command の結果の Message は **Command の名前から作る**。`FocusSearchInput` → `CompletedFocusSearchInput`、`FetchUser` → `SucceededFetchUser` / `FailedFetchUser`。`DeterminedStartTime` のような名前は使わない。原因が複数ある Message だけは、共通の事実で名付ける（`EndedAnimation`）。
- `NoOp` は禁止。Model を変えない Message にも、`IgnoredMouseClick` のように事実の名前を付ける（Lint `foldkit/no-noop-message`）。
- Command と Mount の定義は動詞で始まる命令形にする（`FetchWeather`、`AnchorPopover`）。Command の変数名に `Command` を付けない。`Option` の値は `maybe`、真偽値は `is` で始める。分かりにくい略語や 1 文字の名前を避ける（`cbs`・`c`・`t` はだめ。`attrs`・`props`・`ctx`・`fn` などはよい）。

### 状態の持ち方とコードの書き方（`B/AGENTS.md` L52-116）

- 状態は真偽値や nullable の欄ではなく、判別できる union にする（`defineTaggedUnion`。`isLoading` は使わない）。無いことは `Option` で表し、`''`・`0`・`null` のような番兵の値は使わない。
- Model の更新は `modifyFields` で書く（[Immutability](https://foldkit.dev/best-practices/immutability)）。変わらない枝の参照が保たれ、メモ化が効く。Lint `foldkit/no-spread-in-modify-fields`。
- `switch` は使わない。union の `match` か Effect の `Match` を使う（Lint `foldkit/no-switch-on-message-tag`）。`commands: []` と書かない（Lint `foldkit/no-empty-commands-array`）。
- 子の Submodel は `Update.foldChild` / `foldChildAt` / `foldChildStep` で組み込む。子の結果を手で開かない（Lint `foldkit/require-fold-for-child-update-result`）。OutMessage は variant の名前で match する。名前を挙げずに payload を取り出さない（`B/AGENTS.md` L70, L78）。親が子の内部の Message を作ったり、子の欄を直接書き換えたりしない（`antiPatterns.md` L163-181）。
- Model の Schema・Message は Schema で書き、`Msg` と略さない（`B/AGENTS.md` L23）。

### ファイル構成（[Project Organization](https://foldkit.dev/patterns/project-organization) `projectOrganization.md`、`B/AGENTS.md` L146-151）

- 最初は `main.ts` 1 つで書き、Runtime は `entry.ts` で起動する（テストが import しても起動しないように）。
- **Command は、それを返す update の隣に置く。1 つのファイルに集めない**。Command が Message の構築子を import するなら、`message.ts` に切り出して循環を断つ。Subscription を持つ機能は `subscription.ts` を持つ。
- `index.ts` は barrel だけにする。共有の業務の概念は `domain/` に、Schema と純粋な操作と一緒に置く。

### テスト（[Testing](https://foldkit.dev/testing) `testing.md`、[Scene](https://foldkit.dev/testing/scene) `testingScene.md`）

- Story（update を直接動かす）と Scene（描いた view から入る）の両方を書く。ファイル名は `story.test.ts` / `scene.test.ts`。同じ種類が複数あるときは `login.story.test.ts` のように主題を前に付ける。テストは対象の隣に置く（`testing.md` L13-22、`projectOrganization.md` L25-33）。
- Scene は、view にある `OnMount` をすべて保留として記録する。テストは結果の Message で `Mount.resolve` し、外れた Mount は `Mount.expectEnded` で確かめる必要がある（`testingScene.md` L189-210）。
- `Subscription.emit` は、原因が描画した木の外にある Message（タイマーや document のリスナー）にだけ使う。ボタンから出る Message はボタンを click する（`testingScene.md` L214-220）。
- Story・Scene の step は `foldkit/story` / `foldkit/scene` から名前で import する。初期の Model を置く step は `given`（`B/AGENTS.md` L153-157）。公式 skill は、Tier 3 以上で `scene.test.ts` が無いことをブロッカーとして扱う（`blindSpots.md` L176-182）。

---

## 試作（`origin/prototype/foldkit-review` @ 461f40c）との照合

### 沿っているところ

- **要素のイベントを 1 つの Mount にまとめている**: `P/effects.ts:24-102` の `ObserveMap` は、wheel・修飾付きの click・`gesture*`・ResizeObserver・MutationObserver を 1 つの `Mount.defineStream` で持ち、`execute` で `element` を使っている。「1 要素に 1 Mount」「要素を使う」に沿う。`preventDefault` はリスナーの中で同期して呼んでいる（`:59, :62`）。ハンドルは acquire の本体の中で作り、解放を登録している（`:28-99`）。
- **属性のハンドラが渡さない値を Mount で取っている**: wheel の量・修飾キー（`P/effects.ts:57-65`）。Safari のピンチ（`:72-84`）には属性が無い。§1 の表と合う。
- **Mount の args を固定のものに限っている**: `ObserveSeekPointer({ max })`（`P/effects.ts:128-151`、`P/view.ts:213`）の `max` は起動時に決まる値。`<audio>` の操作は Mount の args ではなく Command にしている（`P/effects.ts:1-2` の注記、`:156-184`）。`mount.md` L75-79 に沿う。
- **Subscription の使い分け**:
  - document の pointer は、ドラッグ中だけ開く（`P/effects.ts:261-276`）。
  - 速さのメニューの外側の click（`:285-296`）。
  - 10 秒の無操作を seq で張り直す（`:278-284`）。
  - キーの表を `hasSelection` に応じて作る（`:242-248`、`P/keys.ts`）。
  - `animationFrameEntry`（`:250-253`）。
  - `Slider` の Subscription の `lift` と `aggregate`（`:298-306`）。
  - どれも `subscriptions.md` と `dom.md` L104-106 の形。
- **事実の Message と update での判断**: Esc は `PressedEscape` で受け、メニューを閉じるか見る状態を戻すかは update で決めている（`P/update.ts:112`）。
- **Command のエラーを Message にしている**: `PlayAudio` は `Effect.catch` で `FailedPlay` に変える（`P/effects.ts:161-164`）。
- **導いた値を view で計算している**: 根拠（`evidenceOf`、`P/view.ts:169`）・字幕（`:137`）・エッジ（`:38-45`）。
- **keyed**: ノードは `n.id`（`P/view.ts:76`）、端の丸は `dot.id`（`:82`）、発言は `r.id`（`:121`）。安定した ID で付けている。
- **Message・Command・Mount の命名の大半**:
  - Message は過去形の事実: `ClickedNode`、`PressedViewKey`、`MeasuredNodes`、`ResizedMap`、`TickedFrame`、`IgnoredKey`。子の結果は `GotSeekSlider`（`P/message.ts:12-57`）。
  - Mount は命令形: `ObserveMap`、`ObserveAudio`。
  - Command は命令形: `PlayAudio`、`SeekAudio`、`SyncAudio`。
- **Message を `message.ts` に切り出している**（`P/message.ts`）。Runtime の起動は入口のファイル（`P/main.ts`）にある。
- **テスト**: Story は update を Message で動かし（`web/test/prototypeFoldkitUpdate.test.ts`）、Scene は role で click し、Mount を `Mount.resolve` し、document のキーは `Subscription.emit` で入れている（`web/test/prototypeFoldkitView.test.ts:24, :33, :44`）。

### 外れているところ

| # | 試作の場所 | 公式の勧め | 出典 |
|---|---|---|---|
| 1 | `P/model.ts:95` `Schema.declare(u => typeof u === "object")` で Model を素通しにし、`Model` は TS の型を手書き（`:67-92`） | Model は Schema で定義し、型は Schema から導く。何でも受ける Schema と、多くを約束する型の組み合わせはアンチパターン | `antiPatterns.md` L52-62、`model.md` L13-15 |
| 2 | `P/model.ts:72` `d: Derived`（スナップショット・畳み・配置・木）と `:87` `previous` を Model に持つ | 導いた値は view で計算する。Model に置くのは計測の後、`createLazy` の後で、置くなら入力を変える分岐すべてで同期を保つ | `antiPatterns.md` L36-50、`performance.md` L74-75 |
| 3 | `P/model.ts:78-88` で `null` を「無い」として使う（`anim`・`placedRound`・`beforeOverview`・`keepAnchor`・`axisLock`・`drag`・`lastPress`・`seekPointer`） | 無いことは `Option`（Model の Schema では `Schema.Option`）で表す | `B/AGENTS.md` L66, L92、Lint `prefer-option-over-nullable-in-model` |
| 4 | `P/main.ts:33` `freezeModel: false` | 開発時の安全装置を切らない（変更を隠すのに使わない） | `freezeModel.md` L9、Lint `no-disabling-dev-guardrails` |
| 5 | `P/main.ts:19-23` update を包んで `globalThis.__foldkitModel` に書く | update の中で外へ書かない。Model を写したモジュール変数は Runtime と DevTools から見えない第 2 の値になる。調べるなら DevTools と MCP を使う | `antiPatterns.md` L46, L64-66、`sideEffectsAndPurity.md` L32 |
| 6 | `P/vite.config.ts:4` に `@foldkit/vite-plugin` が無い | プラグイン無しで build しない（分岐の同一性が位置とキーによる扱いに戻る） | `keying.md` L41-43 |
| 7 | `P/view.ts:56` キーが `changed ? \`blink-${round}\` : "steady"` | 表示しているデータからキーを作らない（作り直しのために変わるキーは「変化の検出」で、patch が既にしている） | `keying.md` L35-39、`architecture.md` L370-385 |
| 8 | `P/update.ts:128-139` `Slider.update` を手で呼んで `r.model`・`r.outMessage.value` を開き、`inner._tag === "ReleasedDragPointer"` で子の内部の Message を見る | `Update.foldChild` で組み込み、OutMessage（`ChangedValue`）は variant の名前で fold する。子の内部の Message に依存しない | `B/AGENTS.md` L70, L78、`antiPatterns.md` L163-181、`sliderPage.md` L126-132 |
| 9 | `P/effects.ts:154-193` で `PlayAudio`・`PauseAudio`・`SeekAudio`・`SyncAudio`・`BlurActive` が `CompletedDom` を共有し、失敗は `FailedPlay` | 結果の Message は Command の名前から作る（`CompletedSeekAudio`、`SucceededPlayAudio`/`FailedPlayAudio` など） | `bestPractices/messages.md` L19-29 |
| 10 | `P/update.ts:37, :138` `commands: … : []` | `commands: []` と書かない（集めた結果をそのまま返すか、省く） | Lint `no-empty-commands-array`、`B/AGENTS.md` L71 |
| 11 | `P/update.ts`・`P/mapCamera.ts` の全体で `{ ...m, … }` の spread で更新 | `modifyFields` を使う（変わらない枝の参照を保つ） | `immutability.md`、`B/AGENTS.md` L114-115 |
| 12 | `P/mapCamera.ts:98-121` `switch (command.type)` | `switch` を使わず `match` / `Match` を使う | `B/AGENTS.md` L86、Lint `no-switch-on-message-tag`（Message と状態の `_tag` が対象） |
| 13 | `P/effects.ts:196-207` `fromWindow` と `:225-236` `audioFrames` が、`Stream.callback` ＋ `addEventListener` / rAF の手書き | 手書き自体は公式の例と同じ形で、禁止ではない。ただし `fromWindow` は `Dom.streamFromEventFilterMap`（`target` は関数でよく、`options.capture` も渡せる）で置き換えられる | `mount/index.ts` L435-458、`dom.md` L56-80、`streamFromEvent.ts` L193-228 |
| 14 | `P/effects.ts:210-222` `imeRedispatch` がリスナーの中で `stopImmediatePropagation` と `dispatchEvent` を行う（Message を出さない Subscription） | Stream のマッパーに許されている同期の副作用は `preventDefault` だけ。IME の変換中は `streamFromKeyBindings` が無視する。ほかの副作用を許す記述は無い（**推測**: 公式の想定の外にある） | `sideEffectsAndPurity.md` L18、`dom.md` L98 |
| 15 | `P/effects.ts` 1 つに Mount・Command・Subscription をまとめている | Command は返す update の隣に置き、1 つのファイルに集めない。Subscription は `subscription.ts` | `projectOrganization.md` L17-21、`B/AGENTS.md` L150 |
| 16 | テストのファイル名が `prototypeFoldkitUpdate.test.ts` / `prototypeFoldkitView.test.ts` で、`web/test/` に置いている | `story.test.ts` / `scene.test.ts`（主題を前に付ける）を対象の隣に置く（うちの層の決まり `*.test.ts` との兼ね合いは #746 で決める） | `testing.md` L15-20 |
| 17 | `web/package.json`（試作のブランチ）が `effect: 4.0.1` と `@effect/platform-browser: 4.0.1` | peer は厳密に `4.0.0`。一緒に入れる（Foldkit 0.167.0 は 4.0.1 を peer として受けない） | `getStarted.md` L55、`B/packages/foldkit/package.json` L174-177 |
| 18 | 名前の略し: `m`、`d`、`r`、`e`、`el`、`dims`、`anim`、`Mods`、`ModClicked`、`cls` | 分かりにくい略語や 1 文字の名前を避ける | `B/AGENTS.md` L44 |

ほかに気づいたこと:

- `P/update.ts:148-162` は、update の後ろで再生の状態の前後を比べ、`PlayAudio`・`PauseAudio`・`SyncAudio` を足している。これに当たる公式の記述は見つからなかった。公式の Command は、各 Message の handler が返す形で書かれている（`antiPatterns.md` L68-72）。この比べ方が規約上どう扱われるかは書かれていない（**推測**: 書かれていないだけで、禁止されてもいない）。
- `P/effects.ts:225-236` の `audioFrames` は rAF ごとに `document.getElementById` で `<audio>` を引いている。要素に結び付いた処理は Mount に置く、というのが原則（`mount.md` L27）。一方で、Model の条件（再生中）で開け閉めしているので、Subscription とも言える。どちらを正とするかは資料では決まらない（**推測**）。
- 試作の `TickedFrame` は `animationFrameEntry` で動いているので、[#1601](https://github.com/foldkit/foldkit/issues/1601)（描画が 1 フレームおき）の影響を受ける可能性がある（**推測**。計測はしていない）。
- DevTools を使うなら、`TickedFrame` や `MovedPointer` のように回数の多い Message は `excludeFromHistory` で履歴から外せる（`performance.md` L67）。

## 規約の決定（#746）への含み

ここに挙げたのは、資料から言える範囲に限った論点。どれを採るかは #746 で決める。

- 生のイベント: 属性で足りるもの（click・keydown・pointerdown）は属性で受ける。量や修飾キーが要るものは、要素なら `Mount.defineStream`、document・window なら Subscription にする。単発のイベントには `Dom.streamFromEvent` 系を使い、Observer や複数のイベントは `Stream.callback` で書いてよい。これが公式の例と同じ線になる。
- Model の Schema: `Schema.declare` で素通しするのは公式のアンチパターンに当たる。Set・Map は `Schema.ReadonlySet` / `HashSet` などで書ける。
- 導いた値: 既定は view で計算する。Model に置くなら、計測と `createLazy` の後にする。
- 版: `foldkit`・`@foldkit/ui` は同じ版に揃えて固定し、`effect`・`@effect/platform-browser` は Foldkit の peer に厳密に合わせる。上げるときは、そのリリースの告知と release notes の名前の変更を読む。Foldkit は 2〜4 日に 1 回、マイナー版で互換を壊すことがある。
- 道具: `@foldkit/vite-plugin` と `@foldkit/oxlint-plugin`（recommended）を入れると、上の多く（keyed、`commands: []`、`switch`、Mount の要素、`no-disabling-dev-guardrails`、`Date.now`）を機械で検出できる。
