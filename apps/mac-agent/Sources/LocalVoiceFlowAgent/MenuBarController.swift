import AppKit
import Foundation

/// Everything the menu bar needs to render itself.
public struct MenuStatus: Equatable, Sendable {
    public var serviceEnabled: Bool
    public var coreReachable: Bool
    public var sttReady: Bool
    public var sttState: String
    public var permissions: PermissionSnapshot
    public var fnTapActive: Bool
    public var fnTapError: String?
    public var fallbackDisplay: String?
    public var isRecording: Bool
    public var lastError: String?

    /// Permissions that actually block dictation right now.
    ///
    /// A live event tap is stronger evidence than `IOHIDCheckAccess`, which answers for the
    /// calling binary's own TCC identity and can say "denied" while the tap is happily running
    /// (unbundled builds, where the responsible process holds the grant).
    public var missingPermissions: [String] {
        var missing: [String] = []
        if permissions.microphone != .granted { missing.append("Микрофон") }
        if !fnTapActive, permissions.inputMonitoring != .granted { missing.append("Мониторинг ввода") }
        return missing
    }

    /// Single line shown at the top of the menu.
    public var summary: String {
        if !serviceEnabled { return "Выключено" }
        if !coreReachable { return "Core недоступен" }
        if isRecording { return "Идёт запись" }
        if !missingPermissions.isEmpty {
            return "Нет разрешений: \(missingPermissions.joined(separator: ", "))"
        }
        if !fnTapActive {
            return fallbackDisplay.map { "Fn недоступен — используйте \($0)" } ?? "Fn недоступен"
        }
        if !sttReady { return "STT: \(sttState)" }
        return "Готов"
    }

    /// SF Symbol used as a template image in the status bar.
    public var symbolName: String {
        if !serviceEnabled { return "mic.slash" }
        if isRecording { return "mic.fill" }
        if !coreReachable || !missingPermissions.isEmpty || !fnTapActive { return "exclamationmark.triangle" }
        return "mic"
    }
}

@MainActor
public protocol MenuBarDelegate: AnyObject {
    func menuBarDidToggleService()
    func menuBarDidRequestDashboard()
    /// Refresh only — the menu opens constantly, so this must never prompt.
    func menuBarWillOpen()
    func menuBarDidRequestPermissionCheck()
    /// Opens the window that walks through the three macOS grants.
    func menuBarDidRequestOnboarding()
    func menuBarDidRequestRestart()
    func menuBarDidRequestQuit()
    func menuBarDidRequestOpenSettingsPane(_ pane: Permissions.SettingsPane)
}

@MainActor
public final class MenuBarController: NSObject, NSMenuDelegate {
    public weak var delegate: MenuBarDelegate?

    private let statusItem: NSStatusItem
    private let menu = NSMenu()
    private var status = MenuStatus(
        serviceEnabled: true,
        coreReachable: false,
        sttReady: false,
        sttState: "starting",
        permissions: PermissionSnapshot(microphone: .unknown, accessibility: .unknown, inputMonitoring: .unknown),
        fnTapActive: false,
        fnTapError: nil,
        fallbackDisplay: nil,
        isRecording: false,
        lastError: nil
    )

    override public init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        menu.delegate = self
        statusItem.menu = menu
        statusItem.button?.imagePosition = .imageOnly
        rebuild()
    }

    public func update(_ newStatus: MenuStatus) {
        guard newStatus != status else { return }
        status = newStatus
        rebuild()
    }

    private func rebuild() {
        if let button = statusItem.button {
            let image = NSImage(
                systemSymbolName: status.symbolName,
                accessibilityDescription: "LocalVoiceFlow"
            )
            image?.isTemplate = true
            button.image = image
            button.toolTip = "LocalVoiceFlow — \(status.summary)"
        }

        menu.removeAllItems()

        let header = NSMenuItem(title: status.summary, action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        if let error = status.lastError, !error.isEmpty {
            let item = NSMenuItem(title: "Последняя ошибка: \(String(error.prefix(80)))", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        if !status.fnTapActive, let reason = status.fnTapError {
            let item = NSMenuItem(title: "Fn: \(reason)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
        if let fallback = status.fallbackDisplay {
            let item = NSMenuItem(title: "Резервное сочетание: \(fallback)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(.separator())

        let toggle = NSMenuItem(
            title: status.serviceEnabled ? "Остановить сервис" : "Запустить сервис",
            action: #selector(toggleService),
            keyEquivalent: ""
        )
        toggle.target = self
        menu.addItem(toggle)

        let dashboard = NSMenuItem(title: "Открыть панель управления", action: #selector(openDashboard), keyEquivalent: "")
        dashboard.target = self
        menu.addItem(dashboard)

        menu.addItem(.separator())
        menu.addItem(permissionsSubmenuItem())

        let setup = NSMenuItem(title: "Настроить разрешения…", action: #selector(openOnboarding), keyEquivalent: "")
        setup.target = self
        menu.addItem(setup)

        let check = NSMenuItem(title: "Проверить разрешения", action: #selector(checkPermissions), keyEquivalent: "")
        check.target = self
        menu.addItem(check)

        let restart = NSMenuItem(title: "Перезапустить", action: #selector(restart), keyEquivalent: "")
        restart.target = self
        menu.addItem(restart)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Выйти", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func permissionsSubmenuItem() -> NSMenuItem {
        let parent = NSMenuItem(title: "Разрешения", action: nil, keyEquivalent: "")
        let submenu = NSMenu()

        func add(_ title: String, _ state: PermissionState, _ pane: Permissions.SettingsPane) {
            let mark = state == .granted ? "✓" : "✗"
            let item = NSMenuItem(
                title: "\(mark) \(title): \(state.localizedLabel)",
                action: #selector(openPermissionPane(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = pane.rawValue
            submenu.addItem(item)
        }

        add("Микрофон", status.permissions.microphone, .microphone)
        add("Универсальный доступ", status.permissions.accessibility, .accessibility)
        add("Мониторинг ввода", status.permissions.inputMonitoring, .inputMonitoring)

        parent.submenu = submenu
        return parent
    }

    // MARK: - Actions

    @objc private func toggleService() { delegate?.menuBarDidToggleService() }
    @objc private func openDashboard() { delegate?.menuBarDidRequestDashboard() }
    @objc private func openOnboarding() {
        delegate?.menuBarDidRequestOnboarding()
    }

    @objc private func checkPermissions() { delegate?.menuBarDidRequestPermissionCheck() }
    @objc private func restart() { delegate?.menuBarDidRequestRestart() }
    @objc private func quit() { delegate?.menuBarDidRequestQuit() }

    @objc private func openPermissionPane(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let pane = Permissions.SettingsPane(rawValue: raw)
        else { return }
        delegate?.menuBarDidRequestOpenSettingsPane(pane)
    }

    // MARK: - NSMenuDelegate

    public func menuWillOpen(_ menu: NSMenu) {
        delegate?.menuBarWillOpen()
    }
}
