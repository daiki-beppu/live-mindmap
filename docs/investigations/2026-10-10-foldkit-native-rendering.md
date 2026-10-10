# Foldkit の素の描画で今の画面を作るのに要る部品と、Effect の版の制約（Issue #735）

地図 #734 の調査チケット。@xyflow を React ごと `Mount` で抱え込まず、Foldkit の素の描画（vendored snabbdom の仮想 DOM）で今の web の画面を作るとき、何を自前で作り、何を Foldkit や他の非 React のライブラリで賄えるかを、Foldkit のソースと npm の公開情報、この repo の `web/` のコードで確かめた。

- 出典の版: Foldkit は `github.com/foldkit/foldkit` の `main`（コミット `49dc36e`、2026-10-08、`packages/foldkit/package.json` は `0.167.0`）。npm の `foldkit@0.167.0`・`@foldkit/ui@0.167.0`。以下 Foldkit のパスは `packages/foldkit/` からの相対。
- この repo は `origin/main`（`087e68f`）。
- **未検証** と書いたものは、ソースを読んだだけで動かしていない、または一次資料で確かめられなかった主張。

## 結論

- **作れない部品は無い。** 今の画面で @xyflow が担っているのは、描画・パンとズーム（ドラッグ・スクロール・ピンチ）・ノードの実寸の測定・画面の大きさの測定・`fitView` だけ（ノードのドラッグ移動は `nodesDraggable={false}` で使っていない）。配置・カメラの計算・折りたたみ・動きの補間・見る状態の reducer・IME のキーの直しは、すでに React に依らない純粋な関数（`layout.ts`・`camera.ts`・`folding.ts`・`motion.ts`・`viewing.ts`・`imeKey.ts`）で、そのまま使える。
- **自前で作る中心は「マップの表示面」**（ビューポートの変換・パンとズームの入力・エッジの SVG・実寸の測定）で、見積りは 500〜800 行。`MapView.tsx`（502 行）の effect の順序に頼った処理（反映 → 寄せ・保留中のずらし・位置を保つ基準）は、Elm の `update` に移すと素直になる見込み。
- **Foldkit の制約が効くのは入力のイベント。** 要素の属性で付けるハンドラは、`OnWheel` が Message だけ（量を渡さない）、`OnClick`・`OnPointerDown` が修飾キーを渡さない、キーのハンドラは `key` と修飾キーだけ（`code`・`isComposing` を渡さない）。ホイール・⌘＋クリック・⌘⇧＋スクロール・ピンチ・IME のキーは、`Mount.defineStream` か `Subscription` で生の DOM イベントを読む形になる。`Mount` の引数は差し込んだ時点で固定なので、変わる値（倍率など）は Model に置き、Mount は「イベントを Message にする」だけにする。
- **見返しは動画ではなく `<audio>`。** `@videojs/react` は `Slider`（シーク・音量）とアイコンにしか使っていない。`<audio>` は素の要素で置け、時刻の読み出しと再生の操作は Mount／Command で作る。シークバーは `@foldkit/ui` の `Slider` が使えるが、ポインタ位置の章名と時刻のプレビューは自前。
- **Effect の版:** Foldkit 0.167.0 は `effect` と `@effect/platform-browser` を `4.0.0` に exact で peer に要求し、server は `4.0.1` に exact で固定している。web はすでに `server/src/core/` を通して server の `effect@4.0.1` を束ねている（後述）。そろえ方は 3 つあり、推奨は「web も `effect@4.0.1` を exact で持ち、pnpm の `peerDependencyRules.allowedVersions` で Foldkit の peer を 4.0.1 で許す」。effect の実体を 1 つにでき、4.0.0 と 4.0.1 はパッチ版の差。ただし Foldkit が 4.0.1 で動くことは **未検証**。試作で確かめる。
- **テスト:** Foldkit の Story（Model と Command の検証）と Scene（VNode の木を見る。DOM を使わない）は、本物の資源に触れないので unit 層に置ける。今の web の unit テスト（部品を関数として呼び、返った木を見る）と同じ位置づけ。Mount の中身（ResizeObserver・生のイベント）は Scene では動かないので、そこは DOM の要る軽い IT か、e2e で見る。

