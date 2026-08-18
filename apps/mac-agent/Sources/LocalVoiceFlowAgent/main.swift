import AppKit
import Foundation

// Uninstalling has to be able to undo the Login Items registration, and only the app itself can:
// `SMAppService` has no command-line equivalent. Handled before anything else starts up, so the
// process does its one job and exits without touching audio, hotkeys or core.
if CommandLine.arguments.contains("--unregister-login-item") {
    let removed = LoginItem.setEnabled(false)
    exit(removed ? 0 : 1)
}

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
