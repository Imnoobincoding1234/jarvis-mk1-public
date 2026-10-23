import AppKit
import Carbon
import Speech
import AVFoundation

struct SearchResult {
    let title: String
    let subtitle: String
    let path: String?
    let action: (() -> Void)?
    let group: String
    let score: Int
    let isHeader: Bool

    init(title: String, subtitle: String, path: String?, action: (() -> Void)?, group: String, score: Int, isHeader: Bool = false) {
        self.title = title
        self.subtitle = subtitle
        self.path = path
        self.action = action
        self.group = group
        self.score = score
        self.isHeader = isHeader
    }

    static func header(_ title: String) -> SearchResult {
        SearchResult(title: title, subtitle: "", path: nil, action: nil, group: title, score: Int.max, isHeader: true)
    }
}

final class JarvisSearchApp: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
    private var statusItem: NSStatusItem!
    private var hotKeyRef: EventHotKeyRef?
    private var panel: NSPanel!
    private var searchField: NSTextField!
    private var tableView: NSTableView!
    private var closeButton: NSButton!
    private var statusLabel: NSTextField!
    private var micIndicator: NSView!
    private var results: [SearchResult] = []

    private var searchTask: Process?
    private var searchWorkItem: DispatchWorkItem?
    private var eventHandlerRef: EventHandlerRef?

    private let favoritesKey = "JarvisSearch.favorites"
    private let recentKey = "JarvisSearch.recents"
    private let recentCommandsKey = "JarvisSearch.recentCommands"
    private let voicePhrase = "jarvis search"
    private var isIntentionalStop = false

    private var speechEngine: AVAudioEngine?
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechTask: SFSpeechRecognitionTask?
    private let sfRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    // "jarvis search <query>" — after the wake phrase, wait a moment for a query
    // (same breath or a short pause after) before opening the panel.
    private var voiceArmedAt: Date?
    private var voiceFireWork: DispatchWorkItem?
    private let voiceQueryWindow: TimeInterval = 2.0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildMenuBarItem()
        buildPanel()
        registerHotKey()
        setupVoiceWake()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopVoiceListening()
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
        }
    }

    private func buildMenuBarItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "J"
        statusItem.button?.toolTip = "Jarvis Search (⌘9 or say \"Jarvis search\")"

        let menu = NSMenu()
        let openItem = NSMenuItem(title: "Open Jarvis Search", action: #selector(showPanel), keyEquivalent: "")
        openItem.target = self
        menu.addItem(openItem)
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    private func buildPanel() {
        panel = JarvisPanel(
            contentRect: NSRect(x: 0, y: 0, width: 840, height: 520),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true

        let root = JarvisHUDView(frame: panel.contentRect(forFrameRect: panel.frame))
        root.autoresizingMask = [.width, .height]
        panel.contentView = root

        let title = NSTextField(labelWithString: "JARVIS")
        title.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold)
        title.textColor = NSColor(calibratedRed: 0.290, green: 0.776, blue: 1.0, alpha: 1.0)
        title.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(title)

        statusLabel = NSTextField(labelWithString: "READY")
        statusLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
        statusLabel.textColor = NSColor(calibratedRed: 0.549, green: 0.863, blue: 1.0, alpha: 0.92)
        statusLabel.alphaValue = 0.85
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(statusLabel)

        micIndicator = NSView()
        micIndicator.wantsLayer = true
        micIndicator.layer?.cornerRadius = 5
        micIndicator.layer?.backgroundColor = NSColor(calibratedRed: 0.2, green: 0.96, blue: 0.55, alpha: 0.85).cgColor
        micIndicator.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(micIndicator)

        closeButton = NSButton()
        closeButton.bezelStyle = .circular
        closeButton.isBordered = false
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")
        closeButton.contentTintColor = NSColor(calibratedRed: 0.290, green: 0.776, blue: 1.0, alpha: 1.0)
        closeButton.toolTip = "Close Jarvis Search"
        closeButton.target = self
        closeButton.action = #selector(closePanel)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(closeButton)

        searchField = JarvisSearchField()
        if let jarvisField = searchField as? JarvisSearchField {
            jarvisField.onMoveSelection = { [weak self] delta in self?.moveSelection(delta) }
            jarvisField.onOpenSelection = { [weak self] in self?.openSelected() }
            jarvisField.onCancel = { [weak self] in self?.hidePanel() }
            jarvisField.onPinToggle = { [weak self] in self?.togglePinSelected() }
        }
        let placeholderAttributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor(calibratedRed: 0.188, green: 0.659, blue: 1.0, alpha: 0.45),
            .font: NSFont.monospacedSystemFont(ofSize: 16, weight: .regular)
        ]
        searchField.placeholderAttributedString = NSAttributedString(string: "Search core database or issue command...", attributes: placeholderAttributes)
        searchField.delegate = self
        searchField.target = self
        searchField.action = #selector(openSelected)
        searchField.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(searchField)

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        tableView = NSTableView()
        tableView.backgroundColor = .clear
        tableView.selectionHighlightStyle = .none
        tableView.headerView = nil
        tableView.rowHeight = 58
        tableView.delegate = self
        tableView.dataSource = self
        tableView.target = self
        tableView.action = #selector(openSelected)
        tableView.doubleAction = #selector(openSelected)

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("result"))
        column.width = 700
        tableView.addTableColumn(column)
        scrollView.documentView = tableView
        root.addSubview(scrollView)

        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 22),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 26),

            statusLabel.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            statusLabel.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 10),

            micIndicator.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            micIndicator.leadingAnchor.constraint(equalTo: statusLabel.trailingAnchor, constant: 8),
            micIndicator.widthAnchor.constraint(equalToConstant: 10),
            micIndicator.heightAnchor.constraint(equalToConstant: 10),

            closeButton.topAnchor.constraint(equalTo: root.topAnchor, constant: 15),
            closeButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            closeButton.widthAnchor.constraint(equalToConstant: 32),
            closeButton.heightAnchor.constraint(equalToConstant: 32),

            searchField.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 12),
            searchField.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            searchField.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            searchField.heightAnchor.constraint(equalToConstant: 56),

            scrollView.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 16),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -24)
        ])

        results = defaultResults()
        tableView.reloadData()
    }

    private func registerHotKey() {
        let signature = OSType(UInt32(UInt8(ascii: "J")) << 24 | UInt32(UInt8(ascii: "R")) << 16 | UInt32(UInt8(ascii: "V")) << 8 | UInt32(UInt8(ascii: "S")))
        let hotKeyID = EventHotKeyID(signature: signature, id: 9)
        let keyCodeFor9: UInt32 = 25
        let hotKeyStatus = RegisterEventHotKey(keyCodeFor9, UInt32(cmdKey), hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        if hotKeyStatus != noErr {
            showHotKeyWarning(status: hotKeyStatus)
        }

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let app = Unmanaged<JarvisSearchApp>.fromOpaque(userData).takeUnretainedValue()
            app.togglePanel()
            return noErr
        }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &eventHandlerRef)
    }

    private func showHotKeyWarning(status: OSStatus) {
        let alert = NSAlert()
        alert.messageText = "Jarvis Search shortcut unavailable"
        alert.informativeText = "Command + 9 could not be registered (status \(status)). Use the J menu-bar item or say \"Jarvis search\"."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // MARK: - Voice wake

    // ONE SWITCH FOR EVERY ALWAYS-ON WAKE PHRASE IN THE FLEET: jarvis.voice_wake in jarvis.yaml.
    //
    // Listening for "jarvis search" is not a task that starts and finishes — startVoiceListening()
    // re-arms after every result, every error and every panel close, so the recogniser and its
    // microphone tap are live for as long as the app is. That costs a permanent
    // localspeechrecognition XPC service: measured 80-150 MB resident on an 8 GB machine. The
    // settings panel once did the same for "jarvis settings"; it and its phrase have been removed,
    // so this is now the only always-on wake phrase behind the switch.
    //
    // Cmd-9 opens this overlay for nothing, so the phrase is off unless he asks for it. Read once at
    // launch and defaulting to FALSE when the file or key is missing — a config that predates the
    // key comes up silent rather than listening.
    static func voiceWakeEnabled() -> Bool {
        let path = NSHomeDirectory() + "/JARVIS MK-1/jarvis.yaml"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return false }
        for raw in text.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("voice_wake:") else { continue }
            return line.dropFirst("voice_wake:".count).trimmingCharacters(in: .whitespaces) == "true"
        }
        return false
    }

    private func setupVoiceWake() {
        // Gated before requestMicrophoneThenSpeech, not inside it: asking for the microphone is the
        // thing being switched off, and a permission held is a permission that can be used.
        guard JarvisSearchApp.voiceWakeEnabled() else {
            statusLabel.stringValue = "HOTKEY"
            pulseIndicator(active: false)
            return
        }
        requestMicrophoneThenSpeech()
    }

    private func requestMicrophoneThenSpeech() {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] micGranted in
            DispatchQueue.main.async {
                guard let self else { return }
                if !micGranted {
                    self.statusLabel.stringValue = "MIC NEEDED"
                    self.pulseIndicator(active: false)
                }
                self.requestSpeechPermission()
            }
        }
    }

    private func requestSpeechPermission() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                switch status {
                case .authorized:
                    self.startVoiceListening()
                case .denied, .restricted:
                    self.statusLabel.stringValue = "SPEECH NEEDED"
                    self.pulseIndicator(active: false)
                case .notDetermined:
                    self.statusLabel.stringValue = "HOTKEY"
                    self.pulseIndicator(active: false)
                @unknown default:
                    self.statusLabel.stringValue = "HOTKEY"
                    self.pulseIndicator(active: false)
                }
            }
        }
    }

    private func startVoiceListening() {
        assert(Thread.isMainThread, "startVoiceListening must be called on the main thread")
        // Guarded HERE as well as at setup, because this is re-armed from three places — after a
        // result, after an error, and every time the panel closes. Gating only the launch path would
        // have had the first Cmd-9 quietly switch the microphone back on for good.
        guard JarvisSearchApp.voiceWakeEnabled() else {
            statusLabel.stringValue = "HOTKEY"
            pulseIndicator(active: false)
            return
        }
        guard let recognizer = sfRecognizer, recognizer.isAvailable else {
            statusLabel.stringValue = "HOTKEY"
            pulseIndicator(active: false)
            return
        }

        stopVoiceListening()
        isIntentionalStop = false

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            request.append(buffer)
        }

        do {
            try engine.start()
        } catch {
            statusLabel.stringValue = "HOTKEY"
            pulseIndicator(active: false)
            return
        }

        speechTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async {
                    if !self.isIntentionalStop {
                        self.restartVoiceListening(after: 2.0)
                    }
                }
                _ = error
                return
            }
            guard let text = result?.bestTranscription.formattedString.lowercased() else { return }
            guard let range = text.range(of: self.voicePhrase, options: .backwards) else { return }
            let query = String(text[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            let isFinal = result?.isFinal ?? false

            DispatchQueue.main.async {
                if self.voiceArmedAt == nil { self.voiceArmedAt = Date() }
                self.voiceFireWork?.cancel()

                let fire: () -> Void = { [weak self] in
                    guard let self else { return }
                    self.playSound("Glass")
                    self.presentPanel(trigger: "VOICE", query: query)
                    self.voiceArmedAt = nil
                }

                let elapsed = Date().timeIntervalSince(self.voiceArmedAt!)
                if isFinal || elapsed >= self.voiceQueryWindow {
                    fire()
                } else {
                    // Give the recognizer a brief settle window to pick up trailing words
                    // (e.g. "jarvis search perplexity" arriving as one continuous phrase),
                    // capped by voiceQueryWindow from the moment the wake phrase was first heard.
                    let work = DispatchWorkItem(block: fire)
                    self.voiceFireWork = work
                    let settle = min(0.9, self.voiceQueryWindow - elapsed)
                    DispatchQueue.main.asyncAfter(deadline: .now() + max(0.1, settle), execute: work)
                }
            }
        }

        speechEngine = engine
        speechRequest = request

        statusLabel.stringValue = "LISTENING"
        pulseIndicator(active: true)
    }

    private func stopVoiceListening() {
        assert(Thread.isMainThread, "stopVoiceListening must be called on the main thread")
        isIntentionalStop = true
        
        speechTask?.cancel()
        speechTask = nil
        speechRequest?.endAudio()
        speechRequest = nil
        speechEngine?.inputNode.removeTap(onBus: 0)
        speechEngine?.stop()
        speechEngine = nil
    }

    private func restartVoiceListening(after delay: TimeInterval) {
        assert(Thread.isMainThread, "restartVoiceListening must be called on the main thread")
        stopVoiceListening()
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.startVoiceListening()
        }
    }

    private func pulseIndicator(active: Bool) {
        guard let layer = micIndicator.layer else { return }
        layer.removeAllAnimations()
        layer.backgroundColor = (active
            ? NSColor(calibratedRed: 0.2, green: 0.96, blue: 0.55, alpha: 0.95).cgColor
            : NSColor(calibratedRed: 0.463, green: 0.780, blue: 1.0, alpha: 0.55).cgColor)

        guard active else { return }
        let pulse = CABasicAnimation(keyPath: "transform.scale")
        pulse.fromValue = 1.0
        pulse.toValue = 1.35
        pulse.duration = 1.15
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        layer.add(pulse, forKey: "pulse")
    }

    private func playSound(_ name: String) {
        NSSound(named: NSSound.Name(name))?.play()
    }

    // MARK: - Recents & favorites

    private func storeRecentPath(_ path: String) {
        var paths = UserDefaults.standard.stringArray(forKey: recentKey) ?? []
        paths.removeAll { $0 == path }
        paths.insert(path, at: 0)
        UserDefaults.standard.set(Array(paths.prefix(12)), forKey: recentKey)
    }

    private func storeRecentCommand(_ command: String) {
        var commands = UserDefaults.standard.stringArray(forKey: recentCommandsKey) ?? []
        commands.removeAll { $0 == command }
        commands.insert(command, at: 0)
        UserDefaults.standard.set(Array(commands.prefix(10)), forKey: recentCommandsKey)
    }

    private func savedFavoritePaths() -> [String] {
        UserDefaults.standard.stringArray(forKey: favoritesKey) ?? []
    }

    private func pinPath(_ path: String) {
        var paths = savedFavoritePaths()
        guard !paths.contains(path) else { return }
        paths.insert(path, at: 0)
        UserDefaults.standard.set(Array(paths.prefix(12)), forKey: favoritesKey)
    }

    private func unpinPath(_ path: String) {
        var paths = savedFavoritePaths()
        paths.removeAll { $0 == path }
        UserDefaults.standard.set(paths, forKey: favoritesKey)
    }

    private func isPinned(_ path: String) -> Bool {
        savedFavoritePaths().contains(path)
    }

    private func favorites() -> [SearchResult] {
        let defaults = [
            "/Applications",
            NSHomeDirectory() + "/Downloads",
            NSHomeDirectory() + "/Documents",
            "/System/Applications/System Settings.app"
        ]
        let paths = savedFavoritePaths().isEmpty ? defaults : savedFavoritePaths()

        return paths.compactMap { path -> SearchResult? in
            guard FileManager.default.fileExists(atPath: path) else { return nil }
            let url = URL(fileURLWithPath: path)
            let name = url.lastPathComponent.hasSuffix(".app")
                ? url.deletingPathExtension().lastPathComponent
                : url.lastPathComponent
            return SearchResult(title: name, subtitle: path, path: path, action: nil, group: "Favorites", score: 0)
        }
    }

    private func recents() -> [SearchResult] {
        let saved = UserDefaults.standard.stringArray(forKey: recentKey) ?? []
        return saved.prefix(8).compactMap { path in
            guard FileManager.default.fileExists(atPath: path) else { return nil }
            let url = URL(fileURLWithPath: path)
            let name = url.deletingPathExtension().lastPathComponent
            return SearchResult(title: name, subtitle: path, path: path, action: nil, group: "Recents", score: 0)
        }
    }

    // MARK: - Panel

    private func togglePanel() {
        panel.isVisible ? hidePanel() : presentPanel(trigger: "HOTKEY")
    }

    @objc private func showPanel() {
        presentPanel(trigger: "MENU")
    }

    private func presentPanel(trigger: String, query: String = "") {
        guard let screen = NSScreen.main else { return }

        let frame = panel.frame
        let visible = screen.visibleFrame
        let x = visible.midX - frame.width / 2
        let y = visible.maxY - frame.height - 92

        panel.setFrameOrigin(NSPoint(x: x, y: y))
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKey()
        panel.makeFirstResponder(searchField)

        if let hud = panel.contentView as? JarvisHUDView {
            hud.startAnimations()
        }

        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searchField.stringValue = q
        if q.isEmpty {
            results = defaultResults()
            tableView.reloadData()
            selectFirstResult()
        } else {
            // Same path as typing: debounced background search, cursor at the end.
            searchField.currentEditor()?.selectedRange = NSRange(location: q.count, length: 0)
            searchWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in self?.performSearch(q) }
            searchWorkItem = workItem
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.14, execute: workItem)
        }

        // Stop listening while panel is open
        stopVoiceListening()

        statusLabel.stringValue = trigger
        playSound("Pop")
    }

    private func hidePanel() {
        if let hud = panel.contentView as? JarvisHUDView {
            hud.stopAnimations()
        }
        panel.orderOut(nil)

        // Start listening again when panel is closed
        startVoiceListening()

        playSound("Blow")
    }

    @objc private func closePanel() {
        hidePanel()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func defaultResults() -> [SearchResult] {
        buildSectionedResults([
            ("Favorites", favorites()),
            ("Recents", recents()),
            ("Commands", quickActions(for: ""))
        ])
    }

    // MARK: - Search

    func controlTextDidChange(_ obj: Notification) {
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        searchWorkItem?.cancel()
        
        if let task = searchTask, task.isRunning {
            task.terminate()
        }

        guard !query.isEmpty else {
            results = defaultResults()
            tableView.reloadData()
            selectFirstResult()
            return
        }

        let workItem = DispatchWorkItem { [weak self] in
            self?.performSearch(query)
        }
        searchWorkItem = workItem
        // Execute search on a background thread!
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.14, execute: workItem)
    }

    private func performSearch(_ query: String) {
        let apps = spotlightResults(for: query, kind: "kMDItemContentType == 'com.apple.application-bundle'", limit: 10, searchHomeOnly: false)
        let filesAndFolders = spotlightResults(for: query, kind: nil, limit: 30, searchHomeOnly: true)
        let fuzzyLocal = localFuzzyResults(for: query)

        // Cancel output early if query has changed in the UI
        var isOutdated = false
        DispatchQueue.main.sync {
            let currentQuery = self.searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if currentQuery != query {
                isOutdated = true
            }
        }
        guard !isOutdated else { return }

        var folders: [SearchResult] = []
        var files: [SearchResult] = []
        for item in filesAndFolders + fuzzyLocal {
            guard let path = item.path else { continue }
            if isDirectory(path) {
                folders.append(SearchResult(title: item.title, subtitle: item.subtitle, path: path, action: nil, group: "Folders", score: item.score))
            } else {
                files.append(SearchResult(title: item.title, subtitle: item.subtitle, path: path, action: nil, group: "Files", score: item.score))
            }
        }

        let sections: [(String, [SearchResult])] = [
            ("Favorites", filterResults(favorites(), matching: query)),
            ("Recents", filterResults(recents(), matching: query)),
            ("Commands", filterResults(quickActions(for: query), matching: query, allowAll: true)),
            ("Applications", apps),
            ("Folders", folders.sorted { $0.score < $1.score }),
            ("Files", files.sorted { $0.score < $1.score })
        ]

        DispatchQueue.main.async {
            // Re-verify query didn't change while building section results
            let currentQuery = self.searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard currentQuery == query else { return }

            self.results = self.buildSectionedResults(sections)
            if self.results.isEmpty {
                self.results = [SearchResult(title: "No matches", subtitle: "Try a different search or check spelling", path: nil, action: nil, group: "Empty", score: 0)]
            }
            self.tableView.reloadData()
            self.selectFirstResult()
        }
    }

    private func quickActions(for query: String) -> [SearchResult] {
        let commands: [SearchResult] = [
            SearchResult(title: "Open Settings", subtitle: "Launch System Settings", path: "/System/Applications/System Settings.app", action: nil, group: "Commands", score: 0),
            SearchResult(title: "Open Downloads", subtitle: "Jump to Downloads folder", path: NSHomeDirectory() + "/Downloads", action: nil, group: "Commands", score: 0),
            SearchResult(title: "Lock Screen", subtitle: "Require password or Touch ID", path: nil, action: {
                runShell("/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", ["-suspend"])
            }, group: "Commands", score: 1),
            SearchResult(title: "Sleep Display", subtitle: "Put the display to sleep", path: nil, action: {
                runShell("/usr/bin/pmset", ["displaysleepnow"])
            }, group: "Commands", score: 1),
            SearchResult(title: "Empty Trash", subtitle: "Permanently delete trashed items", path: nil, action: {
                runShell("/usr/bin/osascript", ["-e", "tell application \"Finder\" to empty trash"])
            }, group: "Commands", score: 2),
            SearchResult(title: "Restart", subtitle: "Restart this Mac", path: nil, action: {
                runShell("/usr/bin/osascript", ["-e", "tell application \"System Events\" to restart"])
            }, group: "Commands", score: 3),
            SearchResult(title: "Shutdown", subtitle: "Shut down this Mac", path: nil, action: {
                runShell("/usr/bin/osascript", ["-e", "tell application \"System Events\" to shut down"])
            }, group: "Commands", score: 3),
            SearchResult(title: "Quit Jarvis Search", subtitle: "Close this helper", path: nil, action: {
                NSApp.terminate(nil)
            }, group: "Commands", score: 4)
        ]
        guard !query.isEmpty else { return commands }
        return commands.filter { fuzzyMatch(query, against: $0.title) || fuzzyMatch(query, against: $0.subtitle) }
    }

    private func spotlightResults(for query: String, kind: String?, limit: Int, searchHomeOnly: Bool) -> [SearchResult] {
        let escaped = query.replacingOccurrences(of: "\"", with: "\\\"")
        let predicate: String
        if let kind {
            predicate = "\(kind) && kMDItemDisplayName == '*\(escaped)*'c"
        } else {
            predicate = "kMDItemDisplayName == '*\(escaped)*'c"
        }

        let paths = runMDFind(predicate: predicate, searchHomeOnly: searchHomeOnly)
        return paths
            .prefix(limit)
            .compactMap { path -> SearchResult? in
                let url = URL(fileURLWithPath: path)
                let title = url.deletingPathExtension().lastPathComponent
                let score = fuzzyScore(query, against: title) + fuzzyScore(query, against: path)
                guard fuzzyMatch(query, against: title) || fuzzyMatch(query, against: path) || title.lowercased().contains(query.lowercased()) else { return nil }
                return SearchResult(title: title, subtitle: path, path: path, action: nil, group: "Spotlight", score: score)
            }
            .sorted { $0.score < $1.score }
    }

    private func localFuzzyResults(for query: String) -> [SearchResult] {
        let roots = ["/Applications", "/System/Applications", NSHomeDirectory()]
        var found: [SearchResult] = []
        let fm = FileManager.default

        for root in roots {
            guard let entries = try? fm.contentsOfDirectory(atPath: root) else { continue }
            for entry in entries where !entry.hasPrefix(".") {
                let path = (root as NSString).appendingPathComponent(entry)
                let name = (entry as NSString).deletingPathExtension
                guard fuzzyMatch(query, against: name) || fuzzyMatch(query, against: entry) else { continue }
                let score = fuzzyScore(query, against: name)
                found.append(SearchResult(title: name, subtitle: path, path: path, action: nil, group: "Local", score: score))
            }
        }
        return found.sorted { $0.score < $1.score }.prefix(12).map { $0 }
    }

    private func runMDFind(predicate: String, searchHomeOnly: Bool) -> [String] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        process.arguments = searchHomeOnly ? ["-onlyin", NSHomeDirectory(), predicate] : [predicate]

        let pipe = Pipe()
        process.standardOutput = pipe
        
        // Write to searchTask thread-safely on the main thread
        DispatchQueue.main.sync {
            self.searchTask = process
        }

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return []
        }

        // Return empty results if process was intentionally terminated
        guard process.terminationStatus == 0 else { return [] }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [] }
        return output.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    private func filterResults(_ items: [SearchResult], matching query: String, allowAll: Bool = false) -> [SearchResult] {
        guard !query.isEmpty || allowAll else { return items }
        return items
            .filter { allowAll || fuzzyMatch(query, against: $0.title) || fuzzyMatch(query, against: $0.subtitle) || fuzzyMatch(query, against: $0.path ?? "") }
            .map { item in
                SearchResult(title: item.title, subtitle: item.subtitle, path: item.path, action: item.action, group: item.group,
                             score: item.score + fuzzyScore(query, against: item.title) + fuzzyScore(query, against: item.subtitle))
            }
            .sorted { $0.score < $1.score }
    }

    private func buildSectionedResults(_ sections: [(String, [SearchResult])]) -> [SearchResult] {
        var flattened: [SearchResult] = []
        var seen = Set<String>()

        for (group, items) in sections {
            let deduped = items.filter { item in
                let key = item.path ?? "\(item.group):\(item.title)"
                guard !seen.contains(key) else { return false }
                seen.insert(key)
                return true
            }
            guard !deduped.isEmpty else { continue }
            flattened.append(.header(group))
            flattened.append(contentsOf: deduped)
        }
        return flattened
    }

    private func fuzzyMatch(_ query: String, against text: String) -> Bool {
        guard !query.isEmpty else { return true }
        let q = query.lowercased()
        let t = text.lowercased()
        if t.contains(q) { return true }

        var index = t.startIndex
        for character in q {
            guard let found = t[index...].firstIndex(of: character) else { return false }
            index = t.index(after: found)
        }
        return true
    }

    private func fuzzyScore(_ query: String, against text: String) -> Int {
        guard !query.isEmpty else { return 0 }
        let q = query.lowercased()
        let t = text.lowercased()
        if t == q { return 0 }
        if t.hasPrefix(q) { return 1 }
        if t.contains(q) { return 2 }
        return fuzzyMatch(query, against: text) ? 4 : 20
    }

    private func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }

    // MARK: - Selection & actions

    private func selectFirstResult() {
        guard let firstSelectable = results.firstIndex(where: { !$0.isHeader }) else { return }
        tableView.selectRowIndexes(IndexSet(integer: firstSelectable), byExtendingSelection: false)
    }

    private func moveSelection(_ delta: Int) {
        let selectableRows = results.enumerated().filter { !$0.element.isHeader }.map { $0.offset }
        guard !selectableRows.isEmpty else { return }
        let current = tableView.selectedRow >= 0 ? tableView.selectedRow : selectableRows[0]
        let currentIndex = selectableRows.firstIndex(of: current) ?? 0
        let nextIndex = max(0, min(selectableRows.count - 1, currentIndex + delta))
        let next = selectableRows[nextIndex]
        tableView.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
        tableView.scrollRowToVisible(next)
    }

    @objc private func openSelected() {
        let selected = tableView.selectedRow
        guard selected >= 0, selected < results.count else { return }

        let result = results[selected]
        guard !result.isHeader else { return }

        if let action = result.action {
            action()
            storeRecentCommand(result.title)
            playSound("Hero")
            hidePanel()
            return
        }

        guard let path = result.path else { return }
        openPath(path)
        storeRecentPath(path)
        playSound("Hero")
        hidePanel()
    }

    private func togglePinSelected() {
        let selected = tableView.selectedRow
        guard selected >= 0, selected < results.count else { return }
        let result = results[selected]
        guard !result.isHeader, let path = result.path else { return }

        if isPinned(path) {
            unpinPath(path)
        } else {
            pinPath(path)
        }

        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            results = defaultResults()
            tableView.reloadData()
            selectFirstResult()
        } else {
            performSearch(query)
        }
        playSound("Tink")
    }

    func numberOfRows(in tableView: NSTableView) -> Int {
        results.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let result = results[row]
        let cell = ResultCell()
        if result.isHeader {
            cell.configureHeader(result.title)
        } else {
            let pinned = result.path.map { isPinned($0) } ?? false
            cell.configureItem(title: result.title, subtitle: result.subtitle, path: result.path, pinned: pinned)
        }
        return cell
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        results[row].isHeader ? 26 : 58
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        tableView.enumerateAvailableRowViews { rowView, _ in
            if let cell = rowView.view(atColumn: 0) as? ResultCell {
                cell.setSelected(rowView.isSelected)
            }
        }
    }
}

