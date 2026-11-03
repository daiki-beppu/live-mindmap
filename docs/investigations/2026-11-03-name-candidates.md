# 名前の候補を探し直す（issue #1887）

調べた日: 2026-11-03。takt の deep-research（run `20261103-075117-issue-1887-no-wo-takt-no-deep-5zvyzy`）の調査・分析を、この文書にまとめた。run は最終確認の段で調査の内容を認められた後、納品の前に手順の上限で止まったので、まとめと投稿は手元で行った。名前はここでは決めない。

前回の衝突調査は [2026-11-03-name-collisions.md](https://github.com/daiki-beppu/live-mindmap/blob/research/name-collisions/docs/investigations/2026-11-03-name-collisions.md) にあり、深刻さの 3 段（重い・中・軽い）はそれに合わせた。

## 結論

- 条件をすべて満たす主な候補は **tidod・widod・odoti・edoti・udoti** の 5 案。どれも小文字 5 字で、頭文字の 1 つ目が名前自身を指す直接の再帰的頭字語。
- 推奨は **tidod**、次点は **widod**。
- 5 案は 2 つの英文の型（`… Instantly Diagrams Ongoing Discussions` と `… Diagrams Ongoing Talks Instantly`）から作った。意味の発想としては 2 通りで、5 通りではない。

## 作り方

過去 3 回の作り方（意味のある単語に展開形を後付けする型、GNU・WINE 型の「◯◯ではない」）はどちらも刺さらなかった。そこで今回は、言いたい文を先に決め、その頭文字から響きのよい造語を作った。

言いたい文は「進んでいる話し合いを、すぐ図にする」。英語の文の先頭の語を名前自身に置き換え、残りの頭文字が綴りに合う組み合わせを探した。同じ文の先頭の 1 字だけを変えた案は、響きを比べるための案として並べた。

## 主な候補

| 名前・読み | 字数 | 作り方の型 | 展開形 | 伝えること | npm の素の名前 | 衝突の深刻さと要点 |
|---|---|---|---|---|---|---|
| tidod・ティドド | 5 | 文から造語・直接再帰 | TIDOD Instantly Diagrams Ongoing Discussions | 進んでいる話し合いを即座に図にする | 空き（GET 404・`npm view` E404） | 軽い。同名の小さなアカウントと、似た綴りの楽曲表記だけ。同分野の製品は見つからない |
| widod・ウィドド | 5 | 同じ文で響きを変えた造語・直接再帰 | WIDOD Instantly Diagrams Ongoing Discussions | tidod と同じ | 空き | 中。同名のアカウントがあり、GitHub の部分一致で人名 Widodo と混ざる。同名のソフトは見つからない |
| odoti・オドティ | 5 | 図にすることを先に置いた造語・直接再帰 | ODOTI Diagrams Ongoing Talks Instantly | 続いている話し合いを、すぐ図にする | 空き（`@odoti` の scope の API は 200 で中身が空） | 中。同名の建設会社がある。完全同名の repo は用途を確かめていない |
| edoti・エドティ | 5 | odoti の響き違い・直接再帰 | EDOTI Diagrams Ongoing Talks Instantly | odoti と同じ | 空き | 中。同名の衣料ブランドと小さな repo がある。会議の製品ではない |
| udoti・ウドティ | 5 | odoti の響き違い・直接再帰 | UDOTI Diagrams Ongoing Talks Instantly | odoti と同じ | 空き | 中。同名の廃棄物回収サービスと音楽名がある |

5 案とも、調べた範囲で同じ名前のコマンドは見つからなかった。英小文字 1 字違いや隣り合う 2 字の入れ替えで別のコマンドになるものも見つからなかった。USPTO の文字商標検索（WM 一致）は 5 案とも 0 件だった。

### 意味の 3 つの軸

軸は「会議中に、生でマップになる」。

- **話し合いの中身**: 図にする対象を Discussions または Talks にした。旧案の Meeting Activity のように、参加率や進行の流れまで含めて読まれる余地を減らした。Talks には講演・交渉の意味もある。
- **会議中・即時**: 進行中を Ongoing、即時を Instantly で示す。ただし、長い非同期の議論や録音の再生を、文法の上で完全に除けるわけではない。
- **図・マップになる**: 動詞を Diagrams にした。マインドマップという形までは言わないが、旧案の Representation より図になることが直接伝わる。

語の意味は Oxford Learner's Dictionaries で確かめた（[diagram](https://www.oxfordlearnersdictionaries.com/definition/english/diagram_1)・[ongoing](https://www.oxfordlearnersdictionaries.com/us/definition/english/ongoing)・[discussion](https://www.oxfordlearnersdictionaries.com/definition/english/discussion)・[talk](https://www.oxfordlearnersdictionaries.com/definition/english/talk_2)・[instantly](https://www.oxfordlearnersdictionaries.com/us/definition/english/instantly)）。英文全体の自然さ、キャッチーさ、覚えやすさは調べた人の判断で、使う人で試してはいない。

## 推奨

1. **tidod**: 話し合い・進行中・即時・図の 4 つを 1 つの文で言える。調べた範囲で見つかった衝突は、小さなアカウント程度にとどまる。
2. **widod**: tidod と意味が同じで、響きだけが違う。綴りや発音の好みで比べるための案。Widodo と検索で混ざるので、名前の区別では tidod に劣る。

odoti・edoti・udoti も意味の基準は満たす。ただ、ほかの分野の同名のサービス・ブランドと検索で混ざるので、優先度を下げた。

この推奨は調べた人の判断で、人気・分かりやすさ・法的な安全の順位ではない。

## 参考案（主な候補に数えない）

| 名前 | 展開形 | 外した理由 |
|---|---|---|
| lidmi | LIDMI Is Diagramming Meetings Instantly | 会議の中身を描くのか、手順や構成を描くのかが文から決まらない。ロシアに同名のチャット製品（lidmi.ru）がある |
| nidma | NIDMA Instantly Diagrams Meeting Activity | Meeting Activity は参加率・発言時間なども含められ、意味が広い |
| mimda | MIMDA Instantly Maps Discussion Activity | Activity は利用の活動量の分析にも読める。素の名前は空いている（GET 404・E404）。`@mimda` の scope の API は 200（`{"lz-ng-lib":"write"}`）で、scope は誰かが使っているとみられる |
| vilmu | VILMU Illustrates Live Meetings Unceasingly | Unceasingly は硬く、即時に応えるという意味にはならない |
| lumri・zumri | … Updates Mindmaps Reflecting Interchanges | マップになることは伝わるが、会議中・即時が文から抜ける |
| rimlu | RIMLU Is Mapping Live Utterances | 生の発言をマップにすることは伝わる。ただ、話し合いと図の出力の補足が要る。詳しい衝突調査はしていない |
| idoti | IDOTI Diagrams Ongoing Talks Instantly | 意味と形は満たす。ただ、idiot に似た綴りを連想させ、IDO-TI という同名の事業もある |

近い綴りのコマンドがあったため、次の 8 案は外した: vidod・zidod・ridod・kidod・nidod・vidud・uduti・bidod。

## 調べた範囲

| 対象 | 範囲 |
|---|---|
| npm | `https://registry.npmjs.org/<名前>` の GET と `npm view`。scope は組織の package の API。2026-11-03 の 09:04〜09:07 UTC に取得し、手元で `npm view` を再確認した |
| コマンド | POSIX、Apple の公開ソース、shell の組み込み、GNU、Homebrew の formula・cask が入れるコマンド、npm の主要 24 パッケージの bin、Debian trixie amd64 の Contents。英小文字 1 字違いと、隣り合う 2 字の入れ替えも照合した |
| 製品 | 候補ごとに 6 通りの検索で上位 10 件。GitHub は 2 通りの検索で、stars の多い順に上位 20 件 |
| 商標 | USPTO の文字商標検索（WM 一致、size=500） |

## 確かめていないこと

- npm で実際に公開できるか。npm が似た名前を拒む判定や、予約名に当たるかは試していない。
- 日本の商標（J-PlatPat）と、米国以外の商標。米国で 0 件でも、法的に使えるとは限らない。
- 世の中のすべてのコマンド・製品。調べた範囲で見つからなかったという結果にとどまる。
- 英語を母語にする人にとっての発音と自然さ。
