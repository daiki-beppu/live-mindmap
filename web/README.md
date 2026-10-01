# web

マップを描く表示専用のブラウザアプリ（#32）。サーバーが WebSocket で送るスナップショットを受け取り、React Flow で描くだけで、差分は適用しない。

```sh
# 1 つ目のターミナル: 再生（--realtime で等速。既定のポートは 4319、LIVE_MINDMAP_PORT で変更）
pnpm --filter @live-mindmap/server cli play test/fixtures/short.transcript.json --realtime
# 2 つ目のターミナル: ブラウザアプリ（/ws を再生側へ proxy する）
pnpm --filter @live-mindmap/web dev
```
