# ノードの根拠と変わったこと

会議中にマップのノードを選ぶと、右の列の「根拠」にそのノードの種類・文言と、元になった発言（時刻の範囲・話者・文）が出ます。右の列の「変わったこと」には、ノードの追加などが新しい順に並びます。

## Sub-features

- `evidence-empty`: 何も選んでいないとき、根拠の欄は `ノードを選ぶと、根拠の発言が出ます`。
- `evidence-select`: ノードを選ぶと、そのノードが押された状態（`[pressed]`）になり、根拠の欄に発言が出る。
- `changes-list`: 「変わったこと」に `<時刻> 追加 要点 <文言>` が新しい順に並ぶ。

## How to get to it (user POV)

- 会議中の画面で、マップのノードをクリックする。
- 右の列の「変わったこと」を見る。

## Driving it with browser.sh / cli.sh

Preconditions:

- `bash $S/launch.sh`（4 件）で立てた run で、[会議中の流れ](./meeting-live.md) の「始める」まで済み、ノードが 2 つ出ている。

- **選ぶ前.** `bash $S/browser.sh "$RUN" snapshot`。`heading "根拠"` の下に `ノードを選ぶと、根拠の発言が出ます`。`heading "変わったこと"` の下の 1 件目が `button "00:07 追加 要点 まず優先順位を決めましょう"`、2 件目が `button "00:04 追加 要点 来月の新機能の進め方を相談したいです"`。
- **選ぶ.** snapshot の `button "来月の新機能の進め方を相談したいです"` の ref を取り、`bash $S/browser.sh "$RUN" click <ref>`。
- **根拠.** `bash $S/browser.sh "$RUN" snapshot`。そのボタンに `[pressed]` が付き、`heading "根拠"` の下に `要点`・`来月の新機能の進め方を相談したいです` と、`00:00〜00:04`・`相手`・発言の文の 1 件。`bash $S/browser.sh "$RUN" screenshot --filename shots/evidence-selected.png`。

## Gotchas

- 黄色の枠は選択ではありません。直前に変わったノードの目印（`map-node--blink`）です。選択は snapshot の `[pressed]`（`aria-pressed`）と根拠の欄で見ます。
- 根拠の話者は、話者の区間が決まると `相手 B` などの仮のラベルから `相手` に変わります。文言で判定し、ラベルの細部に頼りません。
