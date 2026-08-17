import Foundation

/// Recording mode as it travels to core in `X-LVF-Recording-Mode`.
public enum RecordingMode: String, Sendable, Equatable, Codable {
    case pushToTalk = "push-to-talk"
    case locked = "locked"
}

/// Which physical trigger owns the capture in flight. A stray release from the *other* trigger
/// must never stop a capture that was not started by it.
public enum DictationTrigger: Sendable, Equatable {
    case fn
    case fallbackHotkey
}

/// All timestamps are monotonic seconds (`ProcessInfo.processInfo.systemUptime` in production,
/// literal numbers in tests). The machine never reads a clock itself, so every transition is
/// reproducible without sleeping.
public enum DictationEvent: Sendable, Equatable {
    case fnDown(at: Double)
    case fnUp(at: Double)
    case otherKeyWhileFnHeld
    case escapePressed
    case enterPressed
    case fallbackHotkeyDown(at: Double)
    case fallbackHotkeyUp(at: Double)
    case tick(at: Double)
    case maxDurationReached
}

/// Side effects the caller is responsible for performing, in the order returned.
public enum DictationEffect: Sendable, Equatable {
    case startCapture(mode: RecordingMode)
    case stopCaptureAndProcess
    case discardCapture
    case none
}

public enum DictationState: Sendable, Equatable {
    case idle
    /// Capturing; the trigger is held and the double-tap window has not elapsed yet.
    case pendingPushToTalk
    /// Capturing; the trigger is held and the press is long enough to be an ordinary hold.
    case pushToTalk
    /// The trigger was released inside the double-tap window. **Capture keeps running** so that
    /// the gap between the two taps of a double tap contains no hole.
    case awaitingSecondTap
    /// Hands-free capture; ends on a second double tap, Enter (when enabled), Escape or max duration.
    case locked
    /// Capture was thrown away while the trigger is still physically held. Waits for the release
    /// so that letting go does not finalise anything.
    case cancelled
}

public struct DictationConfig: Sendable, Equatable {
    public var doubleTapWindowMs: Double
    public var minRecordingMs: Double
    public var maxRecordingSeconds: Double
    public var endLockedRecordingWithEnter: Bool
    public var fnTriggerEnabled: Bool
    public var fallbackHotkeyEnabled: Bool

    public init(
        doubleTapWindowMs: Double = 350,
        minRecordingMs: Double = 350,
        maxRecordingSeconds: Double = 180,
        endLockedRecordingWithEnter: Bool = false,
        fnTriggerEnabled: Bool = true,
        fallbackHotkeyEnabled: Bool = true
    ) {
        self.doubleTapWindowMs = doubleTapWindowMs
        self.minRecordingMs = minRecordingMs
        self.maxRecordingSeconds = maxRecordingSeconds
        self.endLockedRecordingWithEnter = endLockedRecordingWithEnter
        self.fnTriggerEnabled = fnTriggerEnabled
        self.fallbackHotkeyEnabled = fallbackHotkeyEnabled
    }

    var doubleTapWindow: Double { doubleTapWindowMs / 1000 }
    var minRecording: Double { minRecordingMs / 1000 }
}

/// Pure dictation control logic. Knows nothing about audio, AppKit or the network: it turns key
/// events into capture effects and is the single place where the double-tap rules live.
///
/// Contract for the caller: read ``recordingMode`` *synchronously* while handling
/// `.stopCaptureAndProcess`; it describes the capture being finalised at that moment.
public final class DictationStateMachine {
    public private(set) var state: DictationState = .idle
    public private(set) var recordingMode: RecordingMode = .pushToTalk
    public var config: DictationConfig

    /// Trigger that owns the capture in flight.
    private var trigger: DictationTrigger?
    /// Monotonic time at which the audio capture in flight started.
    private var captureStartedAt: Double = 0
    /// Monotonic time of the current press of the trigger.
    private var pressStartedAt: Double = 0
    /// Monotonic time of the release that opened `.awaitingSecondTap`.
    private var releasedAt: Double?
    /// How long the trigger was actually held. This — not the wall time of the capture — decides
    /// the `minRecordingMs` cut, otherwise the extra audio recorded while waiting for a second tap
    /// would make every accidental brush look long enough to send.
    private var heldDuration: Double = 0
    private var lockedTapPressedAt: Double?
    private var lockedTapReleasedAt: Double?

