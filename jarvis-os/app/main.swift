// JARVIS OS.app — native shell for the JARVIS OS web app (http://localhost:8787).
// WKWebView + native SFSpeechRecognizer bridge (WKWebView has no Web Speech API,
// so a window.SpeechRecognition polyfill is injected that talks to native speech).
// Camera/mic capture requests from the page are granted natively for Vision.

import AppKit
import WebKit
import Speech
import AVFoundation
import CoreGraphics
import ScreenCaptureKit
import CoreLocation

let JARVIS_URL = URL(string: "http://localhost:8787")!

// MARK: - Native speech bridge

final class SpeechBridge: NSObject {
    weak var webView: WKWebView?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var silenceWork: DispatchWorkItem?
    private var lastTranscript = ""
    private var finished = true

    private func emit(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript("window.__jarvisSpeechEvent && window.__jarvisSpeechEvent(\(json))", completionHandler: nil)
        }
    }
    private func fail(_ code: String) {
        emit(["type": "error", "error": code])
        emit(["type": "end"])
        teardown()
        finished = true
    }

    func start() {
        DispatchQueue.main.async { [weak self] in self?.requestAuth() }
    }
    private func requestAuth() {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] micOK in
            DispatchQueue.main.async {
                guard let self else { return }
                guard micOK else { self.fail("not-allowed"); return }
                SFSpeechRecognizer.requestAuthorization { st in
                    DispatchQueue.main.async {
                        guard st == .authorized else { self.fail("not-allowed"); return }
                        self.begin()
                    }
                }
            }
        }
    }

    // config/vocabulary.json → the phrase list, or empty if anything at all is wrong with it.
    //
    // Every failure here returns [], which is exactly the behaviour before this existed: a missing,
    // unreadable or malformed file costs the bias and never costs him the microphone. A speech path
    // that refuses to start because a config file has a stray comma would be a far worse bug than
    // the mis-hearing this fixes.
    //
    // CAPPED AT 300. Apple's bias is relative, so an unbounded list flattens it — every phrase
    // weighted means none is. 300 is far above the size of the real file and low enough that a
    // careless paste cannot quietly turn the feature off.
    private static func vocabulary() -> [String] {
        let p = (NSHomeDirectory() as NSString)
            .appendingPathComponent("JARVIS MK-1/config/vocabulary.json")
        guard let data = FileManager.default.contents(atPath: p),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["phrases"] as? [Any] else { return [] }
        let phrases = raw.compactMap { $0 as? String }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.count <= 60 }
        return Array(phrases.prefix(300))
    }

    private func begin() {
        teardown()
        guard let recognizer, recognizer.isAvailable else { fail("service-not-allowed"); return }
        finished = false
        lastTranscript = ""

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        // TELL IT THE WORDS IT CANNOT BE EXPECTED TO KNOW.
        //
        // The recogniser has a general English lexicon and no idea who Parth is, what AdMax is, or
        // that Instamart and Swiggy are different services. Those are exactly the words that carry
        // the meaning of a request, so mangling one loses the whole sentence — and the failure is
        // silent, because a confidently wrong transcript looks like a correctly heard one.
        //
        // contextualStrings weights these higher when a sound is ambiguous. It loads no model, costs
        // no measurable time and adds nothing resident, which on this machine is the whole appeal.
        // Read fresh on every open rather than cached at launch, so editing the JSON takes effect on
        // the next thing he says instead of at the next restart.
        request.contextualStrings = Self.vocabulary()
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { buffer, _ in request.append(buffer) }
        do { try engine.start() } catch { fail("audio-capture"); return }
        self.engine = engine
        self.request = request

        bumpSilence(4.0) // window to start talking
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let result {
                    let t = result.bestTranscription.formattedString
                    if !t.isEmpty {
                        self.lastTranscript = t
                        self.emit(["type": "result", "transcript": t, "isFinal": false])
                        self.bumpSilence(1.7) // finalize after a short pause
                    }
                    if result.isFinal { self.finish() }
                } else if error != nil, !self.finished {
                    self.finish()
                }
            }
        }
    }

    private func bumpSilence(_ s: TimeInterval) {
        silenceWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.finish() }
        silenceWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: w)
    }

    func finish() {
        guard !finished else { return }
        finished = true
        silenceWork?.cancel()
        let t = lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty {
            emit(["type": "error", "error": "no-speech"])
        } else {
            emit(["type": "result", "transcript": t, "isFinal": true])
        }
        emit(["type": "end"])
        teardown()
    }

    private func teardown() {
        silenceWork?.cancel()
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop(); engine = nil
    }
}

