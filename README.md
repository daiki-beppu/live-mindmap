# live-mindmap

**English** | [日本語](README.ja.md)

A mind map that AI builds in real time from what is said in Japanese meetings.

> [!NOTE]
> **Built for meetings held in Japanese.** Speech recognition is Apple's on-device recognizer with the Japanese (ja-JP) locale only, on macOS 26 or later. The map, captions and CLI messages are in Japanese.

live-mindmap listens to your meeting app (Zoom, Google Meet, a webinar in the browser), transcribes it on your Mac, and keeps updating a mind map while people talk. Instead of reading AI minutes after the meeting, everyone discusses while looking at a map that keeps itself organized.

## How it works

- **Transcribed on your Mac.** Audio from the meeting app and your microphone is captured and transcribed on the Mac. The audio itself does not leave the Mac.
- **Edited, not redrawn.** For each new remark, the AI applies small operations to the existing map (add, update, merge, move, resolve, delete, or nothing). Coming back to a topic extends the existing node instead of adding a new one.
- **Every node has its evidence.** Click a node to see the remarks, speaker and time it came from.

## What you can do

Read the [full descriptions in Japanese](README.ja.md#できること).

- **Map a meeting live** (`cli start`). [Details in Japanese](README.ja.md#できること).
- **Tell speakers apart.** Your microphone is a separate track with echo cancellation; others are split into 相手 A–D on the Mac.
- **Name speakers.** Type a name on the caption, or let the AI infer it from self-introductions and replies to direct address.
- **Pause your microphone.** Capture pauses when the meeting app is not using the microphone; you can also toggle it with M.
- **Use the shared screen as context.** Slides are sent to the AI and their words help fix proper nouns.
- **Fix proper nouns with a vocabulary** (`--vocab`, `cli vocab`). Use words from a file, the shared screen and past sessions.
- **Follow long meetings.** Finished topics fold away and the camera follows the current one.
- **See what changed.** Press F during a meeting or review to switch between the whole map and the latest changes; Esc returns.
- **Trace the evidence.** Select a node to see its source remarks, speakers and times.
- **Track TODOs.** A side panel lists TODOs with owner and due date; select one to see it on the map with its evidence.
- **Share the live view** (`cli share`). Limit access by email or domain.
- **Publish the review page** (`cli publish`). Use your own Cloudflare account, with an expiry and a passphrase by default.
- **List and withdraw publications** (`cli publish list`, `cli publish withdraw`). Inspect publication records or remove a published page before it expires.
- **Export and review** (`cli stop`, `cli review`). Export Markdown, JSON, Drawnix, PNG, and a seekable `map.html` (with audio: `map-audio.html`).
- **Build from a recording** (`cli recorded`). Turn a recorded meeting into a session, or save corrected, speaker-labelled remarks without a model using `--no-map` and build the map later with `cli play`.
- **Replay** (`cli play`, `cli restore`). Replay transcripts or past sessions, or restore the map from its log.
- **Choose the model.** Use Claude (your Anthropic API key), a ChatGPT subscription, or Apple Intelligence in local mode; judges (Jev or Clef) route updates by complexity.
- **Evaluate** (`cli eval` and bench tools). Measure map shape, recognition accuracy and latency, score proposers, assignees and inferred speaker names, and compare AEC3 settings on recorded audio. See [評価](README.ja.md#できること).

## Getting started

Requirements:

- A Mac with macOS 26 or later (local mode needs macOS 27 and Apple Intelligence)
- Node.js, pnpm, the Swift toolchain (Xcode or Command Line Tools), git, and uv
- An Anthropic API key for Claude, or one of the other models

For Claude, set your API key in the terminal that starts the server:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
git clone https://github.com/daiki-beppu/live-mindmap
cd live-mindmap
pnpm bootstrap      # once: installs packages, builds the WebRTC audio-processing library, fetches Swift packages
pnpm dev            # builds the helper, starts the server and the view
```

In another terminal, from the same repository directory:

```sh
bash helper/scripts/fetch-speaker-models.sh    # once: speaker-diarization models
pnpm cli install claude
pnpm cli install speech-ja       # Japanese speech recognition
pnpm cli install chromium        # optional: map.png
pnpm cli check

pnpm cli apps                    # find your meeting app's bundle id
pnpm cli start --app us.zoom.xos
# open http://localhost:5173 in a browser window separate from the meeting
pnpm cli stop                    # writes map.md, map.json, map.png, map.html, ...
```

Next: [model choice](README.ja.md#差分更新のモデルを選ぶ), [Claude authentication](README.ja.md#claude-の認証), [local mode](README.ja.md#ローカルモード), and all CLI commands in [live sessions](README.ja.md#ライブのセッション) (Japanese).

## Roadmap

Plans and progress live in GitHub issues: [specs](https://github.com/daiki-beppu/live-mindmap/issues?q=is%3Aissue+is%3Aopen+label%3Aspec), [maps in design](https://github.com/daiki-beppu/live-mindmap/issues?q=is%3Aissue+is%3Aopen+label%3Awayfinder%3Amap), and [ideas](https://github.com/daiki-beppu/live-mindmap/issues?q=is%3Aissue+is%3Aopen+label%3Aneeds-triage).

## License

[MIT](LICENSE). The `@anthropic-ai/claude-agent-sdk` installed by `cli install claude` is under Anthropic's terms.