    public init(config: DictationConfig = DictationConfig()) {
        self.config = config
    }

    public var isCapturing: Bool {
        switch state {
        case .pendingPushToTalk, .pushToTalk, .awaitingSecondTap, .locked: return true
        case .idle, .cancelled: return false
        }
    }

    /// Monotonic time at which a `.tick` becomes useful, or nil when no timer is needed.
    public var pendingDeadline: Double? {
        switch state {
        case .pendingPushToTalk:
            return pressStartedAt + config.doubleTapWindow
        case .awaitingSecondTap:
            return releasedAt.map { $0 + config.doubleTapWindow }
        case .locked:
            if let released = lockedTapReleasedAt { return released + config.doubleTapWindow }
            if let pressed = lockedTapPressedAt { return pressed + config.doubleTapWindow }
            return nil
        case .idle, .pushToTalk, .cancelled:
            return nil
        }
    }

    /// Monotonic time at which the capture in flight started, for duration/HUD purposes.
    public var captureStartTime: Double? { isCapturing ? captureStartedAt : nil }

    @discardableResult
    public func handle(_ event: DictationEvent) -> [DictationEffect] {
        switch event {
        case .fnDown(let at):
            return triggerDown(.fn, at: at)
        case .fnUp(let at):
            return triggerUp(.fn, at: at)
        case .fallbackHotkeyDown(let at):
            return triggerDown(.fallbackHotkey, at: at)
        case .fallbackHotkeyUp(let at):
            return triggerUp(.fallbackHotkey, at: at)
        case .otherKeyWhileFnHeld:
            return otherKeyWhileFnHeld()
        case .escapePressed:
            return escapePressed()
        case .enterPressed:
            return enterPressed()
        case .tick(let at):
            return tick(at: at)
        case .maxDurationReached:
            return maxDurationReached()
        }
    }

    public func reset() {
        state = .idle
        recordingMode = .pushToTalk
        trigger = nil
        releasedAt = nil
        heldDuration = 0
        lockedTapPressedAt = nil
        lockedTapReleasedAt = nil
    }

    // MARK: - Trigger handling

    private func isEnabled(_ trigger: DictationTrigger) -> Bool {
        switch trigger {
        case .fn: return config.fnTriggerEnabled
        case .fallbackHotkey: return config.fallbackHotkeyEnabled
        }
    }

    private func triggerDown(_ incoming: DictationTrigger, at now: Double) -> [DictationEffect] {
        guard isEnabled(incoming) else { return [.none] }

        switch state {
        case .idle:
            return beginCapture(incoming, at: now)

        case .awaitingSecondTap:
            guard incoming == trigger else { return [.none] }
            if let released = releasedAt, now - released < config.doubleTapWindow {
                // The capture from the first tap simply continues; locking never produces a
                // separate (empty) dictation for the short press that opened the window.
                state = .locked
                recordingMode = .locked
                releasedAt = nil
                lockedTapPressedAt = nil
                lockedTapReleasedAt = nil
                return [.none]
            }
            // The window expired but no tick arrived (a late timer). Finalise the awaited capture
            // and treat this press as the start of a new one. Both are push-to-talk, so a caller
            // reading `recordingMode` while handling either effect sees the correct value.
            var effects = finalizePushToTalk()
            effects.append(contentsOf: beginCapture(incoming, at: now))
            return effects

        case .locked:
            guard incoming == trigger else { return [.none] }
            if let released = lockedTapReleasedAt, now - released < config.doubleTapWindow {
                lockedTapPressedAt = nil
                lockedTapReleasedAt = nil
                return finalizeLocked(at: now)
            }
            lockedTapPressedAt = now
            lockedTapReleasedAt = nil
            return [.none]

        case .pendingPushToTalk, .pushToTalk, .cancelled:
            return [.none]
        }
    }

