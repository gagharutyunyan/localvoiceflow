import XCTest

@testable import LocalVoiceFlowAgent

/// Every test drives the machine with explicit timestamps in seconds; nothing here sleeps.
final class DictationStateMachineTests: XCTestCase {
    /// 350 ms double-tap window and a 350 ms minimum, the shipped defaults.
    private func makeMachine(
        window: Double = 350,
        minRecording: Double = 350,
        enter: Bool = false,
        fn: Bool = true,
        fallback: Bool = true
    ) -> DictationStateMachine {
        DictationStateMachine(
            config: DictationConfig(
                doubleTapWindowMs: window,
                minRecordingMs: minRecording,
                maxRecordingSeconds: 180,
                endLockedRecordingWithEnter: enter,
                fnTriggerEnabled: fn,
                fallbackHotkeyEnabled: fallback
            )
        )
    }

    // MARK: - Starting

    func testFnDownStartsCaptureImmediately() {
        let machine = makeMachine()
        let effects = machine.handle(.fnDown(at: 10))

        XCTAssertEqual(effects, [.startCapture(mode: .pushToTalk)])
        XCTAssertEqual(machine.state, .pendingPushToTalk)
        XCTAssertTrue(machine.isCapturing)
        XCTAssertEqual(machine.recordingMode, .pushToTalk)
        XCTAssertEqual(machine.captureStartTime, 10)
    }

    func testHeldPressPastWindowBecomesPushToTalkAndProcessesOnRelease() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        XCTAssertEqual(machine.handle(.tick(at: 0.36)), [.none])
        XCTAssertEqual(machine.state, .pushToTalk)