// MARK: - App

final class JarvisOSApp: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler, CLLocationManagerDelegate {
    // Owned by the app, not the page: macOS grants location to the BUNDLE, and the WKWebView
    // inherits that grant. Held as a property so it outlives the launch call — a manager that
    // goes out of scope takes its pending authorisation prompt with it.
    private let locationManager = CLLocationManager()
    private var window: NSWindow!
    private var webView: WKWebView!
    private let speech = SpeechBridge()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()

        // Screen Recording ("Screen & System Audio Recording") — needed by the native ScreenCaptureKit
        // capture path (the "what's on my screen" / Capture feature). Request it up front so macOS shows
        // the grant prompt rather than the feature silently failing on first use. Idempotent: if already
        // granted this is a no-op; if previously denied macOS returns without re-nagging (grant it in
        // System Settings > Privacy & Security > Screen & System Audio Recording).
        // LOCATION. Requested up front for the same reason Screen Recording is: a permission asked for
        // at the moment of need is a permission asked for during an emergency. JARVIS uses this to know
        // which country's emergency number to dial and what address to give a dispatcher — IP
        // geolocation puts this machine 78 km away, in the wrong city.
        //
        // Idempotent. Already granted is a no-op; previously denied returns without re-nagging, and is
        // fixed in System Settings > Privacy & Security > Location Services.
        locationManager.delegate = self
        // 50 m: enough to keep the address current without a stream of identical posts.
        locationManager.distanceFilter = 50
        if CLLocationManager.locationServicesEnabled() {
            let st = locationManager.authorizationStatus
            if st == .notDetermined { locationManager.requestWhenInUseAuthorization() }
        }

        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
        }

        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let ucc = cfg.userContentController
        ucc.add(self, name: "jarvisSpeech")
        ucc.add(self, name: "jarvisWindow")
        // Polyfill window.SpeechRecognition → native SFSpeechRecognizer.
        // Also expose window.jarvisNative + a request/response bridge for display listing / screen capture
        // (the web app uses this instead of the backend's screencapture fallback when running in this shell).
        let shim = """
        (function(){
          let active = null;
          class JarvisSpeechRecognition {
            constructor(){ this.lang='en-US'; this.interimResults=true; this.continuous=false;
              this.onresult=null; this.onerror=null; this.onend=null; this.onstart=null; }
            start(){ active=this; window.webkit.messageHandlers.jarvisSpeech.postMessage('start'); if(this.onstart) this.onstart(); }
            stop(){ window.webkit.messageHandlers.jarvisSpeech.postMessage('stop'); }
            abort(){ this.stop(); }
          }
          window.__jarvisSpeechEvent = function(ev){
            const r = active; if(!r) return;
            if(ev.type==='result'){ const item=[{transcript:ev.transcript}]; item.isFinal=!!ev.isFinal;
              if(r.onresult) r.onresult({results:[item]}); }
            else if(ev.type==='error'){ if(r.onerror) r.onerror({error:ev.error}); }
            else if(ev.type==='end'){ if(active===r) active=null; if(r.onend) r.onend(); }
          };
          window.SpeechRecognition = JarvisSpeechRecognition;
          window.webkitSpeechRecognition = JarvisSpeechRecognition;

          window.jarvisNative = true;
          let __reqId = 0;
          const __pending = {};
          function __call(method, args){
            return new Promise((resolve, reject) => {
              const id = ++__reqId;
              __pending[id] = { resolve, reject };
              window.webkit.messageHandlers.jarvisWindow.postMessage({ id, method, args: args || [] });
            });
          }
          window.__jarvisResolve = function(payload){
            const p = __pending[payload.id]; if(!p) return;
            delete __pending[payload.id];
            payload.ok ? p.resolve(payload.value) : p.reject(new Error(payload.value));
          };
          window.jarvisListDisplays = () => __call('listDisplays');
          window.jarvisCaptureDisplay = (displayId, hideSelfIfNeeded) => __call('captureDisplay', [displayId, hideSelfIfNeeded]);
        })();
        """
        ucc.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        speech.webView = webView

        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = visible.width * 0.92, h = visible.height * 0.92
        window = NSWindow(
            contentRect: NSRect(x: visible.midX - w / 2, y: visible.midY - h / 2, width: w, height: h),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "JARVIS OS"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.02, green: 0.024, blue: 0.03, alpha: 1.0)
        window.minSize = NSSize(width: 1100, height: 640)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        load()
    }

    private func load() { webView.load(URLRequest(url: JARVIS_URL)) }

    // Retry until the local server answers (it's a KeepAlive launchd agent, so this is rare).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
        <body style="background:#050608;color:#5ed4f7;font-family:-apple-system;display:grid;place-items:center;height:96vh;margin:0">
        <div style="text-align:center"><div style="font-size:22px;letter-spacing:6px">JARVIS</div>
        <div style="color:rgba(255,255,255,.5);font-size:13px;margin-top:10px">Core offline — reconnecting…</div></div></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in self?.load() }
    }

    // Grant page requests for camera/mic (Vision view) — the OS-level TCC prompt still protects the app itself.
    // FILE PICKER FOR THE WEB UI.
    //
    // WKWebView silently ignores <input type="file"> unless its host implements this delegate — no
    // panel, no error, nothing in the console. The Attach button called input.click() correctly and
    // NOTHING happened, which from the outside is indistinguishable from a dead button. It works in a
    // browser and dies in the app, which is exactly why it passed testing in the preview pane.
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedFileTypes = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"]
        panel.message = "Choose an image for JARVIS to look at"
        panel.begin { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }


    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // GEOLOCATION IS DONE NATIVELY, NOT THROUGH THE WEBVIEW.
    //
    // WKWebView will not serve navigator.geolocation. There is no public WKUIDelegate callback for it
    // on macOS — the WebKit headers declare a permission method for media capture and nothing for
    // location, and the only hook that exists is private SPI. Tried and measured: a delegate method
    // with the plausible signature compiles happily, matches no protocol requirement, is never called,
    // and the page still receives "User denied Geolocation" with no dialog anywhere to say yes to.
    //
    // So the shell fetches the fix itself. CoreLocation belongs to the APP, which does have a real
    // permission prompt, and the result is posted to the local server exactly as the browser build
    // does. The web page never needs geolocation at all — which also means this keeps working if it
    // is ever loaded somewhere WKWebView is even stricter.
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let st = manager.authorizationStatus
        if st == .authorizedAlways || st == .authorized {
            manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            manager.startUpdatingLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        // Coordinates only, to the local server, over loopback. Nothing leaves the machine.
        postFix(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude, accuracy: loc.horizontalAccuracy)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("JARVIS OS: location failed - \(error.localizedDescription)")
    }

    // The token is read fresh from disk on every post, the same way Jarvis Search reads the API key:
    // one less copy to go stale, and nothing sensitive compiled into the binary.
    private func postFix(lat: Double, lon: Double, accuracy: Double) {
        let tokenPath = (NSHomeDirectory() as NSString)
            .appendingPathComponent("JARVIS MK-1/jarvis-os/state/.apitoken")
        guard let token = try? String(contentsOfFile: tokenPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else { return }
        guard let url = URL(string: "http://127.0.0.1:8787/api/location") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "x-jarvis-token")
        let body: [String: Any] = ["lat": lat, "lon": lon, "accuracy": accuracy, "source": "app"]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "jarvisSpeech" {
            if (message.body as? String) == "start" { speech.start() } else { speech.finish() }
            return
        }
        guard message.name == "jarvisWindow",
              let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let method = body["method"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        switch method {
        case "listDisplays": resolveDisplays(id: id)
        case "captureDisplay": handleCaptureDisplay(id: id, args: args)
        default: respond(id: id, ok: false, value: "unknown method")
        }
    }

    // MARK: - Display listing & capture (native — lets JARVIS answer "what's on my screen?")

    private func screenNumber(_ screen: NSScreen) -> UInt32 {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    private func resolveDisplays(id: Int) {
        let jarvisScreenNum = window.screen.map(screenNumber)
        let list: [[String: Any]] = NSScreen.screens.map { s in
            let num = screenNumber(s)
            return [
                "id": num,
                "name": s.localizedName,
                "main": s == NSScreen.main,
                "isJarvisScreen": jarvisScreenNum == num,
                "width": Int(s.frame.width),
                "height": Int(s.frame.height),
            ]
        }
        respond(id: id, ok: true, value: list)
    }

    // hideSelfIfNeeded: only actually minimizes if this app's own window is on the requested display —
    // "what's on your UI" passes false so JARVIS captures itself instead of hiding.
    private func handleCaptureDisplay(id: Int, args: [Any]) {
        guard let raw = args.first else { respond(id: id, ok: false, value: "missing display id"); return }
        let displayIdNum: UInt32
        if let n = raw as? NSNumber { displayIdNum = n.uint32Value }
        else if let n = raw as? Int { displayIdNum = UInt32(n) }
        else { respond(id: id, ok: false, value: "bad display id"); return }
        let hideSelfIfNeeded = (args.count > 1) && (((args[1] as? Bool) ?? (args[1] as? NSNumber)?.boolValue) ?? false)
        let displayId = CGDirectDisplayID(displayIdNum)
        let onJarvisScreen = window.screen.map(screenNumber) == displayIdNum

        func runCapture(thenRestore: Bool) {
            Task {
                defer {
                    if thenRestore {
                        DispatchQueue.main.async {
                            self.window.deminiaturize(nil)
                            NSApp.activate(ignoringOtherApps: true)
                            self.window.makeKeyAndOrderFront(nil)
                        }
                    }
                }
                do {
                    let content = try await SCShareableContent.current
                    guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
                        self.respond(id: id, ok: false, value: "Display not found for capture.")
                        return
                    }
                    let filter = SCContentFilter(display: display, excludingWindows: [])
                    let config = SCStreamConfiguration()
                    let maxDim = 1440.0
                    let scale = min(1.0, maxDim / Double(max(display.width, display.height)))
                    config.width = max(2, Int(Double(display.width) * scale))
                    config.height = max(2, Int(Double(display.height) * scale))
                    config.showsCursor = false
                    let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                    let rep = NSBitmapImageRep(cgImage: cgImage)
                    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else {
                        self.respond(id: id, ok: false, value: "Couldn't encode the screenshot.")
                        return
                    }
                    self.respond(id: id, ok: true, value: "data:image/jpeg;base64," + data.base64EncodedString())
                } catch {
                    self.respond(id: id, ok: false, value: "Couldn't capture that display (\(error.localizedDescription)). Grant Screen Recording permission to \"JARVIS OS\" in System Settings > Privacy & Security > Screen Recording, then relaunch.")
                }
            }
        }

        if hideSelfIfNeeded && onJarvisScreen {
            window.miniaturize(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { runCapture(thenRestore: true) }
        } else {
            runCapture(thenRestore: false)
        }
    }

    private func respond(id: Int, ok: Bool, value: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "ok": ok, "value": value]),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript("window.__jarvisResolve && window.__jarvisResolve(\(json))", completionHandler: nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // ⌘L → toggle the in-page system log console (reliable native path into the web app).
    @objc private func toggleSystemLog() {
        webView.evaluateJavaScript("window.toggleLog && window.toggleLog()", completionHandler: nil)
    }

    // Edit menu is required for Cmd+C/V/X/A to work inside the web view.
    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Hide JARVIS OS", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        appMenu.addItem(NSMenuItem(title: "Quit JARVIS OS", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        edit.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(NSMenuItem(title: "System Log", action: #selector(toggleSystemLog), keyEquivalent: "l"))  // ⌘L
        viewItem.submenu = view

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = JarvisOSApp()
app.delegate = delegate
app.run()
