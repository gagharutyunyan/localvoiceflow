import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

/// How the text actually reached the user.
public enum InsertionMethod: Equatable, Sendable {
    case accessibility
    case paste
    case clipboardOnly
}

public struct InsertionOutcome: Equatable, Sendable {
    public var method: InsertionMethod
    /// Short, user-facing line for the HUD. Never contains the dictated text.
    public var message: String
    /// Non-fatal reason the fast path was not taken, for the log and the dashboard.
    public var note: String?
}

public struct InsertionOptions: Sendable {
    public var behavior: TargetChangedBehavior
    public var restoreClipboard: Bool
    public var clipboardRestoreDelayMs: Int
    /// Set when the process is not trusted for Accessibility: no AX writes, no synthetic ⌘V.
    public var accessibilityGranted: Bool

    public init(
        behavior: TargetChangedBehavior = .pasteOnlyIfSameApp,
        restoreClipboard: Bool = true,
        clipboardRestoreDelayMs: Int = 600,
        accessibilityGranted: Bool = false
    ) {
        self.behavior = behavior
        self.restoreClipboard = restoreClipboard
        self.clipboardRestoreDelayMs = clipboardRestoreDelayMs
        self.accessibilityGranted = accessibilityGranted
    }
}

/// Pure, side-effect-free rules used by ``TextInserter``. Kept separate so the tricky decisions
/// are unit-testable without a focused text field, a real clipboard or Accessibility permission.
public enum InsertionPolicy {
    /// Restore the clipboard only when the value we wrote is still the value on the pasteboard.
    ///
    /// `NSPasteboard.changeCount` increments on every write by any process. If it moved past the
    /// number our own write produced, some other app (or the user) put something there afterwards
    /// and restoring would silently destroy their data.
    public static func shouldRestoreClipboard(
        changeCountAtWrite: Int,
        currentChangeCount: Int,
        userSettingEnabled: Bool
    ) -> Bool {
        guard userSettingEnabled else { return false }
        return currentChangeCount == changeCountAtWrite
    }

    /// Final say on what may happen, folding in the two hard blocks: secure input and a missing
    /// Accessibility grant. Both degrade to clipboard-only rather than failing.
    public static func resolvePlan(
        requested: InsertionPlan,
        secureInputActive: Bool,
        accessibilityGranted: Bool
    ) -> InsertionPlan {
        if secureInputActive { return .clipboardOnly }
        if !accessibilityGranted { return .clipboardOnly }
        return requested
    }

    /// An AX role/subrole pair we are willing to write into.
    public static func isWritableTextRole(role: String?, subrole: String?) -> Bool {
        if subrole == (kAXSecureTextFieldSubrole as String) { return false }
        guard let role else { return false }
        return role == (kAXTextFieldRole as String)
            || role == (kAXTextAreaRole as String)
            || role == (kAXComboBoxRole as String)
    }

    /// Applications where an Accessibility write reaches the wrong place.
    ///
    /// A terminal emulator exposes its screen as an `AXTextArea`, but the screen is *output*: the
    /// characters the program reads come from the pty, not from the AX model. Writing there is
    /// accepted by the widget and then lost on the next redraw, or leaves the emulator's input
    /// state out of sync — the text shows up but Return does nothing. JetBrains IDEs are the same
    /// story for their whole window: the Swing accessibility bridge reports writable text areas
    /// (editor, terminal) that do not feed the real document model.
    ///
    /// For these, clipboard + ⌘V is the only path that behaves like the user typing: the emulator
    /// turns it into a bracketed paste and the program on the other end of the pty actually sees it.
    public static func prefersPasteOverAccessibility(bundleId: String?) -> Bool {
        guard let bundleId, !bundleId.isEmpty else { return false }
        let id = bundleId.lowercased()

        // Every JetBrains IDE (WebStorm, IntelliJ, PyCharm, …) and Android Studio: Swing AX.
        if id.hasPrefix("com.jetbrains.") || id.hasPrefix("com.google.android.studio") { return true }

        return pasteOnlyBundleIds.contains(id)
    }

