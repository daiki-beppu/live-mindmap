// 録画（cli recorded --self）の 2 トラック（相手・自分）の発言を、トラックをまたいで時刻（end）の順の 1 本にまとめる規則。
// 入力は、トラックごとに end の順に届く列。どのトラックも、次に届く要素の end は、これまでに届いた要素の end 以上。
// どちらのトラックにも溜まった要素があるあいだ、end が小さいほうの先頭を出す（同じ end は先に届いたほう）。
// 固定の待ち時間は持たない。片方が黙っている間は、そのトラックの次の要素が届くか drain（終わり）まで、もう一方を溜める。
// 時計も壁時計も使わない純粋な段（ADR 0003）。

type Queued<T> = { item: T; arrival: number };

export type TrackMerge<T> = {
  /** 要素を 1 つ受け取り、出せるようになった要素を end の順に返す。 */
  offer(item: T): T[];
  /** 溜まっている要素を、すべて end の順に返す。以後は空。 */
  drain(): T[];
};

export function createTrackMerge<T, Track extends string = string>(options: {
  tracks: readonly Track[];
  trackOf: (item: T) => Track;
  timeOf: (item: T) => number;
}): TrackMerge<T> {
  const { tracks, trackOf, timeOf } = options;
  const queues = new Map<Track, Queued<T>[]>(tracks.map((track) => [track, []]));
  let arrivals = 0;

  const earliest = (candidates: readonly (readonly Queued<T>[])[]): Queued<T> | undefined => {
    let best: { queue: readonly Queued<T>[]; head: Queued<T> } | undefined;
    for (const queue of candidates) {
      const head = queue[0];
      if (head === undefined) continue;
      if (best === undefined || timeOf(head.item) < timeOf(best.head.item) || (timeOf(head.item) === timeOf(best.head.item) && head.arrival < best.head.arrival)) {
        best = { queue, head };
      }
    }
    return best?.head;
  };

  const pop = (head: Queued<T>): T => {
    for (const queue of queues.values()) {
      if (queue[0] === head) {
        queue.shift();
        break;
      }
    }
    return head.item;
  };

  return {
    offer(item) {
      const queue = queues.get(trackOf(item));
      if (queue === undefined) throw new Error(`トラックが一覧にない: ${trackOf(item)}`);
      queue.push({ item, arrival: arrivals++ });
      const out: T[] = [];
      while ([...queues.values()].every((q) => q.length > 0)) {
        const head = earliest([...queues.values()]);
        if (head === undefined) break;
        out.push(pop(head));
      }
      return out;
    },
    drain() {
      const out: T[] = [];
      for (let head = earliest([...queues.values()]); head !== undefined; head = earliest([...queues.values()])) out.push(pop(head));
      return out;
    },
  };
}
