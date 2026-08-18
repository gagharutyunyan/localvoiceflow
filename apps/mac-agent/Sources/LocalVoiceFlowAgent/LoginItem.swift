import AppKit
import Foundation
import ServiceManagement

/// Starting with the Mac, without a LaunchAgent plist.
///
/// The LaunchAgent that `scripts/install.sh` writes runs *core* — the menu-bar app itself was
/// never under launchd, so after a reboot the icon simply was not there and dictation silently
/// did not work until someone opened the app by hand.
///
/// `SMAppService.mainApp` is the modern answer and a better one than a second plist: macOS lists
/// the app under System Settings → General → Login Items, where the user can turn it off in the
/// place they would look for it anyway. A hand-written plist is invisible there.
///
/// TCC survives this: launchd starts the bundle, so the code identity — and with it every
/// granted permission — is the same one the user approved.
public enum LoginItem {
    /// Set once the user has expressed a preference, so a deliberate "off" is never overridden
    /// by the automatic registration on the next launch.
    private static let userChoiceKey = "loginItemUserChoice"
    /// Set after the app has registered itself once. Without it, a user who switches the item
    /// off in System Settings — where our menu never learns about it — would find it switched
    /// back on at the next launch.
    private static let autoRegisteredKey = "loginItemAutoRegistered"

    public enum Availability {
        case enabled
        case disabled
        /// The user has to approve the item in System Settings (macOS asks after a fresh install).
        case requiresApproval
        /// Not applicable: the binary is running unbundled, e.g. under `swift run`.
        case unavailable
    }

    public static var status: Availability {
        guard isBundled else { return .unavailable }
        switch SMAppService.mainApp.status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notRegistered, .notFound: return .disabled
        @unknown default: return .disabled
        }
    }

    public static var isEnabled: Bool { status == .enabled }

    private static var isBundled: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
    }

    /// Registers on first launch unless the user has already said no.
    ///
    /// Doing this without asking is a deliberate choice: a dictation tool that is not running
    /// cannot be summoned by a hotkey, so an app that does not come back after a reboot reads as
    /// broken. The menu keeps a visible switch, and so does System Settings.
    public static func registerIfFirstRun() {
        guard isBundled else { return }
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: userChoiceKey) == nil else { return }
        guard !defaults.bool(forKey: autoRegisteredKey) else { return }
        defaults.set(true, forKey: autoRegisteredKey)
        setEnabled(true, remembersChoice: false)
    }

    @discardableResult
    public static func setEnabled(_ enabled: Bool, remembersChoice: Bool = true) -> Bool {
        guard isBundled else { return false }
        if remembersChoice {
            UserDefaults.standard.set(enabled, forKey: userChoiceKey)
        }

        do {
            if enabled {
                // Registering an already-registered service throws; the state we want is the
                // state we already have, so that particular failure is success.
                if SMAppService.mainApp.status != .enabled {
                    try SMAppService.mainApp.register()
                    AgentLog.info("login item enabled")
                }
            } else {
                try SMAppService.mainApp.unregister()
                AgentLog.info("login item disabled")
            }
            return true
        } catch {
            AgentLog.warn("login item \(enabled ? "registration" : "removal") failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Opens the Login Items list, for the case where macOS wants an explicit approval.
    public static func openSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
    }
}