// MARK: - HUD panel & views

final class JarvisPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class JarvisHUDView: NSView {
    private var scanLineLayer: CAGradientLayer?
    private var scanAnimation: CABasicAnimation?
    private var rotatingRingLayer: CAShapeLayer?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 18
        layer?.masksToBounds = true
        setupScanLine()
        setupRotatingRing()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupScanLine() {
        let scan = CAGradientLayer()
        scan.colors = [
            NSColor.clear.cgColor,
            NSColor(calibratedRed: 0.200, green: 0.780, blue: 1.0, alpha: 0.35).cgColor,
            NSColor.clear.cgColor
        ]
        scan.startPoint = CGPoint(x: 0, y: 0.5)
        scan.endPoint = CGPoint(x: 1, y: 0.5)
        layer?.addSublayer(scan)
        scanLineLayer = scan
    }

    private func setupRotatingRing() {
        let ring = CAShapeLayer()
        ring.strokeColor = NSColor(calibratedRed: 0.188, green: 0.659, blue: 1.0, alpha: 0.18).cgColor
        ring.fillColor = NSColor.clear.cgColor
        ring.lineWidth = 1.5
        ring.lineDashPattern = [10, 15, 30, 15]
        
        let radius: CGFloat = 80
        let path = CGMutablePath()
        path.addEllipse(in: CGRect(x: -radius, y: -radius, width: radius * 2, height: radius * 2))
        ring.path = path
        
        layer?.addSublayer(ring)
        rotatingRingLayer = ring
    }

