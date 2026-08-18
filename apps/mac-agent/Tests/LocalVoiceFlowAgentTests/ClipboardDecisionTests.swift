import AppKit
import XCTest

@testable import LocalVoiceFlowAgent

/// The insertion rules that decide whether the user's clipboard survives a dictation, and where
/// the text is allowed to land. All pure functions — no pasteboard, no focused field, no TCC.
final class ClipboardDecisionTests: XCTestCase {
    // MARK: - shouldRestoreClipboard

    func testRestoresWhenNobodyElseTouchedThePasteboard() {
        XCTAssertTrue(
            InsertionPolicy.shouldRestoreClipboard(
                changeCountAtWrite: 42,
                currentChangeCount: 42,
                userSettingEnabled: true
            )
        )
    }

    func testDoesNotRestoreWhenAnotherProcessWroteAfterUs() {
        // Someone copied something during the paste delay; restoring would destroy their data.
        XCTAssertFalse(
            InsertionPolicy.shouldRestoreClipboard(
                changeCountAtWrite: 42,
                currentChangeCount: 43,
                userSettingEnabled: true
            )
        )
    }

    func testDoesNotRestoreWhenTheSettingIsOff() {
        XCTAssertFalse(
            InsertionPolicy.shouldRestoreClipboard(
                changeCountAtWrite: 42,
                currentChangeCount: 42,
                userSettingEnabled: false
            )
        )
    }

    func testDoesNotRestoreWhenTheSettingIsOffAndThePasteboardMovedOn() {
        XCTAssertFalse(
            InsertionPolicy.shouldRestoreClipboard(
                changeCountAtWrite: 7,
                currentChangeCount: 99,
                userSettingEnabled: false
            )
        )
    }

    func testAnOlderChangeCountAlsoBlocksRestore() {
        // changeCount never goes backwards for a live pasteboard, but a pasteboard that was reset
        // must not be treated as "still ours".
        XCTAssertFalse(
            InsertionPolicy.shouldRestoreClipboard(
                changeCountAtWrite: 42,
                currentChangeCount: 41,
                userSettingEnabled: true
            )
        )
    }

    // MARK: - resolvePlan

    func testSecureInputForcesClipboardOnly() {
        XCTAssertEqual(
            InsertionPolicy.resolvePlan(
                requested: .insertIntoOriginalTarget,
                secureInputActive: true,
                accessibilityGranted: true
            ),
            .clipboardOnly
        )
    }

    func testMissingAccessibilityForcesClipboardOnly() {
        XCTAssertEqual(
            InsertionPolicy.resolvePlan(
                requested: .insertIntoOriginalTarget,
                secureInputActive: false,
                accessibilityGranted: false
            ),
            .clipboardOnly
        )
    }

    func testPlanIsKeptWhenNothingBlocksIt() {
        XCTAssertEqual(
            InsertionPolicy.resolvePlan(
                requested: .insertIntoCurrentApp,
                secureInputActive: false,
                accessibilityGranted: true
            ),
            .insertIntoCurrentApp
        )
    }

    // MARK: - Writable roles

    func testSecureTextFieldIsNeverWritable() {
        XCTAssertFalse(
            InsertionPolicy.isWritableTextRole(
                role: kAXTextFieldRole as String,
                subrole: kAXSecureTextFieldSubrole as String
            )
        )
    }

    func testOrdinaryTextRolesAreWritable() {
        XCTAssertTrue(InsertionPolicy.isWritableTextRole(role: kAXTextFieldRole as String, subrole: nil))
        XCTAssertTrue(InsertionPolicy.isWritableTextRole(role: kAXTextAreaRole as String, subrole: nil))
        XCTAssertTrue(InsertionPolicy.isWritableTextRole(role: kAXComboBoxRole as String, subrole: nil))
    }

    func testNonTextRolesAreNotWritable() {
        XCTAssertFalse(InsertionPolicy.isWritableTextRole(role: kAXButtonRole as String, subrole: nil))
        XCTAssertFalse(InsertionPolicy.isWritableTextRole(role: nil, subrole: nil))
    }

    // MARK: - Apps where Accessibility writes go to the wrong place

