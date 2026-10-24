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