    override func layout() {
        super.layout()
        scanLineLayer?.frame = CGRect(x: 0, y: bounds.height * 0.4, width: bounds.width, height: 3)
        if let rotatingRingLayer {
            rotatingRingLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
        }
    }

    func startAnimations() {
        guard let scanLineLayer else { return }
        let move = CABasicAnimation(keyPath: "position.y")
        move.fromValue = bounds.height
        move.toValue = 0
        move.duration = 2.8
        move.repeatCount = .infinity
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        scanLineLayer.add(move, forKey: "scan")
        scanAnimation = move

        if let rotatingRingLayer {
            let rotate = CABasicAnimation(keyPath: "transform.rotation")
            rotate.fromValue = 0
            rotate.toValue = CGFloat.pi * 2
            rotate.duration = 12.0
            rotate.repeatCount = .infinity
            rotatingRingLayer.add(rotate, forKey: "rotation")
        }
    }

    func stopAnimations() {
        scanLineLayer?.removeAllAnimations()
        rotatingRingLayer?.removeAllAnimations()
    }

    override func draw(_ dirtyRect: NSRect) {
        let bounds = self.bounds
        
        // Deep tech background fill
        let background = NSBezierPath(roundedRect: bounds, xRadius: 18, yRadius: 18)
        NSColor(calibratedRed: 0.010, green: 0.045, blue: 0.075, alpha: 0.95).setFill()
        background.fill()

        // Tech coordinate grid
        NSColor(calibratedRed: 0.188, green: 0.659, blue: 1.0, alpha: 0.04).setStroke()
        let gridPath = NSBezierPath()
        gridPath.lineWidth = 0.5
        for yVal in stride(from: CGFloat(0), to: bounds.height, by: 26) {
            gridPath.move(to: NSPoint(x: 0, y: yVal))
            gridPath.line(to: NSPoint(x: bounds.width, y: yVal))
        }
        for xVal in stride(from: CGFloat(0), to: bounds.width, by: 26) {
            gridPath.move(to: NSPoint(x: xVal, y: 0))
            gridPath.line(to: NSPoint(x: xVal, y: bounds.height))
        }
        gridPath.stroke()

        // Concentric target reticles in background
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        NSColor(calibratedRed: 0.188, green: 0.659, blue: 1.0, alpha: 0.05).setStroke()
        
        let radarPath1 = NSBezierPath(ovalIn: NSRect(x: center.x - 120, y: center.y - 120, width: 240, height: 240))
        radarPath1.lineWidth = 1.0
        radarPath1.stroke()
        
        let radarPath2 = NSBezierPath(ovalIn: NSRect(x: center.x - 220, y: center.y - 220, width: 440, height: 440))
        radarPath2.lineWidth = 0.5
        radarPath2.stroke()
        
        let crossPath = NSBezierPath()
        crossPath.lineWidth = 0.5
        crossPath.move(to: NSPoint(x: center.x - 260, y: center.y))
        crossPath.line(to: NSPoint(x: center.x + 260, y: center.y))
        crossPath.move(to: NSPoint(x: center.x, y: center.y - 260))
        crossPath.line(to: NSPoint(x: center.x, y: center.y + 260))
        crossPath.stroke()

        // HUD panel glowing double borders
        let glow = NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 17, yRadius: 17)
        NSColor(calibratedRed: 0.090, green: 0.430, blue: 0.640, alpha: 0.12).setStroke()
        glow.lineWidth = 4
        glow.stroke()

