import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// A parsed fallback shortcut, e.g. "control+option+space".
public struct HotkeySpec: Equatable, Sendable {
    public var keyCode: UInt32
    public var carbonModifiers: UInt32
    public var display: String

    /// Parses the human-readable form stored in settings. Returns nil for anything unrecognised
    /// so a typo in settings degrades to "no fallback hotkey" instead of registering a wrong one.
    public static func parse(_ raw: String) -> HotkeySpec? {
        let parts = raw.lowercased()
            .split(whereSeparator: { $0 == "+" || $0 == "-" || $0 == " " })
            .map(String.init)
        guard !parts.isEmpty else { return nil }

        var modifiers: UInt32 = 0
        var keyName: String?
        var displayParts: [String] = []

        for part in parts {
            switch part {
            case "control", "ctrl", "^":
                modifiers |= UInt32(controlKey); displayParts.append("⌃")
            case "option", "alt", "opt":
                modifiers |= UInt32(optionKey); displayParts.append("⌥")
            case "shift":
                modifiers |= UInt32(shiftKey); displayParts.append("⇧")
            case "command", "cmd":
                modifiers |= UInt32(cmdKey); displayParts.append("⌘")
            default:
                keyName = part
            }
        }

        guard let keyName, let keyCode = virtualKeyCode(for: keyName), modifiers != 0 else { return nil }
        displayParts.append(keyName.count == 1 ? keyName.uppercased() : keyName.capitalized)
        return HotkeySpec(keyCode: keyCode, carbonModifiers: modifiers, display: displayParts.joined())
    }

    private static func virtualKeyCode(for name: String) -> UInt32? {
        let named: [String: Int] = [
            "space": kVK_Space, "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab,
            "escape": kVK_Escape, "esc": kVK_Escape, "delete": kVK_Delete,
            "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
            "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
            "f13": kVK_F13, "f14": kVK_F14, "f15": kVK_F15,
            "`": kVK_ANSI_Grave, "grave": kVK_ANSI_Grave,
        ]
        if let code = named[name] { return UInt32(code) }

        let letters: [String: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
            "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
            "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
            "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
            "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
            "z": kVK_ANSI_Z,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
            "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        ]
        return letters[name].map(UInt32.init)
    }
}

public struct HotkeyMonitorState: Equatable, Sendable {
    public var fnTapActive: Bool
    public var fnTapError: String?
    public var fallbackActive: Bool
    public var fallbackDisplay: String?
}

/// Turns raw keyboard hardware events into ``DictationEvent`` values. Contains no dictation logic
/// whatsoever — every decision belongs to ``DictationStateMachine``.
///
/// Two independent registrations, on purpose:
///
/// * a **listen-only** `CGEventTap` for standalone Fn. Listen-only means macOS never waits for our
///   verdict, so Fn keeps doing everything it normally does (F-key toggle, emoji picker, dictation)
///   and a slow agent can never wedge the keyboard. It requires Input Monitoring.
/// * a Carbon `RegisterEventHotKey` for the configurable chord. Carbon hot keys need **no** TCC
///   permission at all, so the app still works when the tap cannot be installed.
public final class HotkeyMonitor {
    /// Delivered synchronously on the main thread.
    public var onEvent: ((DictationEvent) -> Void)?
    /// Called whenever the tap or the fallback registration changes availability.
    public var onStateChange: ((HotkeyMonitorState) -> Void)?

    public private(set) var state = HotkeyMonitorState(
        fnTapActive: false,
        fnTapError: nil,
        fallbackActive: false,
        fallbackDisplay: nil
    )

    public var fnTriggerEnabled = true

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var fnIsDown = false
    private var sawOtherKeyDuringFn = false

    private var hotKeyRef: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
    private var hotKeySpec: HotkeySpec?
    private var fallbackIsDown = false

    private static let hotKeySignature: OSType = 0x4C56_4648 // 'LVFH'

    public init() {}

    deinit {
        stop()
    }

    // MARK: - Lifecycle

