import { useEffect, useState } from "react";
import type { IntakeFrame, Snapshot, SpeakingFrame } from "../../server/src/core/index.ts";
import { applyFrame, applyOpen, createFeedState, type FeedState } from "./liveFeed.ts";

const RECONNECT_MS = 1000;

// /ws から届く frame を購読する WebSocket の糊（接続・再接続・購読だけを担う）。frame の分類・状態更新の規則は
// liveFeed.ts（React を使わない純粋なモジュール）に置く。切れたら 1 秒後につなぎ直し、切れている間も最後の
// スナップショットを持ち続ける。つなぎ直したときは applyOpen（字幕だけ空に戻す。取り込みの状態は保つ）を通す。
export function useLiveFeed(): FeedState {
  const [state, setState] = useState<FeedState>(createFeedState);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setState(applyOpen);
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as Snapshot | SpeakingFrame | IntakeFrame;
        setState((prev) => applyFrame(prev, frame));
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

  return state;
}