        let border = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 18, yRadius: 18)
        NSColor(calibratedRed: 0.188, green: 0.659, blue: 1.0, alpha: 0.68).setStroke()
        border.lineWidth = 1.5
        border.stroke()

        // Targeting HUD Corner Brackets
        let bracketColor = NSColor(calibratedRed: 0.290, green: 0.776, blue: 1.0, alpha: 0.85)
        bracketColor.setStroke()
        let bracketLength: CGFloat = 20
        let inset: CGFloat = 8
        
        let corners = [
            // Top-Left
            (NSPoint(x: inset, y: bounds.height - inset - bracketLength), NSPoint(x: inset, y: bounds.height - inset), NSPoint(x: inset + bracketLength, y: bounds.height - inset)),
            // Top-Right
            (NSPoint(x: bounds.width - inset - bracketLength, y: bounds.height - inset), NSPoint(x: bounds.width - inset, y: bounds.height - inset), NSPoint(x: bounds.width - inset, y: bounds.height - inset - bracketLength)),
            // Bottom-Right
            (NSPoint(x: bounds.width - inset, y: inset + bracketLength), NSPoint(x: bounds.width - inset, y: inset), NSPoint(x: bounds.width - inset - bracketLength, y: inset)),
            // Bottom-Left
            (NSPoint(x: inset + bracketLength, y: inset), NSPoint(x: inset, y: inset), NSPoint(x: inset, y: inset + bracketLength))
        ]
        
        for (p1, p2, p3) in corners {
            let path = NSBezierPath()
            path.lineWidth = 2.5
            path.move(to: p1)
            path.line(to: p2)
            path.line(to: p3)
            path.stroke()
        }

        // Horizontal scan lines overlay
        NSColor(calibratedRed: 0.070, green: 0.280, blue: 0.450, alpha: 0.12).setFill()
        for index in 0..<9 {
            let y = CGFloat(index) * 54 + 14
            NSBezierPath(rect: NSRect(x: 0, y: y, width: bounds.width, height: 1)).fill()
        }
    }
}

