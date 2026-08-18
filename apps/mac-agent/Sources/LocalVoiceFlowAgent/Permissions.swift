import AVFoundation
import AppKit
import ApplicationServices
import Foundation
import IOKit.hid

/// Mirrors `PermissionStateSchema` in packages/shared/src/events.ts.
public enum PermissionState: String, Codable, Sendable, Equatable {
    case granted
    case denied
    case unknown
    case notDetermined = "not-determined"

    public var isUsable: Bool { self == .granted }

    public var localizedLabel: String {
        switch self {
        case .granted: return "разрешено"
        case .denied: return "запрещено"
        case .notDetermined: return "не запрошено"
        case .unknown: return "неизвестно"
        }
    }
}

public struct PermissionSnapshot: Equatable, Sendable {
    public var microphone: PermissionState
    public var accessibility: PermissionState
    public var inputMonitoring: PermissionState

    public var allGranted: Bool {
        microphone == .granted && accessibility == .granted && inputMonitoring == .granted
    }

    /// The permissions without which dictation cannot work at all, as TCC reports them. Callers
    /// that can observe the event tap directly should prefer ``MenuStatus/missingPermissions``.
    public var missingCritical: [String] {
        var missing: [String] = []
        if microphone != .granted { missing.append("Микрофон") }
        if inputMonitoring != .granted { missing.append("Мониторинг ввода") }
        return missing
    }
}

/// TCC queries and the System Settings deep links that go with them.
///
/// macOS has no API to *revoke* or *grant* anything; the app can only ask and then send the user
/// to the right pane. Every query here is cheap enough to poll.
public enum Permissions {
    // MARK: - Query

    public static func microphone() -> PermissionState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown
        }
    }

    /// Accessibility is a binary trust flag: macOS never reports "not determined" for it, so an
    /// untrusted process is reported as `denied` and the UI offers the Settings link.
    public static func accessibility() -> PermissionState {
        AXIsProcessTrusted() ? .granted : .denied
    }

    /// Input Monitoring gates `CGEventTap` on key events. `IOHIDCheckAccess` is the only API that
    /// answers without side effects — creating a tap to "test" it would itself trigger the prompt.
    public static func inputMonitoring() -> PermissionState {
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted: return .granted
        case kIOHIDAccessTypeDenied: return .denied
        case kIOHIDAccessTypeUnknown: return .notDetermined
        default: return .unknown
        }
    }

    public static func snapshot() -> PermissionSnapshot {
        PermissionSnapshot(
            microphone: microphone(),
            accessibility: accessibility(),
            inputMonitoring: inputMonitoring()
        )
    }

    // MARK: - Request

    /// True when the running image carries `NSMicrophoneUsageDescription`. macOS *terminates* a
    /// process that asks for the microphone without one, which is exactly what happens to a bare
    /// `swift run` binary, so the request is skipped unless the app is properly bundled.
    public static var hasMicrophoneUsageDescription: Bool {
        let value = Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String
        return !(value ?? "").isEmpty
    }

    public static func requestMicrophone(_ completion: @escaping @Sendable (PermissionState) -> Void) {
        let current = microphone()
        guard current == .notDetermined else {
            completion(current)
            return
        }
        guard hasMicrophoneUsageDescription else {
            AgentLog.warn("skipping microphone prompt: run the bundled app, not the bare executable")
            completion(.notDetermined)
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            completion(granted ? .granted : .denied)
        }
    }

    /// Shows the system "allow Accessibility" prompt when the process is not trusted yet.
    @discardableResult
    public static func requestAccessibility(prompt: Bool = true) -> PermissionState {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options = [key: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options) ? .granted : .denied
    }

    /// Triggers the Input Monitoring prompt once. Returns the resulting state; on a second call
    /// macOS silently refuses instead of prompting again, which is why the menu also offers the
    /// direct link to the settings pane.
    @discardableResult
    public static func requestInputMonitoring() -> PermissionState {
        let current = inputMonitoring()
        guard current != .granted else { return .granted }
        return IOHIDRequestAccess(kIOHIDRequestTypeListenEvent) ? .granted : inputMonitoring()
    }

    // MARK: - System Settings deep links

    public enum SettingsPane: String {
        case microphone = "Privacy_Microphone"
        case accessibility = "Privacy_Accessibility"
        case inputMonitoring = "Privacy_ListenEvent"
    }

    /// Opens the exact privacy pane the user needs.
    ///
    /// System Settings replaced System Preferences in Ventura and renamed the target: the old
    /// `com.apple.preference.security` identifier still opens *something* on current macOS, but
    /// not reliably the requested section. The extension identifier is the one that lands on the
    /// right list with the app's row visible, which is the whole point — a user who has to hunt
    /// for the row is a user who ends up dragging the app in from Finder.
    public static func openSettings(_ pane: SettingsPane) {
        let candidates = [
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?\(pane.rawValue)",
            "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)",
        ]
        for candidate in candidates {
            guard let url = URL(string: candidate) else { continue }
            if NSWorkspace.shared.open(url) { return }
        }
        AgentLog.warn("could not open the \(pane.rawValue) settings pane")
    }
}
