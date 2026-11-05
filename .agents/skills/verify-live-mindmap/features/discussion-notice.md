# 堂々巡りの知らせ

未決の論点が、根拠の最初の発言から 10 分以上続き、子が 3 件以上増えると、画面に判断軸の整理を勧める知らせが重なって出ます。判断軸があれば全軸を記載順に添えます。知らせはログに残りますが、マップの書き出しや見返しには載りません。

## Sub-features

- `notice-show`: 条件を満たすと、帯の下に `「<論点>」が 10 分決まっていません。判断軸「<軸>」「<軸>」で決められそうですか` が出る。
- `notice-log`: `log.jsonl` に `"type":"discussion-notice"` の行（`at`・`pointId`・`text`）が残る。
- `notice-not-exported`: `map.md`・`map.json` と見返しの画面には知らせが出ない。

## How to get to it (user POV)

- 会議中の画面を開いたまま、決まらない論点の議論を 10 分以上続ける。

## Driving it with browser.sh / cli.sh

Preconditions:

- `RUN=$(LIVE_MINDMAP_VERIFY_DISCUSSION=1 bash $S/launch.sh 2)` で立てた run。台本は `e2e/fixtures/discussion.json`（2 件と、30 秒後に会議時刻 599〜600 秒の自分の発言 1 件）。セッションなし。

- **始める.** `printf '利用者への影響\n工数\n' > "$RUN/criteria.txt"`、`bash $S/browser.sh "$RUN" open "http://127.0.0.1:$P/"`、`D=$(bash $S/cli.sh "$RUN" start --app us.zoom.xos --criteria "$RUN/criteria.txt" | tail -1)`。
- **知らせの前.** `sleep 4; bash $S/browser.sh "$RUN" snapshot`。`button "? 導入の進め方"` と `button "段階導入 — 自分"`・`button "一括導入 — 自分"`・`button "試験導入 — 自分"`。`決まっていません` はまだ無い。`bash $S/browser.sh "$RUN" screenshot --filename shots/discussion-before.png`。
- **知らせ.** `sleep 32` して snapshot。帯 `判断軸（優先順）` の下に `「導入の進め方」が 10 分決まっていません。判断軸「利用者への影響」「工数」で決められそうですか`。`bash $S/browser.sh "$RUN" screenshot --filename shots/discussion-after.png`。`grep -c '"type":"discussion-notice"' "$D/log.jsonl"` が 1。
- **書き出しに載らない.** `bash $S/cli.sh "$RUN" stop` の後、`grep -c 決まっていません "$D/map.md" "$D/map.json"` がどちらも 0。
- **見返しに載らない.** `SD=$(cat "$RUN/sessions-dir"); mkdir -p "$SD/disc"; cp "$D/log.jsonl" "$SD/disc/"; bash $S/cli.sh "$RUN" review "$SD/disc"`。`goto "http://127.0.0.1:$P/session-files/disc/map.html"` の snapshot に `決まっていません` が無く、帯と `button "? 導入の進め方"` はある。`grep -c '導入の進め方」が' "$SD/disc/map.html"` が 0。

## Gotchas

- `LIVE_MINDMAP_VERIFY_DISCUSSION=1` は `launch.sh` から `serve.ts` へ環境変数で渡ります。偽の updater は最初の反映で論点と案 3 つを足し、以降は何も足しません。
- 知らせは会議時刻（発言の終わりの時刻）で測ります。台本の 3 件目の終わりが 600 秒なので、実時間で 30 秒待てば出ます（ログの `at` は 600）。
- `map.html` に埋め込むログからは知らせの行を除きます。ただし JS の中に文面の型があるので、`grep 決まっていません` は当たります。ログに無いことは論点の名前を含む `導入の進め方」が` で、見返しに出ないことは画面の snapshot で見ます。
- 判断軸を渡さないと、知らせの後半の文が `何を重視して決めるかを先に確かめませんか` に変わります。文の分数は経過の実数で、10 分とは限りません。同じ論点は 1 回だけ、再開すると測り直し、知らせ同士は 5 分空けます。この手順は判断軸ありの 1 回目だけを確かめています。
