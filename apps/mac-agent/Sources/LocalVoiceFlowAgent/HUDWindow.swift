import AppKit
import Foundation

/// What the HUD is currently telling the user.
public enum HUDState: Equatable, Sendable {
    case hidden
    case recording(locked: Bool)
    case transcribing
    /// The LLM is working; `transcript` is what Whisper heard, shown so the user can verify
    /// their words before anything is inserted.
    case improving(transcript: String?)
    /// Insertion done; `text` is what actually went into the target field.
    case inserted(text: String?)
    case copiedToClipboard(reason: String?, text: String?)
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

    /// Compact capsule for status-only states; wide once a transcript is on screen.
    private static let compactWidth: CGFloat = 260
    private static let wideWidth: CGFloat = 460
    private static let baseHeight: CGFloat = 62
    private static let horizontalInset: CGFloat = 14
    private static let transcriptFont = NSFont.systemFont(ofSize: 12.5)
    private static let transcriptMaxLines = 3

    private var panel: HUDPanel?
    private var statusLabel: NSTextField?
    private var detailLabel: NSTextField?
    private var transcriptLabel: NSTextField?
    private var indicator: NSView?
    private var levelTrack: NSView?
    private var levelBar: NSView?
    private var levelWidthConstraint: NSLayoutConstraint?

    private var state: HUDState = .hidden
    private var durationTimer: Timer?
    private var autoHideTimer: Timer?
    private var recordingStartedAt: Date?
    /// Invalidates an in-flight fade-out when a new show() lands mid-animation, so the
    /// completion of the old fade cannot orderOut the freshly presented panel.
    private var fadeGeneration = 0

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
            setTranscript(nil)
            setLevelTrackVisible(true)
            startDurationTimer()

        case .transcribing:
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = "Распознаю речь"
            detailLabel?.stringValue = elapsedDetail()
            setIndicatorColor(.systemOrange)
            setLevel(0)
            setTranscript(nil)
            setLevelTrackVisible(false)

        case .improving(let transcript):
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = "Улучшаю текст"
            detailLabel?.stringValue = elapsedDetail()
            setIndicatorColor(.systemBlue)
            setLevel(0)
            setTranscript(transcript)
            setLevelTrackVisible(false)

        case .inserted(let text):
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = "Вставлено"
            detailLabel?.stringValue = elapsedDetail()
            setIndicatorColor(.systemGreen)
            setLevel(0)
            setTranscript(text)
            setLevelTrackVisible(false)
            // Long enough to read back a phrase, short enough not to linger.
            scheduleAutoHide(after: text == nil ? 1.2 : 2.4)

        case .copiedToClipboard(let reason, let text):
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = reason ?? "Скопировано в буфер"
            detailLabel?.stringValue = "⌘V — вставить"
            setIndicatorColor(.systemGreen)
            setLevel(0)
            setTranscript(text)
            setLevelTrackVisible(false)
            scheduleAutoHide(after: 2.5)