    /// Terminal emulators and editors whose embedded terminal shares the app's bundle id.
    private static let pasteOnlyBundleIds: Set<String> = [
        "com.apple.terminal",
        "com.googlecode.iterm2",
        "dev.warp.warp-stable",
        "dev.warp.warp",
        "com.github.wez.wezterm",
        "net.kovidgoyal.kitty",
        "io.alacritty",
        "org.alacritty",
        "com.mitchellh.ghostty",
        "co.zeit.hyper",
        "org.tabby",
        "com.microsoft.vscode",
        "com.microsoft.vscodeinsiders",
        "com.visualstudio.code.oss",
        "com.todesktop.230313mzl4w4u92", // Cursor
        "com.exafunction.windsurf",
        "dev.zed.zed",
        "dev.zed.zed-preview",
    ]

    /// Last line of defence for terminals inside applications we do not know by bundle id: the
    /// focused element describes itself as a terminal or a console.
    public static func looksLikeTerminal(roleDescription: String?, description: String?, identifier: String?) -> Bool {
        for value in [roleDescription, description, identifier] {
            guard let value = value?.lowercased(), !value.isEmpty else { continue }
            if value.contains("terminal") || value.contains("console") || value.contains("shell") {
                return true
            }
        }
        return false
    }
}

/// Puts the finished text where the user was typing.
///
/// Order of preference: a real Accessibility insertion at the caret (no clipboard involved at all),
/// then clipboard + synthetic ⌘V, then clipboard only.
public final class TextInserter {
    private let pasteboard: NSPasteboard

    public init(pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
    }

    public func insert(
        text: String,
        target: TargetAppSnapshot?,
        options: InsertionOptions
    ) -> InsertionOutcome {
        guard !text.isEmpty else {
            return InsertionOutcome(method: .clipboardOnly, message: "Пустой результат", note: "empty-text")
        }

        let current = TargetApp.currentFrontmost()
        let requested = TargetApp.plan(behavior: options.behavior, target: target, current: current)
        let secureInput = Self.isSecureInputActive()
        let plan = InsertionPolicy.resolvePlan(
            requested: requested,
            secureInputActive: secureInput,
            accessibilityGranted: options.accessibilityGranted
        )

        if plan == .clipboardOnly {
            copyOnly(text)
            let message: String
            let note: String?
            if secureInput {
                message = "Скопировано (защищённый ввод)"
                note = "secure-input-active"
            } else if !options.accessibilityGranted {
                message = "Скопировано (нет доступа к Универсальному доступу)"
                note = "accessibility-denied"
            } else if requested == .clipboardOnly && options.behavior != .clipboardOnly {
                message = "Скопировано (приложение сменилось)"
                note = "target-changed"
            } else {
                message = "Скопировано в буфер обмена"
                note = nil
            }
            return InsertionOutcome(method: .clipboardOnly, message: message, note: note)
        }

        if plan == .insertIntoOriginalTarget || plan == .insertIntoCurrentApp {
            // ⌘V goes to whoever holds the keyboard focus right now, so the app that decides how
            // the text must be delivered is the frontmost one, not the one we recorded against.
            let destination = current?.bundleId ?? target?.bundleId
            if InsertionPolicy.prefersPasteOverAccessibility(bundleId: destination) {
                pasteViaClipboard(text: text, options: options)
                return InsertionOutcome(method: .paste, message: "Вставлено", note: "ax-unreliable-app")
            }

            switch insertViaAccessibility(text: text) {
            case .inserted:
                return InsertionOutcome(method: .accessibility, message: "Вставлено", note: nil)
            case .secureField:
                copyOnly(text)
                return InsertionOutcome(
                    method: .clipboardOnly,
                    message: "Скопировано (защищённое поле)",
                    note: "secure-text-field"
                )
            case .unsupported(let reason):
                pasteViaClipboard(text: text, options: options)
                return InsertionOutcome(method: .paste, message: "Вставлено", note: reason)
            }
        }

        copyOnly(text)
        return InsertionOutcome(method: .clipboardOnly, message: "Скопировано в буфер обмена", note: nil)
    }

