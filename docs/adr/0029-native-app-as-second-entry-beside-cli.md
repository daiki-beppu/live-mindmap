# 配布版は、CLI と並ぶ人向けの入口として SwiftUI の .app を足し、同じ serverProtocol でサーバーを操作する

> ADR 0003 の「操作の入り口はブラウザのボタンではなく CLI」を、この ADR で書き換えた。パイプラインをローカルの Node サーバーが持つこと、ブラウザはマップを表示するだけであること、同時に扱うセッションが 1 つであることは、ADR 0003 のまま。

ターミナルを開かない人に配るため、メニューバーに常駐する .app を入口に足す（map [#1865](https://github.com/daiki-beppu/live-mindmap/issues/1865)、ticket [#1871](https://github.com/daiki-beppu/live-mindmap/issues/1871)）。メニューバーの常駐・会議を始める画面・初回の準備の画面・設定画面は、すべて SwiftUI のネイティブで作る（`MenuBarExtra`・`Settings` の Scene）。会議中のマップは今のままブラウザで開き、.app は URL を開くだけにする。

- **CLI は残し、エージェントの入口のまま**にする。exit code（ADR 0017 の exit 3 など）と出力の契約は変えない。.app と CLI は、同じ常駐サーバーの同じセッションを操作する
- **.app はサーバーの 1 つのクライアント**で、CLI と同じ `serverProtocol`（ADR 0023）の HTTP の経路を叩く。GUI 専用の口は作らない。GUI に要る操作（設定ファイルの読み書きなど）は、`serverProtocol` に経路として足し、CLI からも使える形にする
- **OS に結び付く仕事は .app が持つ**。サーバーには持たせない
  - マイク・画面収録の許可の状態を読み、システム設定へ案内する（許可は .app の bundle id に付く。調べ [#1868](https://github.com/daiki-beppu/live-mindmap/issues/1868)）
  - Keychain の鍵を読み、サーバーを起動するときに同名の環境変数で渡す（[#1870](https://github.com/daiki-beppu/live-mindmap/issues/1870)）
  - Sparkle の更新と、ログイン時の起動（`SMAppService.mainApp`）
  - サーバーを子プロセスとして起動し、止める
- **サーバーは .app を知らない**。起動したのが .app かシェルかで振る舞いを変えない。入力は今のまま、フラグ・環境変数・設定ファイル

## Considered Options

- **web（Foldkit）の画面をサーバーから配り、ブラウザか WKWebView で開く**: 採らない。`serverProtocol` の Schema を TS のまま使える利点はある。しかし、常駐・許可の状態・Keychain・Sparkle・ログイン時の起動はどれもネイティブでしか書けず、.app は結局 Swift で要る。画面だけを web にすると、技術が 2 つになり、許可や鍵の状態を web へ渡す口がさらに増える。WKWebView で開く案は、map で範囲の外にした「.app の中のウィンドウ」に近い。ブラウザで開く案は、会議を始めるたびにタブが増え、設定画面が macOS の設定の作法から外れる
- **常駐と許可はネイティブ、画面の中身は web にする**: 上と同じ理由で採らない。画面は数個の入力欄と一覧で、web を使うほどの量がない

## Consequences

- Swift の側に、`serverProtocol` の本文と応答の写し（`Codable`）ができる。ADR 0023 の「片側だけの更新に気づける」を Swift まで延ばすため、server が Schema で書き出した見本を Swift のテストが decode する形で、写しのずれを CI で落とす。写すのは GUI が使う経路だけにする
- 設定画面の鍵の変更はサーバーの環境変数に効くので、.app は取り込み中でないときにサーバーを起動し直して反映する。鍵を HTTP でサーバーへ送る経路は作らない
- GUI の文言は Swift の String Catalog に置き、正本は日本語、英語を添える
- MCP が必要になったら、今までどおり同じ操作の上に被せる（ADR 0003）
