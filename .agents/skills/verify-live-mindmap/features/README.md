# live-mindmap の確かめの地図

利用者から見える振る舞いを確かめるときの、正の手順です。操作の前にこの索引を読み、当たる機能のファイルを手順として使います。

## 前提（どの機能でも）

- `bash $S/launch.sh` で立てた run（`$RUN`）だけを操作します。`bash $S/doctor.sh "$RUN"` がすべて `ok` であること。
- `S=.agents/skills/verify-live-mindmap/scripts`、`P=$(cat "$RUN/web-port")`。
- 立てた直後はセッションがありません（`cli.sh "$RUN" status` が `セッションなし`）。

## 操作の決まり

- 画面は `bash $S/browser.sh "$RUN" ...`、CLI は `bash $S/cli.sh "$RUN" ...` で操作します。
- 要素は `snapshot` の role と名前で探し、その `ref` を `click` に渡します。`ref` は snapshot のたびに変わりうるので、操作の直前の snapshot から取ります。
- 字幕とノードは helper と偽の updater の後に出ます。`sleep 3` してから snapshot し、出ていなければもう一度 snapshot します（10 秒で出なければ不合格）。
- 書かれた引数・名前はそのまま使います。

## 証拠と、確かめられなかったときの報告

- 証拠には、機能の ID（下の Sub-features）と、通った入り口を添えます。
- 画面の証拠は snapshot（`.playwright-cli/page-*.yml`）と `shots/` の写しの両方。CLI の証拠は `cli/` の out・err・code。
- 前提が満たせず通れなかった入り口は、試したコマンドと満たせなかった前提を書いて報告します。別の入り口で通ったことを、その入り口を確かめたとは書きません。
- 手順が通らないときは、手順を弱めずに失敗として報告し、理由を機能のファイルの Gotchas に足します。

## 機能

- [会議中の流れ](./meeting-live.md): `start` → 字幕の吹き出し → ノード → `stop` → 書き出し。
- [ノードの根拠と変わったこと](./node-evidence.md): ノードを選ぶと根拠の発言が出る。右の列の「変わったこと」。
- [見返し](./review.md): `review` で作った `map.html` の時刻のスライダー・再生の速さ・字幕と右の列の出し入れ。
- [取り込みの状態とマップの取り出し](./cli-session-state.md): `status`・`export`・`restore`。
