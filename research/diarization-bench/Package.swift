// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "diarization-bench",
    platforms: [.macOS("15.0")],
    dependencies: [.package(url: "https://github.com/FluidInference/FluidAudio", revision: "ea63ac36fcadb8a6611d0f58a8e4a0e7dd4381e2")],
    targets: [
        .executableTarget(name: "bench", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
                          swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
