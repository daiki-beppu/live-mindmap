// swift-tools-version: 6.0
import PackageDescription

let optimizeForScreenComparisonInTests: SwiftSetting = .unsafeFlags(["-O"], .when(configuration: .debug))

let webrtcAPM = "\(Context.packageDirectory)/.deps/webrtc-apm"
let webrtcAPMLibraries = [
    "libwebrtc-audio-processing-2", "libcommon_audio", "liblibbase", "liblibapi",
    "libsystem_wrappers", "liblibfft", "liblibpffft", "liblibrnnoise",
    "libabsl_base", "libabsl_container", "libabsl_crc", "libabsl_debugging", "libabsl_flags",
    "libabsl_hash", "libabsl_log", "libabsl_numeric", "libabsl_profiling", "libabsl_random",
    "libabsl_status", "libabsl_strings", "libabsl_synchronization", "libabsl_time", "libabsl_types",
].map { "\(webrtcAPM)/lib/\($0).a" }

let package = Package(
    name: "live-mindmap-helper",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "live-mindmap-helper", targets: ["live-mindmap-helper"]),
        .executable(name: "live-mindmap-apple", targets: ["live-mindmap-apple"]),
    ],
    dependencies: [
        // 版が変わると話者分離の結果が変わり得るので範囲にせず固定し、上げるときは speakerAccuracy を測る（#1838）。
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.6"),
    ],
    targets: [
        .target(
            name: "HelperCore",
            dependencies: ["CWebRTCAPM", .product(name: "FluidAudio", package: "FluidAudio")],
            swiftSettings: [optimizeForScreenComparisonInTests]
        ),
        .target(
            name: "CWebRTCAPM",
            cxxSettings: [
                .unsafeFlags([
                    "-std=c++17", "-DWEBRTC_POSIX", "-DWEBRTC_MAC", "-DWEBRTC_APM_DEBUG_DUMP=0",
                    "-I\(webrtcAPM)/src", "-I\(webrtcAPM)/src/webrtc", "-I\(webrtcAPM)/build", "-I\(webrtcAPM)/abseil",
                ]),
            ],
            linkerSettings: [.unsafeFlags(webrtcAPMLibraries)]
        ),
        .executableTarget(name: "live-mindmap-helper", dependencies: ["HelperCore"]),
        .target(name: "AppleIntelligenceCore"),
        .executableTarget(name: "live-mindmap-apple", dependencies: ["AppleIntelligenceCore"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore", "AppleIntelligenceCore"], exclude: ["Fixtures"]),
        .executableTarget(name: "stt-bench", dependencies: ["HelperCore"]),
        .testTarget(name: "SttBenchTests", dependencies: ["stt-bench", "HelperCore"]),
    ],
    swiftLanguageModes: [.v5]
)