## 部品ごとの表

| 部品 | 今の担い手 | 判定 | 中身と規模の見積り |
|---|---|---|---|
| ノードの描画（色・印・畳んだ数・点滅） | `@xyflow/react` の `nodeTypes` ＋ `MapNode.tsx` | Foldkit で賄える | 絶対配置の `div` を key 付きの要素（`html/index.ts` の `keyed`）で並べる。点滅のやり直しは要素の key を反映の round で変える今の方法がそのまま使える。〜80 行 |
| エッジの描画 | `@xyflow/react` の既定のエッジ（SVG のベジェ） | 自前で作る（小） | Foldkit の `svg`・`path` で親の右端から子の左端へ曲線を引く。〜50 行 |
| パン（ドラッグ） | `@xyflow/react`（d3-zoom） | 自前で作る（中） | `OnPointerDown`（`clientX`・`pointerId` を渡す）で開始、文書の `pointermove`／`pointerup` を `Dom.streamFromEvent` の Subscription で読む。ノード上の押下がクリックかドラッグかの判定（`MapNode.tsx` の `CLICK_SLOP`）もこちらへ移す。〜120 行 |
| パン（スクロール）・⌘⇧＋スクロールの軸固定 | `panOnScroll` ＋ 自前の native listener | 自前で作る（中） | `OnWheel` は量を渡さないので、マップ要素の `Mount.defineStream` で `wheel` を `passive: false` で聞き、`deltaX/Y`・修飾キーを Message にする。軸の決め方は `camera.ts` の `scrollAxis` をそのまま使う。〜80 行 |
| ズーム（ピンチ・⌘／Ctrl＋クリック） | `zoomOnPinch` ＋ 自前の `onClickCapture` | 自前で作る（中） | Chrome・Firefox のトラックパッドのピンチは `ctrlKey` 付きの `wheel` として届くので、上の wheel の Mount で扱う。Safari は `gesturestart/change` を別に聞く必要がある（**未検証**）。⌘＋クリックは `OnClick` が修飾キー・座標を渡さないので、同じ Mount で `click` を capture で聞く。倍率の計算は `zoomAtPoint` を使う。〜80 行 |
| ビューポート（`setViewport`・`getViewport`・`fitView`） | `@xyflow/react` の store | 自前で作る（小） | Model に `{ x, y, zoom }` を持ち、ノードの層に `transform: translate() scale()` を当てる。`fitView` は `camera.ts` の `overviewViewport` で代わる。撮影（`still`）の「全体が収まったか」も同じ計算で判定できる。〜60 行 |
| 画面（マップ要素）の大きさの測定 | `@xyflow/react` の store の `width`・`height` | 自前で作る（小） | マップ要素の Mount で `ResizeObserver` を張り、大きさを Message にする。列の出し入れの後のずらし（`pendingShift`）は、この Message を受けたときに `update` で処理する。〜40 行 |
| ノードの高さの実測（`layout.ts` が使う） | `@xyflow/react` の `onNodesChange`（dimensions） | 自前で作る（小〜中） | `@foldkit/ui` の `VirtualList` と同じ形（`ui/src/virtualList/index.ts`、`ResizeObserver` で行の高さを測り `MeasuredRows` を送る）。マップの層に 1 つの Mount を付け、子のノードを観測する。新しいノードの観測の付け外しは MutationObserver か、ノードごとの Mount で行う。〜80 行 |
| 動き（位置の補間） | `useAnimatedPositions.ts`（rAF）＋ `motion.ts` | Foldkit で賄える（＋純粋関数の流用） | `Subscription.animationFrameEntry`（`subscription/animationFrame.ts`）で補間中だけ毎フレーム Message を出し、`motion.ts` の `startPositions`・`interpolate` で Model の表示位置を進める。毎フレーム仮想 DOM の差分をとるので、ノード数百での描画の重さは **未検証**（試作で測る）。重ければ CSS の `transition` に寄せる。〜50 行 |
| カメラ（今の議題へ寄せる・全体・位置を保つ・縁の点） | `camera.ts`（純粋）＋ `MapView.tsx` の effect | Foldkit で賄える（純粋関数の流用＋書き直し） | 計算は `camera.ts` をそのまま使う。`MapView.tsx` の effect の順序に頼った処理（反映の通知、`placedRound`、`keepAnchor`、`beforeOverview`、`pendingShift`）を `update` の分岐に書き直す。〜250 行 |
| 折りたたみ | `folding.ts`・`viewing.ts`（純粋） | Foldkit で賄える（流用） | そのまま使う。 |
| 配置 | `layout.ts`（純粋） | Foldkit で賄える（流用） | そのまま使う。 |
| ショートカットキー（#153） | `@tanstack/react-hotkeys`（9 か所の `useHotkey`） | Foldkit で賄える | `Dom.streamFromKeyBindings`（`dom/streamFromKeyBindings.ts`）が単打・連打の列・`Mod+`・入力中の抑止（`whileTyping`）・`preventDefault`・繰り返しの扱いを持つ。`Subscription.persistentEntry` で常時つなぐ。見返しの「フォーカスに譲る」判定（`reviewHotkeyYieldsToFocus`）は `mapEvent` が生のイベントを受けるのでそこで行う。〜60 行 |
| IME（日本語入力オンのキー） | `imeKey.ts`（純粋）＋ `useImeKeyRedispatch.ts` | 自前で作る（小、純粋関数の流用） | `streamFromKeyBindings` も `event.isComposing` のイベントを捨て、`event.key` で照合する（`dom/streamFromKeyBindings.ts` の 718 行・486 行）。`isTrusted` は見ない。今と同じく window の capture で半角に直して送り直す方法がそのまま効く（Subscription に置く）。〜30 行 |
| 字幕（`Captions.tsx`） | React の表示だけ | Foldkit で賄える | 表示だけ。`aria-live` は `AriaLive` 属性がある。共有画面で動かさない要件は CSS の側で、Foldkit に依らない。〜25 行 |
| 根拠のパネル（`EvidencePanel.tsx`） | React の表示だけ | Foldkit で賄える | 表示だけ。〜45 行 |
| 「変わったこと」・キー一覧・知らせ類 | React の表示だけ | Foldkit で賄える | 表示だけ。 |
| 見返しの再生（`<audio>`） | 素の `<audio>` ＋ `usePlaybackClock`／`useAudioClock` | 自前で作る（中） | `<audio>` は素の要素で置ける。`OnTimeUpdate`・`OnEnded` は Message だけで `currentTime` を渡さないので、時刻は `<audio>` の Mount で `timeupdate`（または rAF）を読む。再生・停止・シーク・速さ・音量は、要素を id で探して操作する Command にする（Foldkit の作法。`mount/index.ts` の 305 行の注記）。音声なしの再生時計は `animationFrameEntry`。`reviewPlayback.ts`・`reviewTimeline.ts` は純粋でそのまま使う。〜120 行 |
| 見返しのシークバー・音量 | `@videojs/react` の `Slider` | Foldkit で賄える＋自前（小） | `@foldkit/ui` の `Slider` が WAI-ARIA の slider（キー操作・ドラッグ）を持つ。シークの上のポインタ位置の章名・時刻のプレビュー（`Slider.Preview`）に当たるものは見当たらないので自前。〜80 行 |
| 見返しのアイコン | `@videojs/react/icons` | 自前で作る（小） | インラインの SVG に置き換える（再生・停止・字幕・速さ・音量・チェック）。〜40 行 |
| ライブの受信（WebSocket） | `useLiveFeed.ts` | Foldkit で賄える | Subscription で WebSocket を Stream にする（例 `examples/websocket-chat`）。受けたフレームを `server/src/core` の Schema で decode できる。〜50 行 |
| 撮影（`CaptureView`・map.png） | `MapView` の `still` ＋ `fitView` | 自前で作る（小） | 上のビューポートの計算で全体を収め、収まったかをグローバル変数に書く。〜30 行 |
| 見返し用 HTML の書き出し（web のビルドを同梱） | Vite のビルド | **未検証** | Foldkit も Vite で束ねるので形は変わらない見込み。`@foldkit/vite-plugin` は HMR 用で、本番の束ねには要らないとみるが確かめていない。 |

