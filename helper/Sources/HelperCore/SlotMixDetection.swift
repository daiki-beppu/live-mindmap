import Foundation

public enum SlotMixCriteria {
    public static let minSegmentSeconds: Double = 2
    public static let maxSegmentSeconds: Double = 10
    public static let minSecondClusterSegments = 5
    public static let minSecondClusterShare: Double = 0.10
    public static let clusterCosineDistance: Float = 0.6
    public static let newVoiceMaxSimilarity: Float = 0.6
    public static let knownVoiceSimilarity: Float = 0.9
}

public struct SlotMixDetector {
    private var embeddings: [Int: [[Float]]] = [:]
    private var reported: Set<Int> = []
    public private(set) var centroids: [Int: [Float]] = [:]

    public init() {}

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
        if known.contains(where: { $0 >= SlotMixCriteria.knownVoiceSimilarity }) { return false }
        guard known.allSatisfy({ $0 < SlotMixCriteria.newVoiceMaxSimilarity }) else { return false }
        reported.insert(slot)
        embeddings[slot] = nil
        return true
    }

    private static func dot(_ a: [Float], _ b: [Float]) -> Float {
        zip(a, b).reduce(0) { $0 + $1.0 * $1.1 }
    }

    private static func normalized(_ v: [Float]) -> [Float]? {
        let norm = dot(v, v).squareRoot()
        guard norm > 0, norm.isFinite else { return nil }
        return v.map { $0 / norm }
    }

    private static func centroid(of vectors: [[Float]]) -> [Float]? {
        guard let first = vectors.first else { return nil }
        var sum = [Float](repeating: 0, count: first.count)
        for vector in vectors { for i in sum.indices { sum[i] += vector[i] } }
        return normalized(sum)
    }

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