        case .error(let message):
            stopDurationTimer()
            ensurePanel()
            statusLabel?.stringValue = "Ошибка"
            detailLabel?.stringValue = String(message.prefix(90))
            setIndicatorColor(.systemRed)
            setLevel(0)
            setTranscript(nil)
            setLevelTrackVisible(false)
            scheduleAutoHide(after: 4.0)
        }

        if case .recording = newState {
            setIndicatorPulsing(true)
        } else {
            setIndicatorPulsing(false)
        }
        presentPanel()
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
        state = .hidden
        guard let panel, panel.isVisible else { return }
        fadeGeneration += 1
        let generation = fadeGeneration
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.12
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.fadeGeneration == generation else { return }
                panel.orderOut(nil)
            }
        })
    }

    /// Puts the panel on screen: instantly sized, faded in when it was not visible,
    /// resized with a short animation when it already was.
    private func presentPanel() {
        guard let panel else { return }
        fadeGeneration += 1
        let appearing = !panel.isVisible || panel.alphaValue < 1
        layoutPanel(animated: !appearing)
        if appearing {
            // A brand-new presentation starts transparent; a show() that interrupts a
            // fade-out picks the alpha up from wherever the fade left it.
            if !panel.isVisible { panel.alphaValue = 0 }
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.14
                panel.animator().alphaValue = 1
            }
        } else {
            panel.orderFrontRegardless()
        }
    }

    // MARK: - Panel construction

    private func ensurePanel() {
        if panel != nil { return }

        let contentRect = NSRect(x: 0, y: 0, width: Self.compactWidth, height: Self.baseHeight)
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
        blur.autoresizingMask = [.width, .height]

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

        let transcript = NSTextField(wrappingLabelWithString: "")
        transcript.font = Self.transcriptFont
        transcript.textColor = .labelColor
        transcript.isSelectable = false
        transcript.maximumNumberOfLines = Self.transcriptMaxLines
        transcript.cell?.truncatesLastVisibleLine = true
        transcript.translatesAutoresizingMaskIntoConstraints = false
        transcript.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

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
        blur.addSubview(transcript)
        blur.addSubview(levelTrack)
        levelTrack.addSubview(level)

        let levelWidth = level.widthAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: Self.horizontalInset),
            dot.centerYAnchor.constraint(equalTo: status.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 10),
            dot.heightAnchor.constraint(equalToConstant: 10),

            status.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            status.trailingAnchor.constraint(lessThanOrEqualTo: blur.trailingAnchor, constant: -Self.horizontalInset),
            status.topAnchor.constraint(equalTo: blur.topAnchor, constant: 12),

            detail.leadingAnchor.constraint(equalTo: status.leadingAnchor),
            detail.trailingAnchor.constraint(lessThanOrEqualTo: blur.trailingAnchor, constant: -Self.horizontalInset),
            detail.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 2),

            transcript.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: Self.horizontalInset),
            transcript.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -Self.horizontalInset),
            transcript.topAnchor.constraint(equalTo: detail.bottomAnchor, constant: 6),

            levelTrack.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: Self.horizontalInset),
            levelTrack.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -Self.horizontalInset),
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
        transcriptLabel = transcript
        indicator = dot
        self.levelTrack = levelTrack
        levelBar = level
        levelWidthConstraint = levelWidth
    }

    /// Sizes the panel to its current content and re-centres it at the bottom of the screen.
    /// Animated when the panel is already on screen, so the compact→wide growth glides
    /// instead of snapping; instant while appearing, so the fade-in shows the final shape.
    private func layoutPanel(animated: Bool) {
        guard let panel else { return }
        let text = transcriptLabel?.stringValue ?? ""
        let width = text.isEmpty ? Self.compactWidth : Self.wideWidth
        var height = Self.baseHeight
        if !text.isEmpty {
            height += Self.transcriptHeight(text, width: width - Self.horizontalInset * 2) + 6
        }

        let screen = NSScreen.main ?? NSScreen.screens.first
        guard let screenFrame = screen?.visibleFrame else {
            panel.setContentSize(NSSize(width: width, height: height))
            return
        }
        // The panel is borderless, so the frame and the content rect coincide.
        let target = NSRect(
            x: screenFrame.midX - width / 2,
            y: screenFrame.minY + 96,
            width: width,
            height: height
        )

        if animated, panel.frame != target {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(target, display: true)
            }
        } else {
            panel.setFrame(target, display: true)
        }
    }

    static func transcriptHeight(_ text: String, width: CGFloat) -> CGFloat {
        let bounding = (text as NSString).boundingRect(
            with: NSSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: transcriptFont]
        )
        let lineHeight = ceil(transcriptFont.ascender - transcriptFont.descender + transcriptFont.leading)
        return min(ceil(bounding.height), lineHeight * CGFloat(transcriptMaxLines) + 2)
    }

    private func setTranscript(_ text: String?) {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        transcriptLabel?.stringValue = trimmed
        transcriptLabel?.isHidden = trimmed.isEmpty
    }

    private func setLevelTrackVisible(_ visible: Bool) {
        levelTrack?.isHidden = !visible
    }

    private func setIndicatorColor(_ color: NSColor) {
        indicator?.layer?.backgroundColor = color.cgColor
    }

    /// A slow opacity pulse on the dot while recording — the one state where "is it
    /// actually listening?" matters and a static dot reads as frozen.
    private func setIndicatorPulsing(_ pulsing: Bool) {
        guard let layer = indicator?.layer else { return }
        if pulsing {
            guard layer.animation(forKey: Self.pulseAnimationKey) == nil else { return }
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1.0
            pulse.toValue = 0.35
            pulse.duration = 0.7
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer.add(pulse, forKey: Self.pulseAnimationKey)
        } else {
            layer.removeAnimation(forKey: Self.pulseAnimationKey)
        }
    }

    private static let pulseAnimationKey = "lvf.pulse"

    private func setLevel(_ level: Float) {
        guard let constraint = levelWidthConstraint, let track = levelBar?.superview else { return }
        let clamped = CGFloat(max(0, min(1, level)))
        // Compress the range: speech rarely peaks above ~0.5, so a linear bar barely moves.
        let scaled = min(1, sqrt(clamped) * 1.35)
        // Levels arrive at ~23 Hz (2048-sample buffers); a short ease between readings
        // turns the stepping into a glide.
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.09
            constraint.animator().constant = track.bounds.width * scaled
        }
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