合計の見積り: 自前で書く分が 1,000〜1,400 行（今の React の部品と hooks、`MapView.tsx` の置き換えを含む）。純粋関数の層（`layout`・`camera`・`folding`・`motion`・`viewing`・`imeKey`・`reviewPlayback`・`reviewTimeline`・`captions`・`evidence`・`changes` など）はそのまま使う。

## 調べたこと

### 1. @xyflow が今担っているもの

`web/src/MapView.tsx` の `<ReactFlow>` の設定から読める範囲:

- `nodesDraggable={false}`・`nodesConnectable={false}`・`elementsSelectable={false}`。**ノードのドラッグ移動は使っていない。** 「ドラッグでの移動」は画面のパン（`panOnDrag`）。
- `panOnScroll`（Free）・`zoomOnPinch`・`zoomOnScroll={false}`・`zoomOnDoubleClick={false}`・`minZoom`／`maxZoom` の切り替え（全体を見るとき 0.02）。
- `onNodesChange` の `dimensions` で実寸を受け、`layout.ts` に高さを渡す。
- `useReactFlow()` の `setViewport`・`getViewport`・`fitView`、`useStore` の `width`・`height`、`getNodesBounds`（撮影の判定）、`useViewport`（縁の点）。
- `onMoveStart`／`onMove` の `event` の有無で「人が動かした」を見分けている。素で作れば、人の入力から来た Message だけが `userMoved` になるので、この見分けは要らなくなる。
- ⌘／Ctrl＋クリックのズームと ⌘⇧＋スクロールの軸固定は、すでに @xyflow の外（`onClickCapture` と native の `wheel` listener）で書いている。

