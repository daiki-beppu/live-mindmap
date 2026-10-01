import { useEffect, useState } from "react";
import type { Snapshot } from "../../server/src/core/index.ts";

const RECONNECT_MS = 1000;

// /ws から届くスナップショットを購読する。切れたら 1 秒後につなぎ直し、切れている間も最後のものを持ち続ける。
export function useSnapshot(): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onmessage = (e) => setSnapshot(JSON.parse(String(e.data)) as Snapshot);
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

  return snapshot;
}