        let effects = machine.handle(.fnUp(at: 2.0))
        XCTAssertEqual(effects, [.stopCaptureAndProcess])
        XCTAssertEqual(machine.recordingMode, .pushToTalk)
        XCTAssertEqual(machine.state, .idle)
        XCTAssertFalse(machine.isCapturing)
    }

    // MARK: - Minimum duration

    func testCaptureShorterThanMinimumIsDiscardedNotSent() {
        // Window 200 ms so the press is a long hold, minimum 500 ms so it is still too short.
        let machine = makeMachine(window: 200, minRecording: 500)
        machine.handle(.fnDown(at: 0))
        machine.handle(.tick(at: 0.21))
        XCTAssertEqual(machine.state, .pushToTalk)

        let effects = machine.handle(.fnUp(at: 0.3))
        XCTAssertEqual(effects, [.discardCapture])
        XCTAssertFalse(effects.contains(.stopCaptureAndProcess))
        XCTAssertEqual(machine.state, .idle)
    }

    func testAwaitedShortTapIsDiscardedWhenBelowMinimumEvenThoughCaptureKeptRunning() {
        // The extra audio recorded while waiting for a second tap must not make a 120 ms brush
        // look like a 470 ms dictation.
        let machine = makeMachine(window: 350, minRecording: 350)
        machine.handle(.fnDown(at: 0))
        XCTAssertEqual(machine.handle(.fnUp(at: 0.12)), [.none])
        XCTAssertEqual(machine.state, .awaitingSecondTap)

        let effects = machine.handle(.tick(at: 0.48))
        XCTAssertEqual(effects, [.discardCapture])
        XCTAssertEqual(machine.state, .idle)
    }

    // MARK: - Double tap

    func testShortReleaseKeepsCapturingAndWaitsForSecondTap() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))

        let effects = machine.handle(.fnUp(at: 0.1))
        XCTAssertEqual(effects, [.none], "a short release must not finalise anything yet")
        XCTAssertEqual(machine.state, .awaitingSecondTap)
        XCTAssertTrue(machine.isCapturing, "capture continues so no audio is lost between taps")
        XCTAssertEqual(machine.captureStartTime, 0, "the original capture is still the live one")
    }

    func testSecondTapInsideWindowLocksTheStillRunningCapture() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.1))

        let effects = machine.handle(.fnDown(at: 0.2))
        XCTAssertEqual(effects, [.none], "locking must not start a second capture or stop the first")
        XCTAssertEqual(machine.state, .locked)
        XCTAssertEqual(machine.recordingMode, .locked)
        XCTAssertEqual(machine.captureStartTime, 0)
    }

    func testShortPressFollowedBySecondPressNeverProducesAnEmptyDictation() {
        let machine = makeMachine()
        var all: [DictationEffect] = []
        all += machine.handle(.fnDown(at: 0))
        all += machine.handle(.fnUp(at: 0.09))
        all += machine.handle(.fnDown(at: 0.18))
        all += machine.handle(.fnUp(at: 0.26))
        all += machine.handle(.tick(at: 0.7))

        XCTAssertEqual(all.filter { $0 == .stopCaptureAndProcess }.count, 0)
        XCTAssertEqual(all.filter { $0 == .discardCapture }.count, 0)
        XCTAssertEqual(all.filter { if case .startCapture = $0 { return true } else { return false } }.count, 1)
        XCTAssertEqual(machine.state, .locked)
    }

    func testNoSecondTapFinalisesAsPushToTalk() {
        let machine = makeMachine(window: 350, minRecording: 100)
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.2))

        XCTAssertEqual(machine.handle(.tick(at: 0.4)), [.none], "still inside the window")
        let effects = machine.handle(.tick(at: 0.56))
        XCTAssertEqual(effects, [.stopCaptureAndProcess])
        XCTAssertEqual(machine.recordingMode, .pushToTalk)
        XCTAssertEqual(machine.state, .idle)
    }

    func testSecondPressAfterWindowFinalisesTheFirstAndStartsANewCapture() {
        // Defends against a late timer: the machine must not get stuck in .awaitingSecondTap.
        let machine = makeMachine(window: 350, minRecording: 100)
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.2))

        let effects = machine.handle(.fnDown(at: 1.5))
        XCTAssertEqual(effects, [.stopCaptureAndProcess, .startCapture(mode: .pushToTalk)])
        XCTAssertEqual(machine.state, .pendingPushToTalk)
        XCTAssertEqual(machine.captureStartTime, 1.5)
    }

    // MARK: - Fn used as an ordinary modifier

    func testOtherKeyWhileFnHeldDiscardsAndReturnsToIdle() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))

        let effects = machine.handle(.otherKeyWhileFnHeld)
        XCTAssertEqual(effects, [.discardCapture])
        XCTAssertEqual(machine.state, .idle, "Fn+F1 is a system chord, not a dictation")
        XCTAssertFalse(machine.isCapturing)
    }

    func testOtherKeyWhileFnHeldNeverProcesses() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        machine.handle(.otherKeyWhileFnHeld)

        let onRelease = machine.handle(.fnUp(at: 0.9))
        XCTAssertEqual(onRelease, [.none], "releasing Fn after a chord must not send anything")
        XCTAssertEqual(machine.state, .idle)
    }

    func testOtherKeyAfterWindowStillDiscards() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        machine.handle(.tick(at: 0.4))
        XCTAssertEqual(machine.state, .pushToTalk)

        XCTAssertEqual(machine.handle(.otherKeyWhileFnHeld), [.discardCapture])
        XCTAssertEqual(machine.state, .idle)
    }

    func testOtherKeyIsIgnoredWhenTheFallbackHotkeyOwnsTheCapture() {
        let machine = makeMachine()
        machine.handle(.fallbackHotkeyDown(at: 0))

        XCTAssertEqual(machine.handle(.otherKeyWhileFnHeld), [.none])
        XCTAssertTrue(machine.isCapturing)
    }

    // MARK: - Locked mode

    func testDoubleTapInLockedModeEndsRecordingAndProcesses() {
        let machine = makeMachine(window: 350, minRecording: 350)
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.1))
        machine.handle(.fnDown(at: 0.2))
        XCTAssertEqual(machine.state, .locked)

        XCTAssertEqual(machine.handle(.fnUp(at: 0.25)), [.none])
        XCTAssertEqual(machine.handle(.fnDown(at: 5.0)), [.none], "first tap of the closing double tap")
        XCTAssertEqual(machine.handle(.fnUp(at: 5.08)), [.none])

        let effects = machine.handle(.fnDown(at: 5.2))
        XCTAssertEqual(effects, [.stopCaptureAndProcess])
        XCTAssertEqual(machine.recordingMode, .locked)
        XCTAssertEqual(machine.state, .idle)
    }

    func testSingleTapInLockedModeDoesNotEndRecording() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.1))
        machine.handle(.fnDown(at: 0.2))
        machine.handle(.fnUp(at: 0.25))

        XCTAssertEqual(machine.handle(.tick(at: 1.0)), [.none])
        XCTAssertEqual(machine.handle(.fnDown(at: 4.0)), [.none])
        XCTAssertEqual(machine.handle(.fnUp(at: 4.05)), [.none])
        XCTAssertEqual(machine.handle(.tick(at: 4.6)), [.none], "the window for the second tap expired")
        XCTAssertEqual(machine.handle(.fnDown(at: 4.7)), [.none], "so this is a fresh first tap, not a close")
        XCTAssertEqual(machine.state, .locked)
        XCTAssertTrue(machine.isCapturing)
    }

    // MARK: - Escape

    func testEscapeCancelsPushToTalkAndSwallowsTheRelease() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))

        XCTAssertEqual(machine.handle(.escapePressed), [.discardCapture])
        XCTAssertEqual(machine.state, .cancelled)
        XCTAssertFalse(machine.isCapturing)

        XCTAssertEqual(machine.handle(.fnUp(at: 1.0)), [.none])
        XCTAssertEqual(machine.state, .idle)
    }

    func testEscapeCancelsLockedRecordingImmediately() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.1))
        machine.handle(.fnDown(at: 0.2))
        XCTAssertEqual(machine.state, .locked)

        XCTAssertEqual(machine.handle(.escapePressed), [.discardCapture])
        XCTAssertEqual(machine.state, .idle)
    }

    func testEscapeCancelsWhileAwaitingSecondTap() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.1))

        XCTAssertEqual(machine.handle(.escapePressed), [.discardCapture])
        XCTAssertEqual(machine.state, .idle)
        XCTAssertEqual(machine.handle(.tick(at: 0.6)), [.none], "the expired window must not resurrect it")
    }

    func testEscapeWhenIdleDoesNothing() {
        let machine = makeMachine()
        XCTAssertEqual(machine.handle(.escapePressed), [.none])
        XCTAssertEqual(machine.state, .idle)
    }

    // MARK: - Enter

    func testEnterEndsLockedRecordingOnlyWhenEnabled() {
        let disabled = makeMachine(enter: false)
        disabled.handle(.fnDown(at: 0))
        disabled.handle(.fnUp(at: 0.1))
        disabled.handle(.fnDown(at: 0.2))
        XCTAssertEqual(disabled.handle(.enterPressed), [.none])
        XCTAssertEqual(disabled.state, .locked)

        let enabled = makeMachine(enter: true)
        enabled.handle(.fnDown(at: 0))
        enabled.handle(.fnUp(at: 0.1))
        enabled.handle(.fnDown(at: 0.2))
        XCTAssertEqual(enabled.handle(.enterPressed), [.stopCaptureAndProcess])
        XCTAssertEqual(enabled.recordingMode, .locked)
        XCTAssertEqual(enabled.state, .idle)
    }

    func testEnterDoesNotEndAPushToTalkRecordingEvenWhenEnabled() {
        let machine = makeMachine(enter: true)
        machine.handle(.fnDown(at: 0))
        XCTAssertEqual(machine.handle(.enterPressed), [.none])
        XCTAssertEqual(machine.state, .pendingPushToTalk)
        XCTAssertTrue(machine.isCapturing)
    }

    // MARK: - Max duration

    func testMaxDurationReachedFinalisesLockedRecording() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.1))
        machine.handle(.fnDown(at: 0.2))

        let effects = machine.handle(.maxDurationReached)
        XCTAssertEqual(effects, [.stopCaptureAndProcess])
        XCTAssertEqual(machine.recordingMode, .locked)
        XCTAssertEqual(machine.state, .idle)
    }

    func testMaxDurationWhenIdleIsIgnored() {
        let machine = makeMachine()
        XCTAssertEqual(machine.handle(.maxDurationReached), [.none])
        XCTAssertEqual(machine.state, .idle)
    }

    // MARK: - Triggers

    func testFallbackHotkeyDrivesTheSameFlow() {
        let machine = makeMachine(window: 350, minRecording: 100)
        XCTAssertEqual(machine.handle(.fallbackHotkeyDown(at: 0)), [.startCapture(mode: .pushToTalk)])
        XCTAssertEqual(machine.handle(.fnUp(at: 0.5)), [.none], "Fn does not own this capture")
        XCTAssertTrue(machine.isCapturing)

        XCTAssertEqual(machine.handle(.fallbackHotkeyUp(at: 1.0)), [.stopCaptureAndProcess])
        XCTAssertEqual(machine.state, .idle)
    }

    func testDisabledFnTriggerIgnoresFnButKeepsTheFallbackWorking() {
        let machine = makeMachine(minRecording: 100, fn: false)
        XCTAssertEqual(machine.handle(.fnDown(at: 0)), [.none])
        XCTAssertEqual(machine.state, .idle)

        XCTAssertEqual(machine.handle(.fallbackHotkeyDown(at: 1)), [.startCapture(mode: .pushToTalk)])
        XCTAssertEqual(machine.handle(.fallbackHotkeyUp(at: 2)), [.stopCaptureAndProcess])
    }

    // MARK: - Timer scheduling contract

    func testPendingDeadlineTracksTheOpenWindow() {
        let machine = makeMachine(window: 350)
        XCTAssertNil(machine.pendingDeadline)

        machine.handle(.fnDown(at: 10))
        XCTAssertEqual(machine.pendingDeadline ?? 0, 10.35, accuracy: 1e-9)

        machine.handle(.fnUp(at: 10.1))
        XCTAssertEqual(machine.pendingDeadline ?? 0, 10.45, accuracy: 1e-9)

        machine.handle(.fnDown(at: 10.2))
        XCTAssertNil(machine.pendingDeadline, "locked with no tap in progress needs no timer")
    }

    func testResetReturnsEverythingToIdle() {
        let machine = makeMachine()
        machine.handle(.fnDown(at: 0))
        machine.handle(.fnUp(at: 0.1))
        machine.handle(.fnDown(at: 0.2))
        machine.reset()

        XCTAssertEqual(machine.state, .idle)
        XCTAssertEqual(machine.recordingMode, .pushToTalk)
        XCTAssertFalse(machine.isCapturing)
        XCTAssertNil(machine.pendingDeadline)
    }
}