### 2. Foldkit の入力イベントの形（制約）

`src/html/index.ts` の `Attribute` の定義（560〜760 行あたり）:

- `OnWheel: { message }`（692 行）。量（`deltaX/Y`）も修飾キーも渡さない。
- `OnClick: { message, options? }`。`options` は `defaultAction`・`propagation`・`focusSelector` だけ（224 行の `ClickOptions`）。座標・修飾キーは渡さない。
- `OnPointerDown` は `pointerType, button, screenX, screenY, timeStamp, clientX, clientY, pointerId, target` を渡す（614 行）。修飾キーは渡さない。`OnPointerMove` は `screenX, screenY, pointerType`、`OnPointerUp` は `screenX, screenY, pointerType, timeStamp`。
- キーのハンドラ（`OnKeyDown` など）は `key` と `KeyboardModifiers`（`shiftKey`・`ctrlKey`・`altKey`・`metaKey`、151 行）。`code`・`isComposing` は渡さない。
- `OnTimeUpdate`・`OnPlay`・`OnPause`・`OnEnded`・`OnVolumeChange` は Message だけ。
- 生のイベントが要るときは `Dom.streamFromEvent`・`Dom.streamFromEventFilterMapPreventDefault`（`dom/streamFromEvent.ts`。`options: { passive: false }` を明示できる、140 行の注記）を Subscription か `Mount.defineStream` の中で使う。0.167.0 でこれらは `Subscription` から `Dom` に移った（CHANGELOG 0.167.0）。

### 3. `Mount`・`canvas`・Subscription の制約が効く部品

- **`Mount` の引数は差し込んだ時点で固定**（`src/mount/index.ts` 305〜327 行）。`OnMount` は snabbdom の `insert` と `destroy` だけに結びつき、`update` は無い。Model の変化で DOM を操作したいときは、その Message の `update` から Command を出して要素を探して操作するのが作法、と明記されている。
  - 効く部品: 見返しの `<audio>`（速さ・音量・シークを Mount の引数で渡すと反映されない → Command で操作）、wheel／click／ResizeObserver の Mount（引数は持たせず、イベントを Message にするだけにする）。
  - Mount の中身は Scene テストでは動かない（`MountTracker` の注記「Test renderers do not provide this service, since snabbdom hooks never fire in their VNode-only environment」、`src/mount/index.ts` 冒頭）。