final class JarvisSearchField: NSTextField {
    var onMoveSelection: ((Int) -> Void)?
    var onOpenSelection: (() -> Void)?
    var onCancel: (() -> Void)?
    var onPinToggle: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isBezeled = false
        drawsBackground = false
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.backgroundColor = NSColor(calibratedRed: 0.016, green: 0.125, blue: 0.173, alpha: 0.65).cgColor
        layer?.borderWidth = 1.0
        layer?.borderColor = NSColor(calibratedRed: 0.188, green: 0.659, blue: 1.0, alpha: 0.45).cgColor

        textColor = .white
        font = NSFont.monospacedSystemFont(ofSize: 20, weight: .semibold)
        focusRingType = .none
        lineBreakMode = .byTruncatingTail
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        switch event.keyCode {
        case 36:
            onOpenSelection?()
        case 53:
            onCancel?()
        case 125:
            onMoveSelection?(1)
        case 126:
            onMoveSelection?(-1)
        case 35 where flags.contains(.command) && flags.contains(.shift):
            onPinToggle?()
        default:
            super.keyDown(with: event)
        }
    }
}

final class ResultCell: NSTableCellView {
    private let iconView = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(labelWithString: "")
    private let pinBadge = NSTextField(labelWithString: "★")
    private var glowLayer: CAGradientLayer?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 10

        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.imageScaling = .scaleProportionallyUpOrDown
        addSubview(iconView)