    func testTerminalEmulatorsGetThePastePath() {
        XCTAssertTrue(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "com.apple.Terminal"))
        XCTAssertTrue(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "com.googlecode.iterm2"))
        XCTAssertTrue(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "com.mitchellh.ghostty"))
    }

    func testEveryJetBrainsIdeGetsThePastePath() {
        // Claude Code running in the WebStorm terminal is the case that started this: an AX write
        // is accepted by the Swing text area and never reaches the pty.
        XCTAssertTrue(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "com.jetbrains.WebStorm"))
        XCTAssertTrue(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "com.jetbrains.pycharm"))
    }

    func testEditorsWithAnEmbeddedTerminalGetThePastePath() {
        XCTAssertTrue(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "com.microsoft.VSCode"))
        XCTAssertTrue(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "com.todesktop.230313mzl4w4u92"))
    }

    func testOrdinaryAppsKeepTheAccessibilityPath() {
        XCTAssertFalse(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "com.apple.Notes"))
        XCTAssertFalse(InsertionPolicy.prefersPasteOverAccessibility(bundleId: "ru.keepcoder.Telegram"))
        XCTAssertFalse(InsertionPolicy.prefersPasteOverAccessibility(bundleId: nil))
        XCTAssertFalse(InsertionPolicy.prefersPasteOverAccessibility(bundleId: ""))
    }

    func testTerminalDetectionFallsBackToTheElementDescription() {
        XCTAssertTrue(
            InsertionPolicy.looksLikeTerminal(roleDescription: "terminal", description: nil, identifier: nil)
        )
        XCTAssertTrue(
            InsertionPolicy.looksLikeTerminal(roleDescription: nil, description: "Terminal output", identifier: nil)
        )
        XCTAssertTrue(
            InsertionPolicy.looksLikeTerminal(roleDescription: nil, description: nil, identifier: "TerminalPanel")
        )
        XCTAssertFalse(
            InsertionPolicy.looksLikeTerminal(roleDescription: "text area", description: "Message", identifier: nil)
        )
        XCTAssertFalse(InsertionPolicy.looksLikeTerminal(roleDescription: nil, description: nil, identifier: nil))
    }

    // MARK: - Target app plans

    private func snapshot(pid: pid_t, bundleId: String?) -> TargetAppSnapshot {
        TargetAppSnapshot(pid: pid, bundleId: bundleId, localizedName: bundleId, capturedAtUptime: 0)
    }

    func testSameAppGetsTheInsertion() {
        let target = snapshot(pid: 101, bundleId: "com.apple.Notes")
        XCTAssertEqual(
            TargetApp.plan(behavior: .pasteOnlyIfSameApp, target: target, current: target),
            .insertIntoOriginalTarget
        )
    }

    func testSameBundleIdWithADifferentPidCountsAsTheSameApp() {
        let target = snapshot(pid: 101, bundleId: "com.google.Chrome")
        let current = snapshot(pid: 777, bundleId: "com.google.Chrome")
        XCTAssertEqual(
            TargetApp.plan(behavior: .pasteOnlyIfSameApp, target: target, current: current),
            .insertIntoOriginalTarget
        )
    }

    func testChangedAppFallsBackToClipboardUnderTheDefaultBehaviour() {
        let target = snapshot(pid: 101, bundleId: "com.apple.Notes")
        let current = snapshot(pid: 202, bundleId: "com.apple.Safari")
        XCTAssertEqual(
            TargetApp.plan(behavior: .pasteOnlyIfSameApp, target: target, current: current),
            .clipboardOnly
        )
    }

    func testChangedAppIsPastedIntoWhenTheUserAskedForThat() {
        let target = snapshot(pid: 101, bundleId: "com.apple.Notes")
        let current = snapshot(pid: 202, bundleId: "com.apple.Safari")
        XCTAssertEqual(
            TargetApp.plan(behavior: .pasteIntoCurrentApp, target: target, current: current),
            .insertIntoCurrentApp
        )
    }

    func testClipboardOnlyBehaviourNeverInserts() {
        let target = snapshot(pid: 101, bundleId: "com.apple.Notes")
        XCTAssertEqual(
            TargetApp.plan(behavior: .clipboardOnly, target: target, current: target),
            .clipboardOnly
        )
    }

    func testUnknownTargetFallsBackToClipboard() {
        let current = snapshot(pid: 202, bundleId: "com.apple.Safari")
        XCTAssertEqual(
            TargetApp.plan(behavior: .pasteOnlyIfSameApp, target: nil, current: current),
            .clipboardOnly
        )
    }

    func testNothingInFrontFallsBackToClipboard() {
        let target = snapshot(pid: 101, bundleId: "com.apple.Notes")
        XCTAssertEqual(
            TargetApp.plan(behavior: .pasteIntoCurrentApp, target: target, current: nil),
            .clipboardOnly
        )
    }
}