- **`canvas`**（`src/canvas/`）は宣言的な図形（`Rect`・`Circle`・`Path`・文字）を毎描画で描き直す `<canvas>`。ポインタの座標は canvas の内部座標で渡す。マップのノードは文字の折り返し・ボタン・フォーカス・`aria` を持つので canvas には向かない。**今の画面では使わない**（エッジを canvas に描く案もあるが、SVG で足りる）。
- **Subscription** は `modelToDependencies` の値が変わると Stream を張り直す（`src/subscription/subscription.ts` 56〜68 行）。毎フレーム変わる値を依存に入れると張り直しが続くので、補間の rAF は `animationFrameEntry`（`isActive` だけを依存にする）で回し、パン中の座標のように頻繁に読む値は `keepAliveEquivalence` で張り直さずに読む（`@foldkit/ui` の `DragAndDrop.autoScroll` が例として挙がっている）。
- **`Runtime.embed`** は React などのホストの中に Foldkit のアプリを差し込むもの（`examples/embedding`）。逆向き（Foldkit の中に React）ではない。React 側から画面ごとに替える移行の道具になる。

### 4. 見返しの再生

- `web/src/ReviewView.tsx`: 再生は `<audio ref src preload="auto" onEnded>` 1 つ。音声なしの見返しは `usePlaybackClock` の時計。**動画は無い。**
- `web/src/ReviewControls.tsx`: `@videojs/react` から `Slider`（`Root`・`Track`・`Thumb`・`Preview`・`Value type="pointer"`）と、`@videojs/react/icons` のアイコンだけを使う。
- `@foldkit/ui` の `Slider`（`ui/src/slider/index.ts`）は role="slider" とキー操作（矢印・PageUp/Down・Home/End）、ドラッグを持つ。ポインタを乗せた位置の値を出す仕組みは見当たらない（`preview`・`hover` の語が無い）。

### 5. 字幕・根拠のパネル・IME

- 字幕と根拠のパネルは表示だけで、Foldkit の `div`・`p`・`ul` と `AriaLive` などの属性で書ける。足りないものは無い。
- IME: 今の問題（日本語入力オンでは `key` が `Process` や全角になり、ライブラリが照合しない）は Foldkit でも同じ。`streamFromKeyBindings` は `event.defaultPrevented || event.isComposing` のイベントを捨て（718 行）、`normalizeKey(event.key)` で照合する（486 行）。`isTrusted` は見ていない。よって `imeKey.ts` の `halfWidthKeyOf` で直して window の capture で送り直す今の方法はそのまま効く。送り直しをやめ、Subscription の中で直してから自前で照合する形にもできる。

### 6. Effect の版

