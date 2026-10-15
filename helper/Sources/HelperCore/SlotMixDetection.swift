import Foundation

/// 枠への混入を判定する基準値（Issue #1024）。合成会議 4 本（TTS）で選んだ仮の値。人の声では相手 4 人以下でも誤検出し得る。
/// 0.6 は、AHC の距離としての使い方（`clusterCosineDistance`）と、重心同士の類似度としての使い方（`newVoiceMaxSimilarity`）で意味が違うので別の定数にする。
public enum SlotMixCriteria {
    /// 埋め込みにする確定区間の最短（秒）。これ未満は使わない。
    public static let minSegmentSeconds: Double = 2
    /// 埋め込みにする区間の最長（秒）。超える区間は中央の分を使う。
    public static let maxSegmentSeconds: Double = 10
    /// 2 番目の塊の最少の区間数。
    public static let minSecondClusterSegments = 5
    /// 2 番目の塊が枠の区間数に占める最少の割合。
    public static let minSecondClusterShare: Double = 0.10
    /// 枠の中を分ける AHC の cosine 距離（平均結合）。これ以上離れた塊は混ぜない。
    public static let clusterCosineDistance: Float = 0.6
    /// 2 番目の塊の重心が、どの枠の主な塊とも、この cos 未満であること。
    public static let newVoiceMaxSimilarity: Float = 0.6
    /// 既知の声と、この cos 以上で一致する塊は、割り当て違いとみなして無視する。
    public static let knownVoiceSimilarity: Float = 0.9
}

/// 枠ごとの声の埋め込みを溜め、枠に別の声が混ざったかを判定する。FluidAudio に依存しない。
/// 枠の中の埋め込みを、cosine 距離の平均結合の AHC で塊に分ける。
public struct SlotMixDetector {
    private var embeddings: [Int: [[Float]]] = [:]
    private var reported: Set<Int> = []
    /// 枠ごとの主な塊（最大の塊）の重心（長さ 1）。混入を報告した枠は、その時点の値のまま動かさない。
    public private(set) var centroids: [Int: [Float]] = [:]

    public init() {}

    /// 枠 `slot` の確定区間 1 つ分の埋め込みを足す。この枠の混入を初めて判定したときだけ true（1 枠 1 回）。
    public mutating func add(slot: Int, embedding: [Float]) -> Bool {
        guard !reported.contains(slot), let unit = Self.normalized(embedding) else { return false }
        embeddings[slot, default: []].append(unit)
        let vectors = embeddings[slot] ?? []
        let clusters = Self.cluster(vectors, threshold: SlotMixCriteria.clusterCosineDistance)
        guard let main = clusters.first else { return false }
        let mainCentroid = Self.centroid(of: main.map { vectors[$0] })
        centroids[slot] = mainCentroid
        guard clusters.count >= 2 else { return false }

        let second = clusters[1]
        guard second.count >= SlotMixCriteria.minSecondClusterSegments,
              Double(second.count) / Double(vectors.count) >= SlotMixCriteria.minSecondClusterShare,
              let secondCentroid = Self.centroid(of: second.map { vectors[$0] })
        else { return false }

        let known = centroids.values.map { Self.dot($0, secondCentroid) }
        // 既知の声に当たる塊は、割り当て違いとして無視する。
        if known.contains(where: { $0 >= SlotMixCriteria.knownVoiceSimilarity }) { return false }
        guard known.allSatisfy({ $0 < SlotMixCriteria.newVoiceMaxSimilarity }) else { return false }
        reported.insert(slot)
        embeddings[slot] = nil
        return true
    }

    // MARK: 内部

    private static func dot(_ a: [Float], _ b: [Float]) -> Float {
        zip(a, b).reduce(0) { $0 + $1.0 * $1.1 }
    }

    private static func normalized(_ v: [Float]) -> [Float]? {
        let norm = dot(v, v).squareRoot()
        guard norm > 0, norm.isFinite else { return nil }
        return v.map { $0 / norm }
    }

    /// 長さ 1 のベクトルの平均を、長さ 1 にした重心。
    private static func centroid(of vectors: [[Float]]) -> [Float]? {
        guard let first = vectors.first else { return nil }
        var sum = [Float](repeating: 0, count: first.count)
        for vector in vectors { for i in sum.indices { sum[i] += vector[i] } }
        return normalized(sum)
    }

    /// cosine 距離（1 - cos）の平均結合の AHC。距離が `threshold` 未満の塊だけを併合し、塊を大きい順（同数なら先頭の要素の番号順）に返す。
    /// nearest-neighbor chain で O(n²)。平均結合は併合しても他の塊との距離が縮まらない（reducible）ので、
    /// 互いに最近傍の 2 つが `threshold` 以上離れていれば、その 2 つはもう併合されない。
    static func cluster(_ vectors: [[Float]], threshold: Float) -> [[Int]] {
        let n = vectors.count
        guard n > 1 else { return n == 1 ? [[0]] : [] }
        var distance = [Float](repeating: 0, count: n * n)
        for i in 0..<n {
            for j in (i + 1)..<n {
                let d = 1 - dot(vectors[i], vectors[j])
                distance[i * n + j] = d
                distance[j * n + i] = d
            }
        }
        var members = (0..<n).map { [$0] }
        var active = [Bool](repeating: true, count: n)
        var done: [[Int]] = []
        var chain: [Int] = []
        var remaining = n

        while remaining > 0 {
            if chain.isEmpty { chain.append(active.firstIndex(of: true)!) }
            let a = chain[chain.count - 1]
            let previous = chain.count >= 2 ? chain[chain.count - 2] : nil
            var best: Int?
            for j in 0..<n where active[j] && j != a {
                if best == nil || distance[a * n + j] < distance[a * n + best!] { best = j }
            }
            guard var nearest = best else {
                done.append(members[a])
                active[a] = false
                remaining -= 1
                chain.removeAll()
                continue
            }
            // 同じ距離なら前の要素を選び、ループを避ける。
            if let previous, distance[a * n + previous] <= distance[a * n + nearest] { nearest = previous }
            guard nearest == previous else {
                chain.append(nearest)
                continue
            }
            let b = nearest
            chain.removeLast(2)
            if distance[a * n + b] < threshold {
                let sizeA = Float(members[a].count)
                let sizeB = Float(members[b].count)
                for k in 0..<n where active[k] && k != a && k != b {
                    let merged = (sizeA * distance[a * n + k] + sizeB * distance[b * n + k]) / (sizeA + sizeB)
                    distance[a * n + k] = merged
                    distance[k * n + a] = merged
                }
                members[a] += members[b]
                active[b] = false
                remaining -= 1
            } else {
                done.append(members[a])
                done.append(members[b])
                active[a] = false
                active[b] = false
                remaining -= 2
            }
        }
        return done
            .map { $0.sorted() }
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0[0] < $1[0] }
    }
}
