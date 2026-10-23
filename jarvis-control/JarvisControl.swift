// JarvisControl — the "hands" of JARVIS.
//
//  • Always-on-top blue HUD: "◉ JARVIS is controlling your screen  ✕"  (shown only during a session)
//  • ✕ button + Esc + ⌥⌘. hotkey = STOP: aborts control instantly and hides the HUD
//  • CGEvent mouse/keyboard/scroll engine (needs Accessibility permission)
//  • Loopback-only HTTP control server (127.0.0.1), token-gated, that JARVIS OS drives
//
// Safety by design: bound to loopback, requires a shared secret token, every action is visible
// (HUD is up the whole time), and the user can kill the session at any instant. Coordinates are
// in main-display POINTS, top-left origin (CGDisplayBounds space) — the same space JARVIS OS maps
// its screenshot into, so a model click at (x,y) lands where it looks.

import AppKit
import Carbon.HIToolbox
import Network
import CoreGraphics

let HOME = FileManager.default.homeDirectoryForCurrentUser.path
let CTRL_DIR = "\(HOME)/JARVIS MK-1/jarvis-control"
let TOKEN_FILE = "\(CTRL_DIR)/.token"
let PORT: UInt16 = UInt16(ProcessInfo.processInfo.environment["JARVIS_CONTROL_PORT"] ?? "") ?? 8765

func log(_ s: String) {
    FileHandle.standardError.write("[\(ISO8601DateFormatter().string(from: Date()))] \(s)\n".data(using: .utf8)!)
}

// Shared token: reuse if present, else mint one (0600) so JARVIS OS can read it.
func loadOrCreateToken() -> String {
    if let t = try? String(contentsOfFile: TOKEN_FILE, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), t.count >= 16 { return t }
    let t = (0..<32).map { _ in "0123456789abcdef".randomElement()! }.reduce("") { $0 + String($1) }
    try? t.write(toFile: TOKEN_FILE, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: TOKEN_FILE)
    return t
}
let TOKEN = loadOrCreateToken()

// ---------------- CGEvent input engine ----------------
enum Input {
    static let src = CGEventSource(stateID: .combinedSessionState)