- npm: `foldkit@0.167.0` の peer は `effect: 4.0.0`・`@effect/platform-browser: 4.0.0`（exact）。`@foldkit/ui@0.167.0` は `effect: 4.0.0`・`foldkit: >=0.167.0`。
- 追従の履歴（CHANGELOG と npm の公開時刻）: Foldkit は Effect の版ごとに peer を exact で上げてきた（rc.111 → rc.112 → rc.115 → rc.116 → rc.117 → 4.0.0）。`effect@4.0.0` の公開は 2026-10-01 03:11、それを要求する `foldkit@0.165.0` は同日 21:10。`effect@4.0.1`（10-05）・`4.0.2`（10-07）は出ているが、`foldkit@0.167.0`（10-08）と `main` の `49dc36e` はまだ `4.0.0`。リポジトリの `pnpm-workspace.yaml` は `minimumReleaseAgeExclude` に `effect@4.0.0` を挙げており、新しい版を一定期間待ってから入れる運用とみられる（待つ日数の設定は読み取れず **未検証**）。
- リリースの速さ: 0.148.0（08-18）から 0.167.0（10-08）までの 51 日で 24 版（パッチ版を含む）。CHANGELOG に「Breaking」が 49 か所あり、README は「pre-1.0 … breaking changes may occur in minor releases」と書く。0.167.0 でも `Subscription.fromEvent` などが `Dom` へ移った。
- この repo の今: server は `effect@4.0.1`・`@effect/platform-node@4.0.1`・`@effect/vitest@4.0.1` を exact で固定（`server/package.json`）。web の `package.json` には `effect` が無いが、`web/src/main.tsx` が `server/src/core/index.ts` から値（`REVIEW_LOG_ELEMENT_ID` など）を import し、`index.ts` は `map.ts` など `effect` の `Schema` を使うモジュールを再輸出している。Vite は import 元のファイルから `effect` を解決するので、**web はすでに `server/node_modules` の `effect@4.0.1` を束ねている**（tree-shaking でどこまで残るかは **未検証**）。
- そろえ方の候補:
  1. **web も `effect@4.0.1` を exact で持ち、ルートの `pnpm.peerDependencyRules.allowedVersions` で `foldkit>effect`・`foldkit>@effect/platform-browser` に 4.0.1 を許す。** pnpm は web の `effect` で Foldkit の peer を満たすので、server と web が同じ `.pnpm/effect@4.0.1` を指し、実体は 1 つになる（pnpm の peer の解決の仕組みからの推論。**未検証**）。パッチ版の差なので API の互換は期待できるが、Foldkit が 4.0.1 で動くことは **未検証**。`@effect/platform-browser@4.0.1` は npm にある。
  2. **server を 4.0.0 に下げてそろえる。** 確実だが、server の版を Foldkit の都合で止めることになる。Foldkit が上げるたびに server もそろえる運用になる。
  3. **web だけ 4.0.0、server は 4.0.1。** `effect` の実体が 2 つ束ねられ、`server/src/core` の Schema（4.0.1）を Foldkit 側（4.0.0）の Schema・Message に混ぜることになる。型の識別子や `instanceof` の食い違いの恐れがあり、勧めない（実害は **未検証**）。
- 共有のパッケージへの切り出し（地図の Not yet specified）をするなら、そのパッケージも同じ exact の版を持つ。どの案でも、Effect を上げるときは server・web・Foldkit の 3 つを同時に動かす。

### 7. テストの層

- Foldkit の `Story`（`src/test/story.ts`）は `update` を Message の列で進め、Model と Command（解決の有無）を確かめる。`Scene`（`src/test/scene.ts`）は同じく進めて VNode の木を role・text・label などの Locator で確かめる（「Scene tests assert through the view, not the model」）。どちらも DOM・ネットワーク・ファイルに触れない。matchers は `foldkit/test/vitest` の `setup()` で足す。
- この repo の層（`AGENTS.md` の Checks、`CODING_STANDARDS.md` の Tests）では、層は「実際に越える依存の境界」で決まる。Story・Scene は本物の資源を使わないので **unit 層**（`*.test.ts`）。`check-test-layers.ts` が禁じる `node:fs`・`node:net`・`ws`・`playwright` も使わない。今の web の unit テスト（部品を関数として呼び、返った React の木を `test/tree.ts` で調べる）と同じ位置。
- Scene で見えないもの: Mount の中身（ResizeObserver の測定、wheel・click の生のイベント、`<audio>` の操作）。ここは DOM が要るので、jsdom などを入れた軽い IT にするか、e2e（tester-army の `e2e/`）に任せる。web の vitest には今 DOM の環境が無い（**未検証**: jsdom の導入の要否は試作で決める）。
- E2E は画面の DOM が変わるので、`e2e/.e2e/cache/` の録り直しが要る（地図の Not yet specified のとおり）。

## 試作で作るもの（合否の判定）

地図の物差し「見た目と操作が今と同じで、@xyflow を React ごと `Mount` で抱え込まず素の描画で作れること」を、記録済みのセッション 1 本で今の画面と並べて判定する。作るのは次の範囲で足りる。

