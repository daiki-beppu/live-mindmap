import { useEffect, useState } from "react";
import type { Snapshot, SpeakingFrame, Track } from "../../server/src/core/index.ts";

const RECONNECT_MS = 1000;

export type Speaking = Record<Track, string>;
const NO_SPEAKING: Speaking = { 相手: "", 自分: "" };

// /ws から届く frame を購読する。type が "speaking" のものは、トラックごとの「いま話している文字」。それ以外はスナップショット。
// 切れたら 1 秒後につなぎ直し、切れている間も最後のスナップショットを持ち続ける。
// つなぎ直したときは空に戻し、サーバーが送り直す現在の文字で埋める（古い文字を残さない）。
export function useLiveFeed(): { snapshot: Snapshot | null; speaking: Speaking } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [speaking, setSpeaking] = useState<Speaking>(NO_SPEAKING);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setSpeaking(NO_SPEAKING);
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as Snapshot | SpeakingFrame;
        if ("type" in frame && frame.type === "speaking") setSpeaking((prev) => ({ ...prev, [frame.track]: frame.text }));
        else setSnapshot(frame as Snapshot);
      };
      ws.onclose = () => {
        if (!stopped) timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { snapshot, speaking };
}