    static func move(_ p: CGPoint) {
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    }
    static func click(_ p: CGPoint, button: CGMouseButton = .left, clicks: Int64 = 1) {
        let (down, up): (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        move(p)
        for t in [down, up] {
            let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: button)
            e?.setIntegerValueField(.mouseEventClickState, value: clicks)
            e?.post(tap: .cghidEventTap)
        }
    }
    // Synthetic unicode key events posted back-to-back with no gap get DROPPED by modern
    // AppKit/Catalyst apps (verified against App Store: the whole string vanished, while the same
    // characters paced ~12ms apart landed perfectly). Emoji and other non-BMP scalars are posted as
    // a UTF-16 surrogate pair in one event rather than being truncated by the & 0xFFFF mask.
    // US-layout character → virtual keycode, with a flag for characters needing Shift.
    static let charMap: [Character: (CGKeyCode, Bool)] = {
        var m: [Character: (CGKeyCode, Bool)] = [:]
        let lower: [Character: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
            "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35,
            "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
        ]
        for (c, k) in lower { m[c] = (k, false); m[Character(String(c).uppercased())] = (k, true) }
        let digits: [Character: CGKeyCode] = ["1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29]
        for (c, k) in digits { m[c] = (k, false) }
        let shiftedDigits: [Character: Character] = ["!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0"]
        for (sym, base) in shiftedDigits { if let k = digits[base] { m[sym] = (k, true) } }
        let punct: [Character: (CGKeyCode, Bool)] = [
            " ": (49, false), "-": (27, false), "_": (27, true), "=": (24, false), "+": (24, true),
            "[": (33, false), "{": (33, true), "]": (30, false), "}": (30, true),
            ";": (41, false), ":": (41, true), "'": (39, false), "\"": (39, true),
            ",": (43, false), "<": (43, true), ".": (47, false), ">": (47, true),
            "/": (44, false), "?": (44, true), "\\": (42, false), "|": (42, true),
            "`": (50, false), "~": (50, true), "\n": (36, false), "\t": (48, false),
        ]
        for (c, v) in punct { m[c] = v }
        return m
    }()

    // Catalyst / UIKit-on-Mac apps (App Store, Messages, Maps, News…) IGNORE synthetic events that
    // carry only a unicode string with virtualKey 0 — verified: cmd+F focused App Store's search
    // field but not one character of the query ever appeared, while the identical call typed fine
    // into TextEdit. So real virtual keycodes are used wherever the character has one, and the
    // unicode path is kept only as the fallback for anything outside the US layout (accents, emoji).
    // The inter-key delay stays: back-to-back events get coalesced away by these same apps.
    static func typeText(_ s: String) {
        for ch in s {
            if let (code, needsShift) = charMap[ch] {
                let flags: CGEventFlags = needsShift ? .maskShift : []
                if let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) {
                    d.flags = flags; d.post(tap: .cghidEventTap)
                }
                if let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
                    u.flags = flags; u.post(tap: .cghidEventTap)
                }
            } else {
                for scalar in String(ch).unicodeScalars {
                    var u = UniChar(scalar.value & 0xFFFF)
                    let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
                    d?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u); d?.post(tap: .cghidEventTap)
                    let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
                    up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u); up?.post(tap: .cghidEventTap)
                }
            }
            Thread.sleep(forTimeInterval: 0.025)
        }
    }
    static let keyMap: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
        "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
        "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    ]
    // "cmd+space", "cmd+t", "return", "escape" ...
    static func pressKey(_ spec: String) {
        let parts = spec.lowercased().split(separator: "+").map(String.init)
        guard let last = parts.last, let code = keyMap[last] else { return }
        var flags: CGEventFlags = []
        for m in parts.dropLast() {
            if m == "cmd" || m == "command" { flags.insert(.maskCommand) }
            else if m == "shift" { flags.insert(.maskShift) }
            else if m == "opt" || m == "option" || m == "alt" { flags.insert(.maskAlternate) }
            else if m == "ctrl" || m == "control" { flags.insert(.maskControl) }
        }
        let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true); d?.flags = flags; d?.post(tap: .cghidEventTap)
        let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false); u?.flags = flags; u?.post(tap: .cghidEventTap)
    }
    static func scroll(_ dy: Int32) {
        CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
    }
}

// ---------------- HUD overlay ----------------
final class HUD {
    let window: NSWindow
    let dot = NSView()
    static let shared = HUD()

    init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 44),
                          styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))  // above almost everything
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        window.hasShadow = true
        window.ignoresMouseEvents = false

        let pill = NSView(frame: window.contentView!.bounds)
        pill.wantsLayer = true
        pill.layer?.cornerRadius = 22
        pill.layer?.backgroundColor = NSColor(calibratedRed: 0.043, green: 0.36, blue: 0.85, alpha: 0.96).cgColor
        pill.layer?.borderColor = NSColor(calibratedRed: 0.4, green: 0.72, blue: 1, alpha: 0.9).cgColor
        pill.layer?.borderWidth = 1
        pill.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(pill)

        dot.frame = NSRect(x: 16, y: 17, width: 10, height: 10)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 5
        dot.layer?.backgroundColor = NSColor(calibratedRed: 0.6, green: 0.9, blue: 1, alpha: 1).cgColor
        pill.addSubview(dot)

        let label = NSTextField(labelWithString: "JARVIS is controlling your screen")
        label.frame = NSRect(x: 34, y: 12, width: 262, height: 20)
        label.textColor = .white
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.backgroundColor = .clear
        label.isBezeled = false; label.isEditable = false
        pill.addSubview(label)

        let stop = NSButton(frame: NSRect(x: 300, y: 8, width: 48, height: 28))
        stop.title = "✕ Stop"
        stop.isBordered = false
        stop.font = .systemFont(ofSize: 12, weight: .bold)
        stop.contentTintColor = .white
        stop.wantsLayer = true
        stop.layer?.backgroundColor = NSColor(calibratedWhite: 1, alpha: 0.18).cgColor
        stop.layer?.cornerRadius = 14
        stop.target = self
        stop.action = #selector(stopTapped)
        pill.addSubview(stop)

        window.orderOut(nil)
        pulse()
    }

    func pulse() {
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = 1.0; a.toValue = 0.25; a.duration = 0.75
        a.autoreverses = true; a.repeatCount = .infinity
        dot.layer?.add(a, forKey: "pulse")
    }

    func place() {
        guard let scr = NSScreen.main else { return }
        let f = scr.frame
        let w: CGFloat = 360, h: CGFloat = 44
        window.setFrame(NSRect(x: f.midX - w / 2, y: f.maxY - h - 14, width: w, height: h), display: true)
    }

    @objc func stopTapped() { Session.stop() }
    func show() { place(); window.orderFrontRegardless() }
    func hide() { window.orderOut(nil) }
}