    // MARK: - Accessibility path

    private enum AXInsertResult {
        case inserted
        case secureField
        case unsupported(String)
    }

    private func insertViaAccessibility(text: String) -> AXInsertResult {
        let systemWide = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focusedRef,
              CFGetTypeID(focusedRef) == AXUIElementGetTypeID()
        else {
            return .unsupported("no-focused-element")
        }
        let element = unsafeBitCast(focusedRef, to: AXUIElement.self)

        let role = copyStringAttribute(element, kAXRoleAttribute as CFString)
        let subrole = copyStringAttribute(element, kAXSubroleAttribute as CFString)

        if subrole == (kAXSecureTextFieldSubrole as String) { return .secureField }
        guard InsertionPolicy.isWritableTextRole(role: role, subrole: subrole) else {
            return .unsupported("role-not-writable")
        }

        // A terminal inside an app we do not know by bundle id still reports a writable text area.
        if InsertionPolicy.looksLikeTerminal(
            roleDescription: copyStringAttribute(element, kAXRoleDescriptionAttribute as CFString),
            description: copyStringAttribute(element, kAXDescriptionAttribute as CFString),
            identifier: copyStringAttribute(element, kAXIdentifierAttribute as CFString)
        ) {
            return .unsupported("terminal-like-element")
        }

        // Preferred: replace the selection, which is exactly "type here" semantics and leaves the
        // rest of the field (and undo) alone.
        var selectedSettable: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &selectedSettable) == .success,
           selectedSettable.boolValue,
           AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success {
            return .inserted
        }

