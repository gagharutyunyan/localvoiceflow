import AppKit
import ApplicationServices
import Foundation

/// Who was in front when the user started talking. Captured at capture *start* because by the time
/// the transcript comes back (2–4 s later) the user may well have switched windows.
public struct TargetAppSnapshot: Equatable, Sendable {
    public var pid: pid_t
    public var bundleId: String?
    public var localizedName: String?
    public var windowTitle: String?
    /// Monotonic time of the snapshot, for latency accounting.
    public var capturedAtUptime: Double
    public var capturedAt: Date

    public init(
        pid: pid_t,
        bundleId: String?,
        localizedName: String?,
        windowTitle: String? = nil,
        capturedAtUptime: Double,
        capturedAt: Date = Date()
    ) {
        self.pid = pid
        self.bundleId = bundleId
        self.localizedName = localizedName
        self.windowTitle = windowTitle
        self.capturedAtUptime = capturedAtUptime
        self.capturedAt = capturedAt
    }
}

/// Mirrors `TargetChangedBehaviorSchema` in packages/shared/src/settings.ts.
public enum TargetChangedBehavior: String, Codable, Sendable, Equatable {
    case pasteOnlyIfSameApp = "paste-only-if-same-app"
    case pasteIntoCurrentApp = "paste-into-current-app"
    case clipboardOnly = "clipboard-only"
}

/// What the inserter is allowed to do with the finished text.
public enum InsertionPlan: Equatable, Sendable {
    /// The original target is still frontmost — insert there.
    case insertIntoOriginalTarget
    /// A different app is frontmost and the user asked for the text anyway.
    case insertIntoCurrentApp
    /// Only put it on the clipboard and say so in the HUD.
    case clipboardOnly
}

public enum TargetApp {
    /// Snapshot the frontmost application. `includeWindowTitle` is off by default because the
    /// title can leak the content of a document to the LLM provider.
    public static func snapshotFrontmost(
        includeWindowTitle: Bool = false,
        atUptime uptime: Double = ProcessInfo.processInfo.systemUptime
    ) -> TargetAppSnapshot? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let title = includeWindowTitle && AXIsProcessTrusted() ? focusedWindowTitle(pid: app.processIdentifier) : nil
        return TargetAppSnapshot(
            pid: app.processIdentifier,
            bundleId: app.bundleIdentifier,
            localizedName: app.localizedName,
            windowTitle: title,
            capturedAtUptime: uptime
        )
    }

    public static func currentFrontmost() -> TargetAppSnapshot? {
        snapshotFrontmost(includeWindowTitle: false)
    }

    /// Pure decision: given the behaviour the user configured and who is in front now, what may we
    /// do with the text? Separated from AppKit so it is unit-testable.
    public static func plan(
        behavior: TargetChangedBehavior,
        target: TargetAppSnapshot?,
        current: TargetAppSnapshot?
    ) -> InsertionPlan {
        if behavior == .clipboardOnly { return .clipboardOnly }
        guard let target else {
            // We never knew where to type; only the clipboard is safe.
            return behavior == .pasteIntoCurrentApp && current != nil ? .insertIntoCurrentApp : .clipboardOnly
        }
        guard let current else { return .clipboardOnly }

        if isSameApp(target, current) { return .insertIntoOriginalTarget }

        switch behavior {
        case .pasteIntoCurrentApp: return .insertIntoCurrentApp
        case .pasteOnlyIfSameApp, .clipboardOnly: return .clipboardOnly
        }
    }

    /// Same pid is the strongest signal; a matching bundle id covers an app that respawned or a
    /// multi-process app (Chrome helpers) where the frontmost pid legitimately differs.
    public static func isSameApp(_ lhs: TargetAppSnapshot, _ rhs: TargetAppSnapshot) -> Bool {
        if lhs.pid == rhs.pid { return true }
        if let a = lhs.bundleId, let b = rhs.bundleId, !a.isEmpty { return a == b }
        return false
    }

    private static func focusedWindowTitle(pid: pid_t) -> String? {
        let appElement = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
              let windowRef
        else { return nil }

        // AXUIElementCopyAttributeValue hands back an untyped CFTypeRef; check the CF type id
        // before reinterpreting it rather than force-casting an arbitrary object.
        guard CFGetTypeID(windowRef) == AXUIElementGetTypeID() else { return nil }
        let window = unsafeBitCast(windowRef, to: AXUIElement.self)
        var titleRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef) == .success,
              let title = titleRef as? String, !title.isEmpty
        else { return nil }
        return String(title.prefix(500))
    }
}
