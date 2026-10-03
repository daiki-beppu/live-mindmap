// ヘルパーへの WebSocket を開く。開いた直後に届いたメッセージを取りこぼさない。
// ws は、ハンドシェイクの応答と同じ塊で届いたフレームを、open の直後に process.nextTick で流す。
// open を await してから message を購読すると、その間（Promise の継続より先）に流れたフレームが消える。
// そこで接続を作った時点から受け取ってため、listen で購読した時点でためた分を先に渡す。
import { WebSocket, type RawData } from "ws";

export type HelperSocket = {
  ws: WebSocket;
  // 購読を始める。それまでにためたメッセージを、届いた順にこの場で渡してから、以後のメッセージを渡す
  listen: (listener: (data: RawData) => void) => void;
};

// 開けたら HelperSocket、開けなければ undefined（呼び出し側が作り直す）
export async function openHelperSocket(url: string): Promise<HelperSocket | undefined> {
  const ws = new WebSocket(url);
  const early: RawData[] = [];
  const buffer = (data: RawData) => early.push(data);
  ws.on("message", buffer);
  const opened = await new Promise<boolean>((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("error", () => resolve(false));
  });
  if (!opened) {
    ws.terminate();
    return undefined;
  }
  return {
    ws,
    listen(listener) {
      ws.off("message", buffer);
      for (const data of early.splice(0)) listener(data);
      ws.on("message", listener);
    },
  };
}
