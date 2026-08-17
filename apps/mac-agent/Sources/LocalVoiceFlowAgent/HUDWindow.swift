import AppKit
import Foundation

/// What the HUD is currently telling the user.
public enum HUDState: Equatable, Sendable {
    case hidden
    case recording(locked: Bool)
    case transcribing
    case improving
    case inserted
    case copiedToClipboard(reason: String?)
    case error(String)
}

/// A borderless, non-activating panel that floats above everything and never steals focus.
///
/// Focus is the whole point: the user is dictating *into* another app, so this window must not
/// become key, must not activate the agent, and must not swallow clicks.
final class HUDPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
public final class HUDController {
    public var isEnabled = true

    private var panel: HUDPanel?
    private var statusLabel: NSTextField?
    private var detailLabel: NSTextField?
    private var indicator: NSView?
    private var levelBar: NSView?
    private var levelWidthConstraint: NSLayoutConstraint?

    private var state: HUDState = .hidden
    private var durationTimer: Timer?
    private var autoHideTimer: Timer?
    private var recordingStartedAt: Date?

    public init() {}

    public func show(_ newState: HUDState) {
        guard isEnabled || newState == .hidden else { return }
        let previous = state
        state = newState
        autoHideTimer?.invalidate()
        autoHideTimer = nil

        switch newState {
        case .hidden:
            stopDurationTimer()
            hide()
            return

        case .recording(let locked):
            // Switching push-to-talk -> locked continues the same capture, so the clock must not
            // start over.
            if case .recording = previous {} else { recordingStartedAt = Date() }
            ensurePanel()
            statusLabel?.stringValue = locked ? "Запись (фиксация)" : "Запись"
            detailLabel?.stringValue = "0:00"
            setIndicatorColor(.systemRed)
            startDurationTimer()

        case .transcribing:
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = "Распознаю речь"
            detailLabel?.stringValue = elapsedDetail()
            setIndicatorColor(.systemOrange)
            setLevel(0)

        case .improving:
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = "Улучшаю текст"
            detailLabel?.stringValue = elapsedDetail()
            setIndicatorColor(.systemBlue)
            setLevel(0)

        case .inserted:
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = "Вставлено"
            detailLabel?.stringValue = elapsedDetail()
            setIndicatorColor(.systemGreen)
            setLevel(0)
            scheduleAutoHide(after: 1.2)

        case .copiedToClipboard(let reason):
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = reason ?? "Скопировано в буфер"
            detailLabel?.stringValue = "⌘V — вставить"
            setIndicatorColor(.systemGreen)
            setLevel(0)
            scheduleAutoHide(after: 2.5)

        case .error(let message):
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = "Ошибка"
            detailLabel?.stringValue = String(message.prefix(90))
            setIndicatorColor(.systemRed)
            setLevel(0)
            scheduleAutoHide(after: 4.0)
        }

        position()
        panel?.orderFrontRegardless()
    }

    /// Live microphone level, 0...1.
    public func updateLevel(_ level: Float) {
        guard case .recording = state else { return }
        setLevel(level)
    }

    public func hide() {
        stopDurationTimer()
        autoHideTimer?.invalidate()
        autoHideTimer = nil
        panel?.orderOut(nil)
        state = .hidden
    }

    // MARK: - Panel construction

