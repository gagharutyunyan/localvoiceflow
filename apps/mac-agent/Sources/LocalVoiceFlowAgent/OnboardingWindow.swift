import AppKit
import Foundation

/// The first-run window: three permissions, one button each, and nothing else.
///
/// It replaces a terminal wizard that had to wipe TCC entries and relaunch the app every twenty
/// seconds. That wizard existed because an ad-hoc signature invalidated every grant on each
/// rebuild; with a stable signing identity the grants are permanent, so what is left is asking
/// macOS once — which a window with three buttons does far better than a script does.
@MainActor
public final class OnboardingController: NSObject, NSWindowDelegate {
    /// Fired when the user asks to relaunch, which Input Monitoring makes unavoidable.
    public var onRestartRequested: (() -> Void)?

    private var window: NSWindow?
    private var pollTimer: Timer?
    private var rows: [PermissionKind: PermissionRowView] = [:]
    private var summaryLabel: NSTextField?
    private var primaryButton: NSButton?

    /// `IOHIDCheckAccess` answers from a per-process cache, so a grant given after launch stays
    /// invisible to this process. Recorded at launch to know whether a relaunch is owed.
    private var inputMonitoringAtLaunch: PermissionState = .unknown
    private var didCaptureLaunchState = false

    // MARK: - The three permissions

    enum PermissionKind: CaseIterable {
        case microphone
        case inputMonitoring
        case accessibility

        var title: String {
            switch self {
            case .microphone: return "Микрофон"
            case .inputMonitoring: return "Мониторинг ввода"
            case .accessibility: return "Универсальный доступ"
            }
        }

        var explanation: String {
            switch self {
            case .microphone: return "Записать голос. Звук не покидает этот компьютер."
            case .inputMonitoring: return "Поймать нажатие клавиши Fn в любом приложении."
            case .accessibility: return "Вставить готовый текст туда, где стоит курсор."
            }
        }

        var pane: Permissions.SettingsPane {
            switch self {
            case .microphone: return .microphone
            case .inputMonitoring: return .inputMonitoring
            case .accessibility: return .accessibility
            }
        }

        func state(from snapshot: PermissionSnapshot) -> PermissionState {
            switch self {
            case .microphone: return snapshot.microphone
            case .inputMonitoring: return snapshot.inputMonitoring
            case .accessibility: return snapshot.accessibility
            }
        }
    }

    // MARK: - Showing

    public func show() {
        captureLaunchStateIfNeeded()

        if window == nil { window = buildWindow() }
        guard let window else { return }

        refresh()
        // A menu-bar app is `.accessory`, and an accessory app cannot own a key window. Becoming
        // `.regular` for the duration of the window is what lets the user type into it and see it
        // in ⌘-Tab; the policy goes back when the window closes.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        startPolling()
        AgentLog.info("onboarding window shown")
    }

    public func close() {
        window?.close()
    }

    /// True while some permission is still missing — the caller uses it to decide whether the
    /// window should come up on launch at all.
    public static var isNeeded: Bool {
        !Permissions.snapshot().allGranted
    }

    private func captureLaunchStateIfNeeded() {
        guard !didCaptureLaunchState else { return }
        didCaptureLaunchState = true
        inputMonitoringAtLaunch = Permissions.inputMonitoring()
    }

    // MARK: - Building the window