1. **見返しの画面（`map-audio.html` 相当）を Foldkit で作る。** ライブの受信より入力が決まっていて並べやすく、マップ・字幕・根拠・再生の全部を通る。`reviewTimeline.ts`・`reviewPlayback.ts` などの純粋関数はそのまま使う。
2. **マップの表示面を素で作る:** ノード（実寸の測定つき）・エッジ（SVG）・ビューポートの変換・パン（ドラッグ／スクロール）・ピンチと ⌘＋クリックのズーム・⌘⇧＋スクロールの軸固定・位置の補間・今の議題へ寄せるカメラ・全体を見る・縁の点・折りたたみの丸。
3. **#153 のキーを全部:** `SessionView.tsx` に登録したもの（矢印・E・C・?・Escape など）と、見返しの Space・K・J・L・, . < > Home End M。日本語入力オンでも効くこと。
4. **`<audio>` の再生とシークバー**（`@foldkit/ui` の Slider ＋ 章名・時刻のプレビュー）。

合否の項目（並べて見る）:

- 見た目: 同じ時刻で、ノードの位置・大きさ・色・エッジ・点滅・畳んだ数が今の画面と同じ（スクリーンショットの目視。必要ならピクセルの差分）。
- 操作: トラックパッドのパン・ピンチ（Chrome と Safari）、⌘＋クリック、⌘⇧＋スクロール、ドラッグとクリックの見分け、#153 のキー、日本語入力オンのキー。
- 動き: 反映ごとの補間が 500 ms で途切れずに走る。ノード数の多いセッション（最も大きいもの）で、補間中のフレーム落ちを DevTools の Performance で測る（毎フレームの仮想 DOM の差分が足りるかの判定。足りなければ CSS の transition に切り替えて再判定）。
- カメラ: 反映で今の議題へ寄る、人が動かすと止まる、全体を見る → 戻る、列の出し入れでずれた分だけ寄せる、開閉で位置を保つ。
- 字幕: 共有画面で字幕・マップが跳ばない。
- 版: `effect@4.0.1` ＋ `peerDependencyRules` で Foldkit 0.167.0 がビルド・実行でき、束ねた `effect` が 1 つであること（ビルドの出力で確かめる）。
- テスト: 試作の `update` に Story を 1 本、表示に Scene を 1 本書き、unit 層の `vitest run --project unit` と `typecheck`（`check-test-layers`）に通ること。

## 出典

- Foldkit のソース（`github.com/foldkit/foldkit`、コミット `49dc36e`）
  - `packages/foldkit/src/mount/index.ts`（Mount の定義と、引数が固定である注記）
  - `packages/foldkit/src/html/index.ts`（属性とイベントハンドラの型）
  - `packages/foldkit/src/dom/streamFromEvent.ts`・`streamFromKeyBindings.ts`
  - `packages/foldkit/src/subscription/subscription.ts`・`animationFrame.ts`
  - `packages/foldkit/src/canvas/view.ts`・`shape.ts`
  - `packages/foldkit/src/test/story.ts`・`scene.ts`・`vitest.ts`
  - `packages/ui/src/virtualList/index.ts`（ResizeObserver による高さの測定）・`packages/ui/src/slider/index.ts`
  - `packages/foldkit/CHANGELOG.md`・`README.md`・`pnpm-workspace.yaml`
  - `examples/embedding`・`examples/map`・`examples/websocket-chat`
- npm: `npm view foldkit time peerDependencies`、`npm view @foldkit/ui peerDependencies`、`npm view effect time`、`npm view @effect/platform-browser versions`（2026-10-10 に取得）
- この repo: `web/src/MapView.tsx`・`MapNode.tsx`・`layout.ts`・`camera.ts`・`motion.ts`・`useAnimatedPositions.ts`・`imeKey.ts`・`useImeKeyRedispatch.ts`・`Captions.tsx`・`EvidencePanel.tsx`・`ReviewView.tsx`・`ReviewControls.tsx`・`main.tsx`・`reviewKeys.ts`、`web/package.json`・`web/vite.config.ts`、`server/package.json`、`server/src/core/index.ts`、`CODING_STANDARDS.md`（Tests）、`AGENTS.md`（Checks）