// ---------------- session state (thread-safe stop flag) ----------------
enum Session {
    private static let q = DispatchQueue(label: "jarvis.control.session")
    private static var _active = false
    private static var _stopped = false

    static func begin() { q.sync { _active = true; _stopped = false }; DispatchQueue.main.async { HUD.shared.show() } }
    static func end()   { q.sync { _active = false }; DispatchQueue.main.async { HUD.shared.hide() } }
    static func stop()  { q.sync { _stopped = true; _active = false }; DispatchQueue.main.async { HUD.shared.hide() }; log("STOP — control aborted by user") }
    static var active: Bool { q.sync { _active } }
    static var stopped: Bool { q.sync { _stopped } }
}

// ---------------- accessibility element lane ----------------
//
// WHY THIS EXISTS. Until now the only way to operate a native app was: screenshot → vision model →
// guess coordinates → click. Measured, that does not work — asked for a button at (537,667) the
// local model answered (370,742) twelve times running. The problem is not the model's eyesight, it
// is that pixel-guessing is the wrong mechanism.
//
// The browser lane already proved the right one: ENUMERATE the real elements and act on one BY
// INDEX, so there is no coordinate to be wrong about. macOS exposes exactly that tree for native
// apps through the accessibility API, and this app already holds the Accessibility grant it needs.
//
// ONE definition, used for both listing and acting — the same rule the browser lane follows — so
// index N means the same element in both passes. A separate "find it again" pass is how indexes
// silently drift.
enum AX {
    static let ACTIONABLE: Set<String> = [
        "AXButton", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
        "AXLink", "AXTextField", "AXTextArea", "AXSearchField", "AXTab", "AXDisclosureTriangle",
        "AXSlider", "AXIncrementor", "AXComboBox", "AXSegmentedControl", "AXToolbarButton", "AXCell",
    ]

    struct El {
        let ref: AXUIElement
        let role: String
        let label: String
        let frame: CGRect
    }