    /// Installs the Fn tap. Returns false and records a reason when macOS refuses; the caller
    /// reports that to core (`fnTapActive: false`) and shows it in the menu.
    @discardableResult
    public func startFnTap() -> Bool {
        guard eventTap == nil else { return true }

        // Ask before tapping, and do not tap without an answer.
        //
        // Creating an event tap without Input Monitoring looks harmless — `tapCreate` even
        // succeeds — but it is the single most destructive thing this app can do to its own
        // setup. macOS shows no prompt, writes no record, and simply marks *this process* as
        // denied for the rest of its life. From then on `IOHIDRequestAccess` is a no-op, so the
        // button in the onboarding window can never produce the system dialog, and System
        // Settings → Input Monitoring stays an empty list with nothing to switch on. That empty
        // list is where "just drag the app in from Finder" comes from.
        //
        // `IOHIDRequestAccess` is the call that shows the prompt and creates the row. It matters
        // only on the very first launch; afterwards it returns the recorded answer immediately.
        var permission = Permissions.inputMonitoring()
        if permission == .notDetermined {
            permission = Permissions.requestInputMonitoring()
            AgentLog.info("input monitoring prompt shown at startup: \(permission.rawValue)")
        }
        guard permission == .granted else {
            let reason = permission == .denied
                ? "нет разрешения «Мониторинг ввода»"
                : "состояние разрешения «Мониторинг ввода» неизвестно"
            updateState(fnTapActive: false, fnTapError: reason)
            AgentLog.warn("Fn event tap not installed: \(reason)")
            return false
        }

        let mask: CGEventMask =
            (1 << CGEventType.flagsChanged.rawValue) |
            (1 << CGEventType.keyDown.rawValue)

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        // `.listenOnly`: the tap observes and never modifies or delays the event stream.
        let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: hotkeyTapCallback,
            userInfo: refcon
        )

        guard let tap else {
            // Permission is granted at this point, so a refusal here is macOS itself saying no —
            // most often because the grant landed after this process started.
            let reason = "macOS отклонил создание event tap — перезапустите LocalVoiceFlow"
            updateState(fnTapActive: false, fnTapError: reason)
            AgentLog.error("Fn event tap could not be created: \(reason)")
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        eventTap = tap
        runLoopSource = source
        updateState(fnTapActive: true, fnTapError: nil)
        AgentLog.info("Fn event tap installed (listen-only)")
        return true
    }

    public func stopFnTap() {
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
            CFMachPortInvalidate(eventTap)
        }
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        eventTap = nil
        runLoopSource = nil
        fnIsDown = false
        sawOtherKeyDuringFn = false
        updateState(fnTapActive: false, fnTapError: state.fnTapError)
    }

    /// (Re)registers the fallback chord. Passing nil or an unparsable string unregisters it.
    @discardableResult
    public func setFallbackHotkey(_ raw: String?) -> Bool {
        // Startup calls this twice — once from `startService`, once when the config arrives from
        // core — and re-registering leaves a window in which the chord is dead. Same shortcut
        // that is already live means there is nothing to do.
        if let raw, !raw.isEmpty, let spec = HotkeySpec.parse(raw), spec == hotKeySpec, hotKeyRef != nil {
            return true
        }

        unregisterFallback()
        guard let raw, !raw.isEmpty, let spec = HotkeySpec.parse(raw) else {
            if let raw, !raw.isEmpty {
                AgentLog.warn("fallback hotkey '\(raw)' is not a recognisable shortcut; disabled")
            }
            updateFallbackState(active: false, display: nil)
            return false
        }

        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var handler: EventHandlerRef?
        let handlerStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            carbonHotKeyHandler,
            specs.count,
            &specs,
            refcon,
            &handler
        )
        guard handlerStatus == noErr else {
            AgentLog.error("InstallEventHandler failed: \(handlerStatus)")
            updateFallbackState(active: false, display: nil)
            return false
        }
        hotKeyHandler = handler