    private func triggerUp(_ incoming: DictationTrigger, at now: Double) -> [DictationEffect] {
        guard isEnabled(incoming) else { return [.none] }
        guard incoming == trigger else { return [.none] }

        switch state {
        case .pendingPushToTalk:
            let held = now - captureStartedAt
            if held < config.doubleTapWindow {
                heldDuration = held
                releasedAt = now
                state = .awaitingSecondTap
                return [.none]
            }
            heldDuration = held
            return finalizePushToTalk()

        case .pushToTalk:
            heldDuration = now - captureStartedAt
            return finalizePushToTalk()

        case .locked:
            if let pressed = lockedTapPressedAt, now - pressed < config.doubleTapWindow {
                lockedTapReleasedAt = now
            } else {
                lockedTapReleasedAt = nil
            }
            lockedTapPressedAt = nil
            return [.none]

        case .cancelled:
            reset()
            return [.none]

        case .idle, .awaitingSecondTap:
            return [.none]
        }
    }

    private func beginCapture(_ incoming: DictationTrigger, at now: Double) -> [DictationEffect] {
        state = .pendingPushToTalk
        recordingMode = .pushToTalk
        trigger = incoming
        captureStartedAt = now
        pressStartedAt = now
        releasedAt = nil
        heldDuration = 0
        lockedTapPressedAt = nil
        lockedTapReleasedAt = nil
        return [.startCapture(mode: .pushToTalk)]
    }

    // MARK: - Other events

    private func otherKeyWhileFnHeld() -> [DictationEffect] {
        // Fn+F1, Fn+arrow, Fn+delete… are ordinary system chords, not dictation. Throw the audio
        // away and get out of the way so the chord keeps working exactly as it does without us.
        guard trigger == .fn, state == .pendingPushToTalk || state == .pushToTalk else {
            return [.none]
        }
        reset()
        return [.discardCapture]
    }

    private func escapePressed() -> [DictationEffect] {
        switch state {
        case .pendingPushToTalk, .pushToTalk:
            // The trigger is still down; park in `.cancelled` so its release finalises nothing.
            state = .cancelled
            releasedAt = nil
            heldDuration = 0
            return [.discardCapture]
        case .awaitingSecondTap, .locked:
            reset()
            return [.discardCapture]
        case .idle, .cancelled:
            return [.none]
        }
    }

    private func enterPressed() -> [DictationEffect] {
        guard config.endLockedRecordingWithEnter, state == .locked else { return [.none] }
        state = .idle
        trigger = nil
        lockedTapPressedAt = nil
        lockedTapReleasedAt = nil
        releasedAt = nil
        return [.stopCaptureAndProcess]
    }

    private func tick(at now: Double) -> [DictationEffect] {
        switch state {
        case .pendingPushToTalk:
            if now - pressStartedAt >= config.doubleTapWindow { state = .pushToTalk }
            return [.none]

        case .awaitingSecondTap:
            guard let released = releasedAt, now - released >= config.doubleTapWindow else {
                return [.none]
            }
            return finalizePushToTalk()

        case .locked:
            if let released = lockedTapReleasedAt, now - released >= config.doubleTapWindow {
                lockedTapReleasedAt = nil
            }
            if let pressed = lockedTapPressedAt, now - pressed >= config.doubleTapWindow {
                lockedTapPressedAt = nil
            }
            return [.none]

        case .idle, .pushToTalk, .cancelled:
            return [.none]
        }
    }

    private func maxDurationReached() -> [DictationEffect] {
        guard isCapturing else { return [.none] }
        let mode = recordingMode
        state = .idle
        trigger = nil
        releasedAt = nil
        lockedTapPressedAt = nil
        lockedTapReleasedAt = nil
        recordingMode = mode
        return [.stopCaptureAndProcess]
    }

    // MARK: - Finalisation

    private func finalizePushToTalk() -> [DictationEffect] {
        let held = heldDuration
        state = .idle
        trigger = nil
        releasedAt = nil
        heldDuration = 0
        lockedTapPressedAt = nil
        lockedTapReleasedAt = nil
        recordingMode = .pushToTalk
        return held < config.minRecording ? [.discardCapture] : [.stopCaptureAndProcess]
    }

    private func finalizeLocked(at now: Double) -> [DictationEffect] {
        let duration = now - captureStartedAt
        state = .idle
        trigger = nil
        releasedAt = nil
        heldDuration = 0
        lockedTapPressedAt = nil
        lockedTapReleasedAt = nil
        recordingMode = .locked
        return duration < config.minRecording ? [.discardCapture] : [.stopCaptureAndProcess]
    }
}