    static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }

    static func str(_ el: AXUIElement, _ name: String) -> String? {
        guard let v = attr(el, name) else { return nil }
        if let s = v as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        return nil
    }

    static func frameOf(_ el: AXUIElement) -> CGRect? {
        guard let pv = attr(el, kAXPositionAttribute as String), let sv = attr(el, kAXSizeAttribute as String) else { return nil }
        var p = CGPoint.zero, sz = CGSize.zero
        guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &sz) else { return nil }
        return CGRect(origin: p, size: sz)
    }

    // Depth-capped walk. An app like Xcode has tens of thousands of nodes; the useful controls are
    // near the surface, and an unbounded walk turns a 40ms call into a hang.
    static func walk(_ el: AXUIElement, _ depth: Int, _ out: inout [El], _ seen: inout Int) {
        if out.count >= 250 || depth > 12 || seen > 6000 { return }
        seen += 1
        let role = str(el, kAXRoleAttribute as String) ?? ""
        var actions: CFArray?
        AXUIElementCopyActionNames(el, &actions)
        let acts = (actions as? [String]) ?? []
        let pressable = acts.contains(kAXPressAction as String)
        if ACTIONABLE.contains(role) || pressable {
            let label = str(el, kAXTitleAttribute as String)
                ?? str(el, kAXDescriptionAttribute as String)
                ?? str(el, "AXHelp")
                ?? str(el, kAXValueAttribute as String)
                ?? ""
            // STRIP THE INVISIBLE DIRECTION MARKS.
            //
            // WhatsApp prefixes every label with U+200E (left-to-right mark): "\u{200E}Chats",
            // "\u{200E}Your message, ...". It is invisible in a log and in a screenshot, and it broke
            // an anchored match — a regex for "^your message" found nothing, so the compose field was
            // never focused and a Return went somewhere harmless instead of sending. Formatting
            // characters carry no meaning for matching, so they are removed here, once, for everyone.
            let clean = label.unicodeScalars.filter { !(
                $0.value == 0x200E || $0.value == 0x200F ||
                (0x202A...0x202E).contains($0.value) ||
                (0x2066...0x2069).contains($0.value) ||
                $0.value == 0xFEFF
            ) }.map(String.init).joined().trimmingCharacters(in: .whitespacesAndNewlines)
            if let f = frameOf(el), f.width > 1, f.height > 1, !clean.isEmpty {
                out.append(El(ref: el, role: role, label: String(clean.prefix(120)), frame: f))
            }
        }
        if let kids = attr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
            for k in kids { walk(k, depth + 1, &out, &seen) }
        }
    }

    // The frontmost app's actionable elements, in a stable order (tree order).
    // TARGET AN APP BY NAME, not "whatever is in front".
    //
    // Frontmost is not stable across two calls: the list is taken, focus moves for any reason — the
    // HUD, a notification, the user glancing at something — and the press then re-enumerates a
    // different application where index N means something else. Naming the app makes the pair of
    // calls refer to the same thing by construction, and the fingerprint then guards only against
    // the app's OWN contents changing, which is what it should be guarding.
    static func elements(_ wanted: String = "") -> (app: String, els: [El]) {
        var target: NSRunningApplication?
        if !wanted.isEmpty {
            let w = wanted.lowercased()
            target = NSWorkspace.shared.runningApplications.first {
                ($0.localizedName ?? "").lowercased() == w || ($0.bundleIdentifier ?? "").lowercased().hasSuffix(w)
            }
        }
        guard let front = target ?? NSWorkspace.shared.frontmostApplication else { return ("", []) }
        let appRef = AXUIElementCreateApplication(front.processIdentifier)
        var out: [El] = [], seen = 0
        // Windows first, then the menu bar — the order a person reads the screen in.
        if let wins = attr(appRef, kAXWindowsAttribute as String) as? [AXUIElement] {
            for w in wins { walk(w, 0, &out, &seen) }
        }
        // Not a conditional downcast: AXUIElement is a CoreFoundation type, so `as?` always
        // succeeds and the compiler rejects it. Bridge it directly instead.
        if let mbRaw = attr(appRef, "AXMenuBar") {
            let mb = mbRaw as! AXUIElement
            walk(mb, 0, &out, &seen)
        }
        return (front.localizedName ?? "", out)
    }

    // Press by index. AXPress first — it is what the control itself defines as "being used", and it
    // works on things a click can miss (menu items, off-screen-but-scrollable rows). A real click at
    // the element's own centre is the fallback, and it still needs no guessing: the frame came from
    // the element, not from a model.
    static func press(_ i: Int, _ expect: String, _ wanted: String = "") -> [String: Any] {
        let (app, els) = elements(wanted)
        let fp = fingerprint(app, els)
        if !expect.isEmpty && expect != fp {
            return ["ok": false, "stale": true, "app": app, "fingerprint": fp,
                    "error": "the screen changed since it was listed — list it again before pressing"]
        }
        guard i >= 0, i < els.count else { return ["ok": false, "error": "no such element", "count": els.count] }
        let e = els[i]
        let viaPress = AXUIElementPerformAction(e.ref, kAXPressAction as CFString) == .success
        if !viaPress {
            let c = CGPoint(x: e.frame.midX, y: e.frame.midY)
            Input.click(c)
        }
        return ["ok": true, "app": app, "role": e.role, "label": e.label,
                "via": viaPress ? "axpress" : "click", "x": Int(e.frame.midX), "y": Int(e.frame.midY)]
    }

    // A CHEAP IDENTITY FOR "THE SCREEN I LISTED".
    //
    // Index N only means anything relative to the enumeration it came from. Measured the hard way:
    // TextEdit's dialog was listed, focus returned to another app before the press, AX.press
    // re-enumerated THAT app, and index 5 — "Cancel" in the listing — pressed "Window" in a
    // different application entirely. A press must refuse rather than act on a screen it never saw.
    //
    // Same contract as the browser lane's staleness check: fingerprint the listing, send it back
    // with the press, refuse on mismatch.
    static func fingerprint(_ app: String, _ els: [El]) -> String {
        var h: UInt64 = 1469598103934665603
        func mix(_ s: String) { for b in s.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 } }
        mix(app); mix("|\(els.count)|")
        for e in els { mix(e.role); mix(e.label) }
        return String(h, radix: 36)
    }

    static func asJson(_ els: [El]) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for (i, e) in els.enumerated() {
            out.append(["i": i, "role": e.role, "label": e.label,
                        "x": Int(e.frame.midX), "y": Int(e.frame.midY),
                        "w": Int(e.frame.width), "h": Int(e.frame.height)])
        }
        return out
    }
}

