// マップ全体のスナップショットをブラウザへ送る。差分は送らない（ブラウザは受け取ったものを描くだけ）。
// つないだクライアントには、その時点の最新をすぐ送る。つなぎ直しても最新に追いつく。
// 最後に送った値は Ref に持ち、新しい値は PubSub へ流す。接続ごとに Fiber を 1 本立て、
// 先に購読してから保持している値を送る（逆にすると、保持値を送っている間に来た値を取りこぼす）。切れたら Fiber ごと終わる。
import { Array as Arr, Context, Effect, FiberSet, Layer, PubSub, Ref } from "effect";
import { Socket } from "effect/socket";
import type { DiffUpdateFrame, IntakeFrame, ScreenNoticeFrame, Snapshot, SpeakingFrame, Track } from "./core/index.ts";

// 配信の終わり。これを受け取った接続は、先に届いていたフレームを書いてから終わる（drained が使う）
const FEED_END = Symbol("live-mindmap/server/Viewers/end");
type Feed = string | typeof FEED_END;

// 保持している最後の値。送る形（JSON 文字列）のまま持ち、接続ごとに組み立て直さない
type Retained = {
  readonly diffUpdate: string | undefined;
  readonly snapshot: string | undefined;
  // いま話している文字は、トラックごとに最後に送った値だけを持ち、空でなければ、つないだ直後に送り直す
  // （スナップショットには入れない）。Map の並びは最初に送った順で、送り直す順もこれに従う
  readonly speaking: ReadonlyMap<Track, string>;
  // 取り込みの状態（途切れている／止まった／動いている／セッションが終わった）。最後に送った状態は status に
  // 関わらず保持し、後から接続した（再接続を含む）クライアントにも今の状態が届く（CT-LATE-JOIN）。
  // 「今の取り込み状態」の正本はサーバーにあり、途中から・再接続で繋いだブラウザが実フレームを受け取るまで
  // 状態を知らない空白を作らない（ブラウザ側が frame の無さを「running」として代用する二重所有をやめる。Issue #161 U-A）。
  // none も保持対象に含める理由: 切断中にセッションが終わった場合、再接続したブラウザへ none を届けないと、
  // 途切れ・止まったの一言が無期限に残ってしまう（Issue #161 U-G）。none は途切れ・止まったの文を出さない値なので、
  // 新規接続へ送っても CT-NOTICE-CLEAR は破れない（web/src/intake.ts の遷移規則で確認済み）
  readonly intake: string | undefined;
  // 共有画面を使っていないことの一文。届いてから約 10 秒の間だけ保持し、消すフレーム（text が null）で保持も消す。
  // 期限後につないだクライアントには送らない（Issue #280）
  readonly screenNotice: string | undefined;
};

const NOTHING_RETAINED: Retained = { snapshot: undefined, speaking: new Map(), intake: undefined, screenNotice: undefined, diffUpdate: undefined };

const retainedFrames = (retained: Retained): string[] => [
  ...(retained.snapshot === undefined ? [] : [retained.snapshot]),
  ...retained.speaking.values(),
  ...(retained.intake === undefined ? [] : [retained.intake]),
  ...(retained.screenNotice === undefined ? [] : [retained.screenNotice]),
  ...(retained.diffUpdate === undefined ? [] : [retained.diffUpdate]),
];

export class Viewers extends Context.Service<Viewers, {
  publish: (snapshot: Snapshot) => Effect.Effect<void>;
  // いま話している文字を、つないでいるクライアントへ送る。空の文字は送るが保持しない（つなぎ直したときに送り返さない）
  speak: (frame: SpeakingFrame) => Effect.Effect<void>;
  intake: (frame: IntakeFrame) => Effect.Effect<void>;
  diffUpdate: (frame: DiffUpdateFrame) => Effect.Effect<void>;
  // 共有画面を使っていないことの一文を送る。text が null なら一文を消し、保持も消す（消した後につないだクライアントには送らない）
  screenNotice: (frame: ScreenNoticeFrame) => Effect.Effect<void>;
  // 1 つのクライアントへ配信し続ける。切れるか、配信が終わるまで終わらない
  connect: (socket: Socket.Socket) => Effect.Effect<void, Socket.SocketError>;
  // 配信を終える。ここまでに publish したフレームを、接続中のクライアントへ渡し切ってから戻る。
  // 待受けを閉じる前に呼ぶので、終了の直前のフレーム（再生の最後のスナップショット・stop の none）が落ちない
  drained: Effect.Effect<void>;
}>()("live-mindmap/server/Viewers") {
  static readonly layer: Layer.Layer<Viewers> = Layer.effect(Viewers)(Effect.gen(function* () {
    const retained = yield* Ref.make(NOTHING_RETAINED);
    // 溢れない PubSub にする。差分更新やヘルパーからの通知は、受け取りの遅いブラウザを待たずに進む
    const updates = yield* PubSub.unbounded<Feed>();
    // 接続ごとの配信 Fiber。drained が、全部の Fiber が書き終えて終わるのを待つ
    const connections = yield* FiberSet.make();

    const send = Effect.fnUntraced(function* (data: string, retain: (current: Retained) => Retained) {
      yield* Ref.update(retained, retain);
      yield* PubSub.publish(updates, data);
    });

    const publish = (snapshot: Snapshot) => {
      const data = JSON.stringify(snapshot);
      return send(data, (current) => ({ ...current, snapshot: data }));
    };

    const speak = (frame: SpeakingFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => {
        const speaking = new Map(current.speaking);
        if (frame.text === "") speaking.delete(frame.track);
        else speaking.set(frame.track, data);
        return { ...current, speaking };
      });
    };

    const intake = (frame: IntakeFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, intake: data }));
    };
    const diffUpdate = (frame: DiffUpdateFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, diffUpdate: data }));
    };

    const screenNotice = (frame: ScreenNoticeFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, screenNotice: frame.text === null ? undefined : data }));
    };

    // 届いた分をまとめて書き、配信の終わりを受け取ったらそこで終わる
    const deliver = Effect.fnUntraced(function* (subscription: PubSub.Subscription<Feed>, writer: Socket.Writer) {
      for (;;) {
        const taken = yield* PubSub.takeAll(subscription);
        const frames = taken.filter((frame): frame is string => frame !== FEED_END);
        if (Arr.isArrayNonEmpty(frames)) yield* writer.writeAll(frames);
        if (frames.length < taken.length) return;
      }
    });

    const connect = Effect.fnUntraced(function* (socket: Socket.Socket) {
      // reader を取るところで upgrade が確定する。ブラウザ向けの配信は送信だけなので、
      // pull の値は使わず、切断（pull の失敗）を知るためだけに読む
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const subscription = yield* PubSub.subscribe(updates);
      // 購読できてから数える。ここより前で止まった接続には、渡し切るフレームがない
      yield* Effect.withFiber((fiber) => FiberSet.add(connections, fiber));
      for (const data of retainedFrames(yield* Ref.get(retained))) yield* writer.write(data);
      return yield* Effect.raceFirst(deliver(subscription, writer), Effect.forever(reader.pull));
    }, Effect.scoped);

    const drained = Effect.andThen(PubSub.end(updates, FEED_END), FiberSet.awaitEmpty(connections));

    return Viewers.of({ publish, speak, intake, diffUpdate, screenNotice, connect, drained });
  }));
}