        // Fallback: splice into the whole value at the caret. Only attempted when both the value
        // and the selected range are readable, otherwise we would clobber the field.
        var valueSettable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable) == .success,
              valueSettable.boolValue,
              let currentValue = copyStringAttribute(element, kAXValueAttribute as CFString),
              let range = copySelectedRange(element)
        else {
            return .unsupported("value-not-settable")
        }

        let ns = currentValue as NSString
        guard range.location != NSNotFound, range.location + range.length <= ns.length else {
            return .unsupported("selection-out-of-range")
        }
        let updated = ns.replacingCharacters(in: range, with: text)
        guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, updated as CFTypeRef) == .success else {
            return .unsupported("value-write-failed")
        }

        var caret = CFRange(location: range.location + (text as NSString).length, length: 0)
        if let axRange = AXValueCreate(.cfRange, &caret) {
            AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
        }
        return .inserted
    }

    private func copyStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &ref) == .success else { return nil }
        return ref as? String
    }

    private func copySelectedRange(_ element: AXUIElement) -> NSRange? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &ref) == .success,
              let ref,
              CFGetTypeID(ref) == AXValueGetTypeID()
        else { return nil }
        let axValue = unsafeBitCast(ref, to: AXValue.self)
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(axValue, .cfRange, &range) else { return nil }
        return NSRange(location: range.location, length: range.length)
    }

    // MARK: - Clipboard path

    private struct PasteboardSnapshot {
        var items: [[String: Data]]
    }

    private func snapshotPasteboard() -> PasteboardSnapshot {
        var items: [[String: Data]] = []
        for item in pasteboard.pasteboardItems ?? [] {
            var stored: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { stored[type.rawValue] = data }
            }
            if !stored.isEmpty { items.append(stored) }
        }
        return PasteboardSnapshot(items: items)
    }

    private func restore(_ snapshot: PasteboardSnapshot) {
        pasteboard.clearContents()
        guard !snapshot.items.isEmpty else { return }
        let items: [NSPasteboardItem] = snapshot.items.map { stored in
            let item = NSPasteboardItem()
            for (type, data) in stored {
                item.setData(data, forType: NSPasteboard.PasteboardType(type))
            }
            return item
        }
        pasteboard.writeObjects(items)
    }

    private func copyOnly(_ text: String) {
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    /// Milliseconds between writing the pasteboard and the ⌘V that reads it. Java and Electron
    /// apps pick the pasteboard up through a bridge that lags a frame behind the write.
    private static let pasteboardSettleMs: UInt32 = 40
    /// Milliseconds between the individual synthetic key events.
    private static let keyEventGapMs: UInt32 = 8

    private func pasteViaClipboard(text: String, options: InsertionOptions) {
        let previous = options.restoreClipboard ? snapshotPasteboard() : nil
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        let changeCountAtWrite = pasteboard.changeCount

        postCommandV()

        guard let previous, options.restoreClipboard else { return }
        // The keystroke itself is posted asynchronously, so the restore has to clear both that
        // sequence and the target app's own paste handling before it puts the old value back.
        let keystrokeMs = Double(Self.pasteboardSettleMs + 3 * Self.keyEventGapMs)
        let delay = (keystrokeMs + Double(max(50, options.clipboardRestoreDelayMs))) / 1000
        let board = pasteboard
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            let allowed = InsertionPolicy.shouldRestoreClipboard(
                changeCountAtWrite: changeCountAtWrite,
                currentChangeCount: board.changeCount,
                userSettingEnabled: options.restoreClipboard
            )
            guard allowed else {
                AgentLog.debug("clipboard restore skipped: pasteboard changed by another process")
                return
            }
            self.restore(previous)
        }
    }

    /// Synthesises ⌘V. Requires Accessibility; the caller has already checked that.
    ///
    /// Three details matter for apps that are not plain Cocoa:
    ///
    /// * `.privateState` — a `.combinedSessionState` source merges the modifiers the user is
    ///   physically holding into our event, so a still-pressed push-to-talk ⌃⌥ turns ⌘V into
    ///   ⌃⌥⌘V and nothing pastes.
    /// * The ⌘ press is posted as its own `flagsChanged` event. Swing (JetBrains) and Chromium
    ///   track modifier state from those events rather than from the flags on the key event, and
    ///   without it they see a bare "v" and type the letter into the terminal.
    /// * `.cghidEventTap` with small gaps — the events enter at the same point real hardware does,
    ///   which is what non-native key handling expects.
    private func postCommandV() {
        DispatchQueue.global(qos: .userInitiated).async {
            let source = CGEventSource(stateID: .privateState)
            // Suppress our own synthetic keystrokes from re-entering local key handling.
            source?.setLocalEventsFilterDuringSuppressionState(
                [.permitLocalMouseEvents, .permitSystemDefinedEvents],
                state: .eventSuppressionStateSuppressionInterval
            )
            let vKey = CGKeyCode(kVK_ANSI_V)
            let commandKey = CGKeyCode(kVK_Command)
            guard let commandDown = CGEvent(keyboardEventSource: source, virtualKey: commandKey, keyDown: true),
                  let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false),
                  let commandUp = CGEvent(keyboardEventSource: source, virtualKey: commandKey, keyDown: false)
            else {
                AgentLog.error("failed to create ⌘V events")
                return
            }
            commandDown.type = .flagsChanged
            commandDown.flags = .maskCommand
            down.flags = .maskCommand
            up.flags = .maskCommand
            commandUp.type = .flagsChanged
            commandUp.flags = []

            usleep(Self.pasteboardSettleMs * 1000)
            for event in [commandDown, down, up, commandUp] {
                event.post(tap: .cghidEventTap)
                usleep(Self.keyEventGapMs * 1000)
            }
        }
    }

    // MARK: - Secure input

    /// True when any process has enabled secure event input (password fields, Terminal's secure
    /// keyboard entry, some VPN clients). Synthetic key events are dropped in that state, and
    /// pasting into a password field is exactly what the user does not want.
    public static func isSecureInputActive() -> Bool {
        IsSecureEventInputEnabled()
    }
}