        titleLabel.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .semibold)
        titleLabel.textColor = .white
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(titleLabel)

        subtitleLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        subtitleLabel.textColor = NSColor(calibratedRed: 0.463, green: 0.753, blue: 0.933, alpha: 0.9)
        subtitleLabel.lineBreakMode = .byTruncatingMiddle
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(subtitleLabel)

        pinBadge.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        pinBadge.textColor = NSColor(calibratedRed: 0.463, green: 0.800, blue: 1.0, alpha: 0.9)
        pinBadge.isHidden = true
        pinBadge.translatesAutoresizingMaskIntoConstraints = false
        addSubview(pinBadge)

        NSLayoutConstraint.activate([
            iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 34),
            iconView.heightAnchor.constraint(equalToConstant: 34),

            titleLabel.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 12),
            titleLabel.trailingAnchor.constraint(equalTo: pinBadge.leadingAnchor, constant: -8),
            titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 9),

            subtitleLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            subtitleLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 4),

            pinBadge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            pinBadge.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configureHeader(_ title: String) {
        iconView.image = nil
        iconView.isHidden = true
        titleLabel.stringValue = title.uppercased()
        subtitleLabel.stringValue = ""
        subtitleLabel.isHidden = true
        pinBadge.isHidden = true
        titleLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)
        titleLabel.textColor = NSColor(calibratedRed: 0.549, green: 0.863, blue: 1.0, alpha: 0.85)
        layer?.backgroundColor = NSColor(calibratedRed: 0.025, green: 0.105, blue: 0.160, alpha: 0.55).cgColor
    }

    func configureItem(title: String, subtitle: String, path: String?, pinned: Bool) {
        iconView.isHidden = false
        subtitleLabel.isHidden = false
        titleLabel.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .semibold)
        titleLabel.textColor = .white
        titleLabel.stringValue = title
        subtitleLabel.stringValue = subtitle
        pinBadge.isHidden = !pinned

        if let path {
            iconView.image = NSWorkspace.shared.icon(forFile: path)
        } else {
            iconView.image = NSImage(systemSymbolName: "sparkle.magnifyingglass", accessibilityDescription: "Command")
        }
        setSelected(false)
    }

    func setSelected(_ selected: Bool) {
        glowLayer?.removeFromSuperlayer()
        glowLayer = nil

        if selected {
            layer?.backgroundColor = NSColor(calibratedRed: 0.055, green: 0.330, blue: 0.500, alpha: 0.55).cgColor
            layer?.borderWidth = 1
            layer?.borderColor = NSColor(calibratedRed: 0.250, green: 0.760, blue: 1.0, alpha: 0.75).cgColor

            let shimmer = CAGradientLayer()
            shimmer.colors = [
                NSColor.clear.cgColor,
                NSColor(calibratedRed: 0.400, green: 0.800, blue: 1.0, alpha: 0.18).cgColor,
                NSColor.clear.cgColor
            ]
            shimmer.startPoint = CGPoint(x: 0, y: 0.5)
            shimmer.endPoint = CGPoint(x: 1, y: 0.5)
            shimmer.frame = bounds
            shimmer.cornerRadius = 10
            layer?.addSublayer(shimmer)
            glowLayer = shimmer

            let anim = CABasicAnimation(keyPath: "locations")
            anim.fromValue = [-0.2, -0.1, 0.0]
            anim.toValue = [1.0, 1.1, 1.2]
            anim.duration = 1.6
            anim.repeatCount = .infinity
            shimmer.locations = [0.0, 0.08, 0.16] as [NSNumber]
            shimmer.add(anim, forKey: "shimmer")
        } else {
            layer?.backgroundColor = NSColor.clear.cgColor
            layer?.borderWidth = 0
        }
    }

    override func layout() {
        super.layout()
        glowLayer?.frame = bounds
    }
}

// MARK: - Helpers

private func runShell(_ executable: String, _ arguments: [String]) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    try? process.run()
}

private func openPath(_ path: String) {
    let url = URL(fileURLWithPath: path)
    if !NSWorkspace.shared.open(url) {
        runShell("/usr/bin/open", [path])
    }
}

let app = NSApplication.shared
let delegate = JarvisSearchApp()
app.delegate = delegate
app.run()
