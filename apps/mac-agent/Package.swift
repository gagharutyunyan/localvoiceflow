// swift-tools-version: 6.0
import PackageDescription

// The agent is deliberately dependency-free: everything it needs (CGEventTap, Carbon hot keys,
// AVAudioEngine, Accessibility) ships with macOS. `swift build -c release` produces a bare
// executable that scripts/build.sh copies into
// ~/Applications/LocalVoiceFlow.app/Contents/MacOS/ together with Resources/Info.plist.
//
// Swift 5 language mode: the CGEventTap and Carbon hot-key callbacks are C function pointers that
// deliver events synchronously on the main run loop. Expressing that through Swift 6 global-actor
// isolation would require `assumeIsolated` at every C boundary without changing the runtime
// behaviour, so the module stays on the v5 mode and hops to the main actor explicitly instead.
let package = Package(
    name: "LocalVoiceFlowAgent",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "LocalVoiceFlowAgent",
            path: "Sources/LocalVoiceFlowAgent",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "LocalVoiceFlowAgentTests",
            dependencies: ["LocalVoiceFlowAgent"],
            path: "Tests/LocalVoiceFlowAgentTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