// ---------------- minimal loopback HTTP server ----------------
final class ControlServer {
    let listener: NWListener

    init() throws {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: PORT)!)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        listener.start(queue: .global())
        log("JarvisControl server on 127.0.0.1:\(PORT)")
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: .global())
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            guard let self = self else { return }
            var buf = buffer
            if let d = data { buf.append(d) }
            if let s = String(data: buf, encoding: .utf8), self.hasFullRequest(s) {
                self.respond(conn, request: s)
            } else if done || err != nil {
                conn.cancel()
            } else {
                self.receive(conn, buffer: buf)
            }
        }
    }

    private func hasFullRequest(_ s: String) -> Bool {
        guard let hdrEnd = s.range(of: "\r\n\r\n") else { return false }
        if let cl = header(s, "content-length"), let n = Int(cl) {
            let body = String(s[hdrEnd.upperBound...])
            return body.utf8.count >= n
        }
        return true
    }

    private func header(_ s: String, _ name: String) -> String? {
        for line in s.split(separator: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            if parts.count == 2, parts[0].lowercased().trimmingCharacters(in: .whitespaces) == name {
                return parts[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    private func respond(_ conn: NWConnection, request: String) {
        let firstLine = request.split(separator: "\r\n").first.map(String.init) ?? ""
        let comps = firstLine.split(separator: " ")
        let method = comps.first.map(String.init) ?? "GET"
        let path = comps.count > 1 ? String(comps[1]) : "/"
        let body = request.range(of: "\r\n\r\n").map { String(request[$0.upperBound...]) } ?? ""

        // token gate (loopback already, but defend in depth)
        if header(request, "x-control-token") != TOKEN {
            return send(conn, 401, ["ok": false, "error": "unauthorized"])
        }

        var json: [String: Any] = [:]
        if let d = body.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { json = o }

        let scr = CGDisplayBounds(CGMainDisplayID())
        let screen: [String: Any] = ["w": Int(scr.width), "h": Int(scr.height)]

        switch (method, path) {
        case ("GET", "/status"):
            send(conn, 200, ["ok": true, "active": Session.active, "stopped": Session.stopped, "screen": screen, "trusted": AXIsProcessTrusted()])
        case ("POST", "/show"):
            Session.begin(); send(conn, 200, ["ok": true, "screen": screen])
        case ("POST", "/hide"):
            Session.end(); send(conn, 200, ["ok": true])
        // READING the screen is not CONTROLLING it, so /elements deliberately does not require an
        // active session or the HUD — the same way browser_elements can list a page without acting
        // on it. Acting still goes through /do, which does require both.
        case ("GET", _) where path.hasPrefix("/elements"):
            if !AXIsProcessTrusted() { return send(conn, 200, ["ok": false, "trusted": false]) }
            var payload: [String: Any] = [:]
            // ?app=Name pins which application is read.
            let wantApp = path.contains("?") ? String(path.split(separator: "?").last ?? "")
                .split(separator: "&").first(where: { $0.hasPrefix("app=") })
                .map { String($0.dropFirst(4)).removingPercentEncoding ?? "" } ?? "" : ""
            DispatchQueue.main.sync {
                let (app, els) = AX.elements(wantApp)
                payload = ["ok": true, "app": app, "count": els.count,
                           "fingerprint": AX.fingerprint(app, els), "elements": AX.asJson(els)]
            }
            send(conn, 200, payload)
        case ("POST", "/do"):
            if Session.stopped || !Session.active { return send(conn, 200, ["ok": false, "stopped": true]) }
            // Without Accessibility, CGEvent posts SUCCEED silently and do nothing — so reporting
            // ok:true here would make JARVIS claim it typed something when the keystroke went
            // nowhere. Fail loudly instead; the caller turns this into a real "re-grant" message.
            if !AXIsProcessTrusted() { return send(conn, 200, ["ok": false, "trusted": false]) }
            let action = (json["action"] as? String ?? "").lowercased()
            let x = (json["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (json["y"] as? NSNumber)?.doubleValue ?? 0
            let p = CGPoint(x: x, y: y)
            DispatchQueue.main.async {
                switch action {
                case "move": Input.move(p)
                case "click": Input.click(p)
                case "double": Input.click(p, clicks: 2)
                case "right": Input.click(p, button: .right)
                case "type": Input.typeText(json["text"] as? String ?? "")
                case "key": Input.pressKey(json["text"] as? String ?? "")
                case "scroll": Input.scroll(Int32((json["amount"] as? NSNumber)?.intValue ?? -300))
                default: break
                }
            }
            send(conn, 200, ["ok": true])
        // Press an element BY INDEX from /elements. No coordinates cross the wire, so there is
        // nothing for a model to get wrong — the same contract as browser_click.
        case ("POST", "/press"):
            if Session.stopped || !Session.active { return send(conn, 200, ["ok": false, "stopped": true]) }
            if !AXIsProcessTrusted() { return send(conn, 200, ["ok": false, "trusted": false]) }
            let idx = (json["i"] as? NSNumber)?.intValue ?? -1
            let expect = (json["fingerprint"] as? String) ?? ""
            var result: [String: Any] = [:]
            let wantApp2 = (json["app"] as? String) ?? ""
            DispatchQueue.main.sync { result = AX.press(idx, expect, wantApp2) }
            send(conn, 200, result)
        default:
            send(conn, 404, ["ok": false, "error": "not found"])
        }
    }

    private func send(_ conn: NWConnection, _ code: Int, _ obj: [String: Any]) {
        let body = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        var resp = "HTTP/1.1 \(code) OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".data(using: .utf8)!
        resp.append(body)
        conn.send(content: resp, completion: .contentProcessed { _ in conn.cancel() })
    }
}

// ---------------- app ----------------
class AppDelegate: NSObject, NSApplicationDelegate {
    var server: ControlServer?
    func applicationDidFinishLaunching(_ n: Notification) {
        _ = HUD.shared
        // Esc + ⌥⌘. as global panic-stop while a session is active.
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { e in
            if e.keyCode == 53 && Session.active { Session.stop() }                             // Esc
            if e.keyCode == 47 && e.modifierFlags.contains([.command, .option]) { Session.stop() } // ⌥⌘.
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            if e.keyCode == 53 && Session.active { Session.stop(); return nil }
            return e
        }
        do { server = try ControlServer(); server?.start() }
        catch { log("server failed: \(error)"); NSApp.terminate(nil) }
        if !AXIsProcessTrusted() { log("⚠︎ Accessibility NOT granted — mouse/keyboard control will do nothing until you enable JarvisControl in System Settings → Privacy & Security → Accessibility.") }
        log("JarvisControl ready — HUD idle, awaiting control sessions.")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no Dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
