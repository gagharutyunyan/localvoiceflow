import AppKit
import Foundation

/// Wires the pieces together: hardware events -> state machine -> audio -> core -> insertion.
///
/// All of it lives on the main actor. The heavy work (audio conversion, HTTP) happens off it, but
/// every decision is taken here so there is exactly one place where the order of operations is
/// visible.
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate, MenuBarDelegate {
    private let core = CoreClient()
    private let hotkeys = HotkeyMonitor()
    private let recorder = AudioRecorder()
    private let hud = HUDController()
    private let inserter = TextInserter()
    private let machine = DictationStateMachine()

    private var menuBar: MenuBarController?
    private var config = AgentConfig()
    private var permissions = PermissionSnapshot(microphone: .unknown, accessibility: .unknown, inputMonitoring: .unknown)

    private var serviceEnabled = true
    private var coreReachable = false {
        didSet {
            // A status POST that never arrived must not be remembered as delivered.
            if !coreReachable { lastReportedStatus = nil }
        }
    }
    private var sttReady = false
    private var sttState = "starting"
    private var lastError: String?

    private var tickTimer: Timer?
    private var pollTimer: Timer?
    private var eventsTask: Task<Void, Never>?
    private var processingTask: Task<Void, Never>?
    private var bootstrapTask: Task<Void, Never>?

    private var captureTarget: TargetAppSnapshot?
    /// Cleared on delivery, failure *and* Escape-cancel: a late SSE event for a dictation that is
    /// no longer in flight must not resurrect the HUD.
    private var inFlightDictationId: String?
    /// Raw transcript of the dictation in flight, from the `transcribed` SSE event; shown in the
    /// HUD while the LLM works so the user sees their words before anything is inserted.
    private var inFlightTranscript: String?
    /// Send the user to System Settings once, not on every attempted dictation.
    private var didOfferMicrophoneSettings = false
    private var lastReportedStatus: AgentStatusPayload?

    // MARK: - NSApplicationDelegate

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // Belt and braces with LSUIElement: also correct when the binary is run unbundled.
        NSApp.setActivationPolicy(.accessory)

        AgentLog.info("LocalVoiceFlow agent \(AgentInfo.version) starting")

        let bar = MenuBarController()
        bar.delegate = self
        menuBar = bar

        machine.config = config.dictationConfig
        hud.isEnabled = config.hudEnabled

        hotkeys.onEvent = { [weak self] event in
            MainActor.assumeIsolated { self?.handle(event) }
        }
        hotkeys.onStateChange = { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refreshMenu()
                self?.reportStatus()
            }
        }
        recorder.onMaxDurationReached = { [weak self] in
            MainActor.assumeIsolated { self?.handle(.maxDurationReached) }
        }
        recorder.onLevel = { [weak self] level in
            MainActor.assumeIsolated { self?.hud.updateLevel(level) }
        }

        refreshPermissions()
        Permissions.requestMicrophone { [weak self] state in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.permissions.microphone = state
                    self.refreshMenu()
                    self.reportStatus()
                }
            }
        }
        requestMissingPermissions()

        startService()
        startPolling()

        bootstrapTask = Task { [weak self] in await self?.bootstrapCore() }
    }

    public func applicationWillTerminate(_ notification: Notification) {
        bootstrapTask?.cancel()
        eventsTask?.cancel()
        processingTask?.cancel()
        tickTimer?.invalidate()
        pollTimer?.invalidate()
        hotkeys.stop()
        recorder.discard()
        AgentLog.info("agent terminating")
    }

    // MARK: - Bootstrap

    private func bootstrapCore() async {
        var triedLaunching = false

        while !Task.isCancelled {
            var reachable = await core.isReachable()

            if !reachable, !triedLaunching {
                triedLaunching = true
                AgentLog.info("core not reachable; launching it")
                switch core.launchCore() {
                case .launched:
                    // Core loads a 1.6 GB STT model on start, but the HTTP port comes up long before.
                    for _ in 0..<40 {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        if await core.isReachable() { reachable = true; break }
                    }
                case .noLauncher:
                    lastError = "не найден скрипт запуска core"
                case .failed(let reason):
                    lastError = "не удалось запустить core: \(reason)"
                }
            }

            coreReachable = reachable
            refreshMenu()

            if reachable {
                await reloadConfig()
                reportStatus(force: true)
                startEventStream()
                return
            }

            AgentLog.error("core unreachable; dictation will fail until it is running")
            // Keep probing: the user may start core from the terminal at any time.
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    private func reloadConfig() async {
        guard let fetched = await core.fetchConfig() else { return }
        config = fetched
        machine.config = fetched.dictationConfig
        hud.isEnabled = fetched.hudEnabled
        hotkeys.fnTriggerEnabled = fetched.fnTriggerEnabled
        applyHotkeyConfig()
        if fetched.enabled != serviceEnabled {
            fetched.enabled ? startService() : stopService()
        }
        refreshMenu()
        AgentLog.debug("agent config reloaded")
    }

    private func applyHotkeyConfig() {
        guard serviceEnabled else { return }
        if config.fallbackHotkeyEnabled {
            hotkeys.setFallbackHotkey(config.fallbackHotkey)
        } else {
            hotkeys.setFallbackHotkey(nil)
        }
    }

    private func startEventStream() {
        eventsTask?.cancel()
        eventsTask = Task { [weak self] in
            var backoff: UInt64 = 1_000_000_000
            while !Task.isCancelled {
                guard let strongSelf = self else { return }
                do {
                    try await strongSelf.core.streamEvents { event in
                        Task { @MainActor in strongSelf.apply(event) }
                    }
                    backoff = 1_000_000_000
                } catch {
                    await MainActor.run { strongSelf.coreReachable = false; strongSelf.refreshMenu() }
                    AgentLog.debug("SSE disconnected: \(error)")
                }
                try? await Task.sleep(nanoseconds: backoff)
                backoff = min(backoff * 2, 15_000_000_000)
                let reachable = await strongSelf.core.isReachable()
                await MainActor.run { strongSelf.coreReachable = reachable; strongSelf.refreshMenu() }
            }
        }
    }

    private func apply(_ event: ServerEvent) {
        switch event {
        case .hello(let version):
            coreReachable = true
            // `hello` arrives on every (re)connect, which is exactly when core needs the current
            // permission state again — it holds none across restarts.
            reportStatus(force: true)
            AgentLog.info("connected to core \(version)")
        case .sttStatus(let ready, let state, let error):
            sttReady = ready
            sttState = state
            if let error { lastError = error }
        case .settingsChanged:
            Task { [weak self] in await self?.reloadConfig() }
        case .pipeline(let dictationId, let stage, let text):
            guard dictationId == inFlightDictationId else { return }
            switch stage {
            case .received, .transcribing:
                hud.show(.transcribing)
            case .transcribed, .correcting:
                // `transcribed` carries the text; the `correcting` events after it do not.
                if let text, !text.isEmpty { inFlightTranscript = text }
                hud.show(.improving(transcript: inFlightTranscript))
            case .completed, .failed, .cancelled:
                break
            }
        }
        refreshMenu()
    }

    // MARK: - Service on/off

    private func startService() {
        serviceEnabled = true
        hotkeys.fnTriggerEnabled = config.fnTriggerEnabled
        if config.fnTriggerEnabled {
            hotkeys.startFnTap()
        }
        applyHotkeyConfig()
        refreshPermissions()
        refreshMenu()
        reportStatus()
    }

    private func stopService() {
        serviceEnabled = false
        if machine.isCapturing {
            machine.handle(.escapePressed)
            recorder.discard()
            hud.hide()
        }
        machine.reset()
        hotkeys.stop()
        refreshMenu()
        reportStatus()
    }

    private func startPolling() {
        pollTimer?.invalidate()
        // TCC state can change while the app runs (the user flips a switch in System Settings);
        // there is no notification for it, so it has to be polled.
        var ticksSinceReport = 0
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let previous = self.permissions
                self.refreshPermissions()
                ticksSinceReport += 1
                if previous != self.permissions {
                    ticksSinceReport = 0
                    self.reportStatus()
                    // Input Monitoring may have just been granted — the tap can work now.
                    if self.serviceEnabled, self.config.fnTriggerEnabled, !self.hotkeys.state.fnTapActive {
                        self.hotkeys.startFnTap()
                    }
                } else if ticksSinceReport >= 4 {
                    // Heartbeat. Core treats a report older than a minute as "agent gone", and
                    // reportStatus() alone is deduplicated by payload, so a healthy agent whose
                    // permissions never change went silent and showed up as offline after a
                    // minute even though it was running and connected.
                    ticksSinceReport = 0
                    self.reportStatus(force: true)
                }
                self.refreshMenu()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    private func refreshPermissions() {
        permissions = Permissions.snapshot()
    }

    private func reportStatus(force: Bool = false) {
        let snapshot = permissions
        let tapActive = hotkeys.state.fnTapActive
        let tapError = hotkeys.state.fnTapError
        let payload = AgentStatusPayload(
            microphone: snapshot.microphone,
            accessibility: snapshot.accessibility,
            inputMonitoring: snapshot.inputMonitoring,
            agentVersion: AgentInfo.version,
            fnTapActive: tapActive,
            fnTapError: tapError
        )
        // Startup touches permissions, the tap and the fallback hot key in quick succession; core
        // only cares about the resulting state, not about four identical POSTs.
        guard force || payload != lastReportedStatus else { return }
        lastReportedStatus = payload
        Task { [core] in
            await core.postAgentStatus(snapshot, fnTapActive: tapActive, fnTapError: tapError)
        }
    }

    private func refreshMenu() {
        menuBar?.update(
            MenuStatus(
                serviceEnabled: serviceEnabled,
                coreReachable: coreReachable,
                sttReady: sttReady,
                sttState: sttState,
                permissions: permissions,
                fnTapActive: hotkeys.state.fnTapActive,
                fnTapError: hotkeys.state.fnTapError,
                fallbackDisplay: hotkeys.state.fallbackActive ? hotkeys.state.fallbackDisplay : nil,
                isRecording: machine.isCapturing,
                lastError: lastError
            )
        )
    }

    // MARK: - Dictation flow

    private func handle(_ event: DictationEvent) {
        guard serviceEnabled else { return }

        // Escape while core is still working on a submitted dictation is a cancel, not a no-op.
        if case .escapePressed = event, !machine.isCapturing, let id = inFlightDictationId {
            inFlightDictationId = nil
            inFlightTranscript = nil
            processingTask?.cancel()
            hud.hide()
            Task { [core] in await core.cancelDictation(id: id) }
            AgentLog.info("dictation cancelled by user")
            return
        }

        let previousState = machine.state
        let effects = machine.handle(event)
        let mode = machine.recordingMode
        for effect in effects {
            switch effect {
            case .startCapture(let startMode):
                beginCapture(mode: startMode)
            case .stopCaptureAndProcess:
                finishCapture(mode: mode)
            case .discardCapture:
                abortCapture()
            case .none:
                break
            }
        }

        // Only on the transition: re-showing on every tick would restart the duration counter.
        if machine.state == .locked, previousState != .locked {
            hud.show(.recording(locked: true))
        }
        scheduleTick()
        refreshMenu()
    }

    private func scheduleTick() {
        tickTimer?.invalidate()
        tickTimer = nil
        guard let deadline = machine.pendingDeadline else { return }
        let delay = max(0.005, deadline - ProcessInfo.processInfo.systemUptime + 0.005)
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handle(.tick(at: ProcessInfo.processInfo.systemUptime))
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
    }

    private func beginCapture(mode: RecordingMode) {
        guard permissions.microphone == .granted else {
            hud.show(.error("Нет доступа к микрофону"))
            lastError = "нет доступа к микрофону"
            machine.reset()
            if !didOfferMicrophoneSettings {
                didOfferMicrophoneSettings = true
                Permissions.openSettings(.microphone)
            }
            return
        }
        didOfferMicrophoneSettings = false

        captureTarget = TargetApp.snapshotFrontmost(includeWindowTitle: config.sendWindowTitle)
        do {
            try recorder.start(maxDurationSeconds: config.maxRecordingSeconds)
            hud.show(.recording(locked: mode == .locked))
        } catch {
            AgentLog.error("cannot start capture: \(error)")
            lastError = "микрофон недоступен"
            hud.show(.error("Микрофон недоступен"))
            machine.reset()
        }
    }

    private func abortCapture() {
        recorder.discard()
        captureTarget = nil
        hud.hide()
        AgentLog.debug("capture discarded (too short, chord or cancel)")
    }

    private func finishCapture(mode: RecordingMode) {
        let target = captureTarget
        captureTarget = nil

        let capture: AudioCapture
        do {
            capture = try recorder.stopAndWriteWav()
        } catch {
            AgentLog.error("capture could not be finalised: \(error)")
            hud.show(.error("Запись не удалась"))
            return
        }

        guard Int(capture.durationMs) >= Int(config.minRecordingMs) else {
            AudioRecorder.deleteTempFile(capture.fileURL)
            hud.hide()
            AgentLog.debug("capture below minRecordingMs; dropped")
            return
        }

        let dictationId = "dct_agent_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(20))"
        inFlightDictationId = dictationId
        inFlightTranscript = nil
        hud.show(.transcribing)

        processingTask?.cancel()
        processingTask = Task { [weak self] in
            guard let self else { return }
            defer { AudioRecorder.deleteTempFile(capture.fileURL) }
            do {
                let outcome = try await self.core.postDictation(
                    wavURL: capture.fileURL,
                    dictationId: dictationId,
                    mode: mode,
                    target: target,
                    durationMs: capture.durationMs,
                    peakAmplitude: capture.peakAmplitude,
                    sendWindowTitle: self.config.sendWindowTitle
                )
                if Task.isCancelled { return }
                await MainActor.run { self.deliver(outcome, target: target) }
            } catch {
                if Task.isCancelled { return }
                await MainActor.run { self.failDictation(error) }
            }
        }
    }

    private func deliver(_ outcome: DictationOutcome, target: TargetAppSnapshot?) {
        inFlightDictationId = nil
        inFlightTranscript = nil

        switch outcome.status {
        case "cancelled":
            hud.hide()
            AgentLog.info("dictation \(outcome.id) produced nothing to insert")
            return
        case "failed" where outcome.text == nil:
            let message = outcome.errorMessage ?? outcome.errorCode ?? "неизвестная ошибка"
            lastError = message
            hud.show(.error(message))
            refreshMenu()
            return
        default:
            break
        }

        guard let text = outcome.text, !text.isEmpty else {
            hud.hide()
            return
        }

        let options = InsertionOptions(
            behavior: config.targetChangedBehavior,
            restoreClipboard: config.restoreClipboardAfterPaste,
            clipboardRestoreDelayMs: config.clipboardRestoreDelayMs,
            accessibilityGranted: permissions.accessibility == .granted
        )
        let result = inserter.insert(text: text, target: target, options: options)

        switch result.method {
        case .accessibility, .paste:
            hud.show(.inserted(text: text))
        case .clipboardOnly:
            hud.show(.copiedToClipboard(reason: result.message, text: text))
        }

        if outcome.isRawFallback == true {
            lastError = "LLM недоступен, вставлен сырой транскрипт"
        }
        AgentLog.info(
            "dictation \(outcome.id) delivered via \(result.method) (\(text.count) chars, total \(Int(outcome.totalLatencyMs ?? 0)) ms)"
        )
        refreshMenu()
    }

    private func failDictation(_ error: Error) {
        inFlightDictationId = nil
        inFlightTranscript = nil
        let message: String
        if let clientError = error as? CoreClientError {
            message = clientError.description
            if case .missingToken = clientError { coreReachable = false }
        } else {
            message = (error as NSError).localizedDescription
        }
        lastError = message
        hud.show(.error(message))
        AgentLog.error("dictation failed: \(message)")
        refreshMenu()
    }

    // MARK: - MenuBarDelegate

    public func menuBarDidToggleService() {
        serviceEnabled ? stopService() : startService()
    }

    public func menuBarDidRequestDashboard() {
        guard let url = core.dashboardURL() else { return }
        NSWorkspace.shared.open(url)
    }

    public func menuBarWillOpen() {
        let previous = permissions
        refreshPermissions()
        if previous != permissions { reportStatus() }
        refreshMenu()
    }

    /// Asks macOS for the permissions the app is still missing.
    ///
    /// This is not merely a prompt: `IOHIDRequestAccess` and `AXIsProcessTrustedWithOptions`
    /// are what *register the app in the Input Monitoring and Accessibility lists*. Until one
    /// of them runs, System Settings shows no LocalVoiceFlow row at all, so a user who opens
    /// the pane has nothing to switch on and no way to tell why. Checking alone
    /// (`IOHIDCheckAccess` / `AXIsProcessTrusted`) never creates the row.
    ///
    /// Only missing permissions are requested, so a fully set-up app never shows a prompt.
    private func requestMissingPermissions() {
        if permissions.accessibility != .granted {
            Permissions.requestAccessibility(prompt: true)
        }
        if permissions.inputMonitoring != .granted {
            Permissions.requestInputMonitoring()
        }
        refreshPermissions()
        reportStatus(force: true)
    }

    /// Explicit "Check permissions" click: this is the one place allowed to raise system prompts.
    public func menuBarDidRequestPermissionCheck() {
        let previous = permissions
        refreshPermissions()
        if permissions.accessibility != .granted {
            Permissions.requestAccessibility(prompt: true)
        }
        if permissions.inputMonitoring != .granted {
            Permissions.requestInputMonitoring()
        }
        refreshPermissions()
        // A grant that just landed makes the tap installable for the first time.
        if serviceEnabled, config.fnTriggerEnabled, !hotkeys.state.fnTapActive {
            hotkeys.startFnTap()
        }
        if previous != permissions { reportStatus() }
        refreshMenu()
    }

    public func menuBarDidRequestOpenSettingsPane(_ pane: Permissions.SettingsPane) {
        Permissions.openSettings(pane)
    }

    public func menuBarDidRequestRestart() {
        AgentLog.info("restarting on user request")
        let bundleURL = Bundle.main.bundleURL
        if bundleURL.pathExtension == "app" {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = true
            NSWorkspace.shared.openApplication(at: bundleURL, configuration: configuration) { _, _ in
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
            return
        }
        // Unbundled (swift run): re-exec the executable itself.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        process.arguments = []
        try? process.run()
        NSApp.terminate(nil)
    }

    public func menuBarDidRequestQuit() {
        NSApp.terminate(nil)
    }
}