        let hotKeyID = EventHotKeyID(signature: Self.hotKeySignature, id: 1)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            spec.keyCode,
            spec.carbonModifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        guard status == noErr, let ref else {
            AgentLog.error("RegisterEventHotKey failed for \(spec.display): \(status)")
            if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
            hotKeyHandler = nil
            updateFallbackState(active: false, display: nil)
            return false
        }

        hotKeyRef = ref
        hotKeySpec = spec
        updateFallbackState(active: true, display: spec.display)
        AgentLog.info("fallback hotkey registered: \(spec.display)")
        return true
    }

    public func stop() {
        stopFnTap()
        unregisterFallback()
    }

    private func unregisterFallback() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
        hotKeyRef = nil
        hotKeyHandler = nil
        hotKeySpec = nil
        fallbackIsDown = false
    }

    private func updateState(fnTapActive: Bool, fnTapError: String?) {
        state.fnTapActive = fnTapActive
        state.fnTapError = fnTapError
        onStateChange?(state)
    }

    private func updateFallbackState(active: Bool, display: String?) {
        state.fallbackActive = active
        state.fallbackDisplay = display
        onStateChange?(state)
    }

    // MARK: - CGEventTap

    /// Called on the main run loop by the C tap callback.
    fileprivate func processTapEvent(type: CGEventType, event: CGEvent) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // macOS kills a tap that took too long or after certain user actions. Turning it back
            // on is the documented recovery; without this the agent silently stops responding.
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
                AgentLog.warn("event tap was disabled by the system; re-enabled")
            }
            return

        case .flagsChanged:
            let fnDown = event.flags.contains(.maskSecondaryFn)
            guard fnDown != fnIsDown else { return }
            fnIsDown = fnDown
            guard fnTriggerEnabled else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if fnDown {
                sawOtherKeyDuringFn = false
                emit(.fnDown(at: now))
            } else {
                // A chord already cancelled the capture; the release must not finalise anything.
                if !sawOtherKeyDuringFn { emit(.fnUp(at: now)) }
                sawOtherKeyDuringFn = false
            }

        case .keyDown:
            let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
            if keyCode == kVK_Escape {
                emit(.escapePressed)
                return
            }
            if keyCode == kVK_Return || keyCode == kVK_ANSI_KeypadEnter {
                emit(.enterPressed)
                return
            }
            if fnIsDown, fnTriggerEnabled, !sawOtherKeyDuringFn {
                // Fn+F1, Fn+←, Fn+delete… — an ordinary system chord, not dictation.
                sawOtherKeyDuringFn = true
                emit(.otherKeyWhileFnHeld)
            }

        default:
            return
        }
    }

    // MARK: - Carbon hot key

    fileprivate func processCarbonHotKey(kind: UInt32) {
        let now = ProcessInfo.processInfo.systemUptime
        if kind == UInt32(kEventHotKeyPressed) {
            guard !fallbackIsDown else { return }
            fallbackIsDown = true
            emit(.fallbackHotkeyDown(at: now))
        } else if kind == UInt32(kEventHotKeyReleased) {
            guard fallbackIsDown else { return }
            fallbackIsDown = false
            emit(.fallbackHotkeyUp(at: now))
        }
    }

    private func emit(_ event: DictationEvent) {
        onEvent?(event)
    }
}

// MARK: - C callbacks

/// CGEventTap callback. Runs on the run loop the tap source was added to — the main run loop —
/// so it can talk to the monitor directly.
private func hotkeyTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(refcon).takeUnretainedValue()
    monitor.processTapEvent(type: type, event: event)
    // A listen-only tap's return value is ignored, but passing the event through keeps the
    // contract obvious if the tap is ever promoted to an active one.
    return Unmanaged.passUnretained(event)
}

private let carbonHotKeyHandler: EventHandlerUPP = { _, event, userData in
    guard let userData, let event else { return OSStatus(eventNotHandledErr) }
    let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(userData).takeUnretainedValue()
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    guard status == noErr, hotKeyID.id == 1 else { return OSStatus(eventNotHandledErr) }
    monitor.processCarbonHotKey(kind: GetEventKind(event))
    return noErr
}