    private func ensurePanel() {
        if panel != nil { return }

        let contentRect = NSRect(x: 0, y: 0, width: 260, height: 62)
        let panel = HUDPanel(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none

        let blur = NSVisualEffectView(frame: contentRect)
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 14
        blur.layer?.masksToBounds = true
        blur.translatesAutoresizingMaskIntoConstraints = false

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 5
        dot.layer?.backgroundColor = NSColor.systemRed.cgColor
        dot.translatesAutoresizingMaskIntoConstraints = false

        let status = NSTextField(labelWithString: "")
        status.font = .systemFont(ofSize: 13, weight: .semibold)
        status.textColor = .labelColor
        status.lineBreakMode = .byTruncatingTail
        status.translatesAutoresizingMaskIntoConstraints = false

        let detail = NSTextField(labelWithString: "")
        detail.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        detail.translatesAutoresizingMaskIntoConstraints = false

        let levelTrack = NSView()
        levelTrack.wantsLayer = true
        levelTrack.layer?.cornerRadius = 2
        levelTrack.layer?.backgroundColor = NSColor.separatorColor.cgColor
        levelTrack.translatesAutoresizingMaskIntoConstraints = false

        let level = NSView()
        level.wantsLayer = true
        level.layer?.cornerRadius = 2
        level.layer?.backgroundColor = NSColor.systemGreen.cgColor
        level.translatesAutoresizingMaskIntoConstraints = false

        panel.contentView = blur
        blur.addSubview(dot)
        blur.addSubview(status)
        blur.addSubview(detail)
        blur.addSubview(levelTrack)
        levelTrack.addSubview(level)

        let levelWidth = level.widthAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 14),
            dot.centerYAnchor.constraint(equalTo: status.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 10),
            dot.heightAnchor.constraint(equalToConstant: 10),

            status.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            status.trailingAnchor.constraint(lessThanOrEqualTo: blur.trailingAnchor, constant: -14),
            status.topAnchor.constraint(equalTo: blur.topAnchor, constant: 12),

            detail.leadingAnchor.constraint(equalTo: status.leadingAnchor),
            detail.trailingAnchor.constraint(lessThanOrEqualTo: blur.trailingAnchor, constant: -14),
            detail.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 2),

            levelTrack.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 14),
            levelTrack.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -14),
            levelTrack.bottomAnchor.constraint(equalTo: blur.bottomAnchor, constant: -10),
            levelTrack.heightAnchor.constraint(equalToConstant: 4),

            level.leadingAnchor.constraint(equalTo: levelTrack.leadingAnchor),
            level.topAnchor.constraint(equalTo: levelTrack.topAnchor),
            level.bottomAnchor.constraint(equalTo: levelTrack.bottomAnchor),
            levelWidth,
        ])

        self.panel = panel
        statusLabel = status
        detailLabel = detail
        indicator = dot
        levelBar = level
        levelWidthConstraint = levelWidth
    }

    private func position() {
        guard let panel else { return }
        let screen = NSScreen.main ?? NSScreen.screens.first
        guard let frame = screen?.visibleFrame else { return }
        let size = panel.frame.size
        let origin = NSPoint(
            x: frame.midX - size.width / 2,
            y: frame.minY + 96
        )
        panel.setFrameOrigin(origin)
    }

    private func setIndicatorColor(_ color: NSColor) {
        indicator?.layer?.backgroundColor = color.cgColor
    }

    private func setLevel(_ level: Float) {
        guard let constraint = levelWidthConstraint, let track = levelBar?.superview else { return }
        let clamped = CGFloat(max(0, min(1, level)))
        // Compress the range: speech rarely peaks above ~0.5, so a linear bar barely moves.
        let scaled = min(1, sqrt(clamped) * 1.35)
        constraint.constant = track.bounds.width * scaled
    }

    private func elapsedDetail() -> String {
        guard let recordingStartedAt else { return "" }
        return Self.formatDuration(Date().timeIntervalSince(recordingStartedAt))
    }

    nonisolated static func formatDuration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    private func startDurationTimer() {
        durationTimer?.invalidate()
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let started = self.recordingStartedAt else { return }
                self.detailLabel?.stringValue = Self.formatDuration(Date().timeIntervalSince(started))
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        durationTimer = timer
    }

    private func stopDurationTimer() {
        durationTimer?.invalidate()
        durationTimer = nil
    }

    private func scheduleAutoHide(after seconds: TimeInterval) {
        autoHideTimer?.invalidate()
        let timer = Timer(timeInterval: seconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.hide() }
        }
        RunLoop.main.add(timer, forMode: .common)
        autoHideTimer = timer
    }
}
