import AppKit
import Foundation

// LSUIElement in Resources/Info.plist keeps the bundled app out of the Dock; setting the policy
// here as well makes `swift run` behave identically during development.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)

// Top-level code runs on the main thread; `assumeIsolated` states that fact for the compiler
// instead of hiding it behind an async hop that would run after `NSApplication.run()`.
let delegate = MainActor.assumeIsolated { AppDelegate() }
application.delegate = delegate

if let level = ProcessInfo.processInfo.environment["LVF_LOG_LEVEL"] {
    switch level.lowercased() {
    case "debug": AgentLog.minimumLevel = .debug
    case "warn": AgentLog.minimumLevel = .warn
    case "error": AgentLog.minimumLevel = .error
    default: AgentLog.minimumLevel = .info
    }
}

application.run()