    private func buildWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 400),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "LocalVoiceFlow"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 28, bottom: 24, right: 28)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let heading = NSTextField(labelWithString: "Три разрешения — и можно диктовать")
        heading.font = .systemFont(ofSize: 19, weight: .semibold)
        stack.addArrangedSubview(heading)

        let subtitle = NSTextField(wrappingLabelWithString:
            "Их выдаёт сама macOS — программа не может сделать это за вас. "
            + "Нажмите «Разрешить», и система откроет нужный список.")
        subtitle.font = .systemFont(ofSize: 12.5)
        subtitle.textColor = .secondaryLabelColor
        subtitle.preferredMaxLayoutWidth = 464
        stack.addArrangedSubview(subtitle)

        for kind in PermissionKind.allCases {
            let row = PermissionRowView(kind: kind) { [weak self] in
                self?.request(kind)
            }
            rows[kind] = row
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -56).isActive = true
        }

        let separator = NSBox()
        separator.boxType = .separator
        stack.addArrangedSubview(separator)
        separator.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -56).isActive = true

        let summary = NSTextField(wrappingLabelWithString: "")
        summary.font = .systemFont(ofSize: 12.5)
        summary.preferredMaxLayoutWidth = 464
        summaryLabel = summary
        stack.addArrangedSubview(summary)

        let button = NSButton(title: "Готово", target: self, action: #selector(primaryAction))
        button.bezelStyle = .rounded
        button.keyEquivalent = "\r"
        primaryButton = button
        stack.addArrangedSubview(button)

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        window.contentView = content
        window.setContentSize(content.fittingSize)
        window.center()
        return window
    }

    // MARK: - Asking macOS

    /// One button, two possible outcomes: the system prompt when macOS is still willing to show
    /// it, and the Settings pane when it is not. Trying the prompt first matters — it is the only
    /// path that costs the user a single click, and macOS shows it exactly once per permission.
    ///
    /// The request also has a side effect worth keeping: `IOHIDRequestAccess` and
    /// `AXIsProcessTrustedWithOptions` are what *put the app into the Input Monitoring and
    /// Accessibility lists*. Merely checking (`IOHIDCheckAccess` / `AXIsProcessTrusted`) never
    /// creates the row, so a user sent straight to the pane would find nothing to switch on.
    private func request(_ kind: PermissionKind) {
        // Never both at once. macOS's own dialog already carries an "Open System Settings"
        // button, so opening the pane alongside it throws two windows at the user for one click.
        // The pane is for the second press, once macOS has stopped offering the dialog.
        let askedBefore = hasAskedBefore(kind)
        markAsked(kind)

        switch kind {
        case .microphone:
            Permissions.requestMicrophone { [weak self] state in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if state != .granted, askedBefore { Permissions.openSettings(kind.pane) }
                    self.refresh()
                }
            }

        case .inputMonitoring:
            let state = Permissions.requestInputMonitoring()
            if state != .granted, askedBefore { Permissions.openSettings(kind.pane) }
            refresh()

        case .accessibility:
            let state = Permissions.requestAccessibility(prompt: !askedBefore)
            if state != .granted, askedBefore { Permissions.openSettings(kind.pane) }
            refresh()
        }
    }

    /// Whether this app has already raised the system dialog for a permission.
    ///
    /// This is what removes the "drag the app into the list" step. The row in System Settings is
    /// created by the *request* — `AXIsProcessTrustedWithOptions(prompt: true)` and
    /// `IOHIDRequestAccess` — never by checking, and never by opening the pane. So the first
    /// press always asks, which puts the row there; only afterwards does the button send the
    /// user to a list that is guaranteed to contain LocalVoiceFlow.
    private func hasAskedBefore(_ kind: PermissionKind) -> Bool {
        UserDefaults.standard.bool(forKey: Self.askedKey(kind))
    }

    private func markAsked(_ kind: PermissionKind) {
        UserDefaults.standard.set(true, forKey: Self.askedKey(kind))
    }

    private static func askedKey(_ kind: PermissionKind) -> String {
        switch kind {
        case .microphone: return "askedMicrophone"
        case .inputMonitoring: return "askedInputMonitoring"
        case .accessibility: return "askedAccessibility"
        }
    }

    @objc private func primaryAction() {
        if relaunchNeeded {
            onRestartRequested?()
            return
        }
        close()
    }

    /// A grant that arrived after launch is invisible to this process for Input Monitoring, and
    /// the Fn event tap was created (or refused) at startup. Only a fresh process fixes both.
    private var relaunchNeeded: Bool {
        let now = Permissions.snapshot()
        guard now.allGranted else { return false }
        return inputMonitoringAtLaunch != .granted
    }

    // MARK: - Refreshing

    private func startPolling() {
        pollTimer?.invalidate()
        // The user is switching to System Settings and back; the window has to notice a flipped
        // switch on its own, because nothing notifies an app about TCC changes.
        let timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func refresh() {
        let snapshot = Permissions.snapshot()
        for kind in PermissionKind.allCases {
            rows[kind]?.update(state: kind.state(from: snapshot))
        }

        if snapshot.allGranted {
            if relaunchNeeded {
                summaryLabel?.stringValue = "Всё выдано. Осталось перезапустить приложение — "
                    + "macOS отдаёт разрешение на Fn только новому процессу."
                summaryLabel?.textColor = .labelColor
                primaryButton?.title = "Перезапустить и начать"
            } else {
                summaryLabel?.stringValue = "Всё готово. Нажмите Fn и говорите — "
                    + "или ⌃⌥Space, если Fn занята системой."
                summaryLabel?.textColor = .systemGreen
                primaryButton?.title = "Начать"
            }
        } else {
            let missing = PermissionKind.allCases
                .filter { $0.state(from: snapshot) != .granted }
                .count
            summaryLabel?.stringValue = "Осталось разрешений: \(missing) из 3. "
                + "Пока их нет, текст будет просто копироваться в буфер обмена."
            summaryLabel?.textColor = .secondaryLabelColor
            primaryButton?.title = "Закрыть"
        }
    }

    // MARK: - NSWindowDelegate

    public func windowWillClose(_ notification: Notification) {
        stopPolling()
        // Back to a menu-bar-only app: a dictation tool has no business owning a Dock icon.
        NSApp.setActivationPolicy(.accessory)
    }
}

// MARK: - One row

/// A single permission: status dot, name, one sentence of why, and the button that asks for it.
@MainActor
private final class PermissionRowView: NSView {
    private let statusDot = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private let actionButton = NSButton()
    private let onRequest: () -> Void

    init(kind: OnboardingController.PermissionKind, onRequest: @escaping () -> Void) {
        self.onRequest = onRequest
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        titleLabel.stringValue = kind.title
        titleLabel.font = .systemFont(ofSize: 13, weight: .medium)

        detailLabel.stringValue = kind.explanation
        detailLabel.font = .systemFont(ofSize: 11.5)
        detailLabel.textColor = .secondaryLabelColor

        statusDot.imageScaling = .scaleProportionallyUpOrDown

        actionButton.title = "Разрешить"
        actionButton.bezelStyle = .rounded
        actionButton.controlSize = .regular
        actionButton.target = self
        actionButton.action = #selector(buttonPressed)

        let text = NSStackView(views: [titleLabel, detailLabel])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2

        let row = NSStackView(views: [statusDot, text, actionButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            statusDot.widthAnchor.constraint(equalToConstant: 18),
            statusDot.heightAnchor.constraint(equalToConstant: 18),
            actionButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 116),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(state: PermissionState) {
        let granted = state == .granted
        let symbol = granted ? "checkmark.circle.fill" : "circle.dashed"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: state.localizedLabel)
        image?.isTemplate = true
        statusDot.image = image
        statusDot.contentTintColor = granted ? .systemGreen : .tertiaryLabelColor

        actionButton.isHidden = granted
        // "Разрешить" promises a prompt; once macOS has refused to prompt again, the honest
        // label is the one that says where the switch actually lives.
        actionButton.title = state == .denied ? "Открыть настройки" : "Разрешить"
    }

    @objc private func buttonPressed() {
        onRequest()
    }
}
