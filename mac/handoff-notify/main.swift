// HandoffNotify — a tiny macOS agent that posts native notifications with
// action buttons for Reminder Router, and reports clicks back to the daemon.
//
// Protocol (stdin, one JSON object per line):
//   {"op":"notify","id":12,"title":"Acme Auth","subtitle":"Google verification should be ready",
//    "body":"Next: configure OAuth branding","primary":"Open Google Cloud",
//    "actions":[{"id":"snooze15","label":"Snooze 15m"},{"id":"done","label":"Done"}],"sound":true}
//   {"op":"remove","id":12}
//   {"op":"quit"}
//
// Every click/button is POSTed to http://127.0.0.1:<port>/actions as {"id":12,"action":"open"}.
// The daemon spawns this binary with --port <port> and keeps it alive. If macOS launches the
// app itself (user clicked an old notification after the daemon restarted), the port is read
// from ~/.handoff/daemon.json and the process exits shortly after handling the click.

import AppKit
import Foundation
import UserNotifications

let categoryId = "HANDOFF"
let allActionIds = ["snooze15", "snooze60", "tomorrow", "done"]

func log(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

func readDaemonPort() -> Int? {
    let home = ProcessInfo.processInfo.environment["HANDOFF_HOME"]
        ?? (NSHomeDirectory() + "/.handoff")
    let url = URL(fileURLWithPath: home + "/daemon.json")
    guard let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let port = obj["port"] as? Int else { return nil }
    return port
}

final class App: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var port: Int
    let spawned: Bool
    let center = UNUserNotificationCenter.current()
    var pendingUntilAuthorized: [[String: Any]] = []
    var authorized = false

    init(port: Int, spawned: Bool) {
        self.port = port
        self.spawned = spawned
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self
        registerCategory()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                self.authorized = granted
                if let error = error { log("auth error: \(error.localizedDescription)") }
                log(granted ? "ready port=\(self.port)" : "notifications not authorized — enable HandoffNotify in System Settings › Notifications")
                for req in self.pendingUntilAuthorized { self.post(req) }
                self.pendingUntilAuthorized.removeAll()
            }
        }
        if spawned {
            startStdinLoop()
        } else {
            // Launched by macOS for a click: give the delegate a moment, then leave.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { NSApp.terminate(nil) }
        }
    }

    func registerCategory() {
        let actions = [
            UNNotificationAction(identifier: "snooze15", title: "Snooze 15m", options: []),
            UNNotificationAction(identifier: "snooze60", title: "Snooze 1h", options: []),
            UNNotificationAction(identifier: "tomorrow", title: "Tomorrow", options: []),
            UNNotificationAction(identifier: "done", title: "Done", options: []),
        ]
        let category = UNNotificationCategory(
            identifier: categoryId, actions: actions, intentIdentifiers: [],
            hiddenPreviewsBodyPlaceholder: "Handoff", options: [.customDismissAction])
        center.setNotificationCategories([category])
    }

    // MARK: stdin protocol

    func startStdinLoop() {
        DispatchQueue.global(qos: .utility).async {
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    log("bad line: \(line)")
                    continue
                }
                DispatchQueue.main.async { self.handle(obj) }
            }
            // stdin closed → daemon went away.
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func handle(_ obj: [String: Any]) {
        let op = obj["op"] as? String ?? "notify"
        switch op {
        case "notify":
            if authorized { post(obj) } else { pendingUntilAuthorized.append(obj) }
        case "remove":
            if let id = obj["id"] as? Int {
                center.removeDeliveredNotifications(withIdentifiers: ["handoff-\(id)"])
                center.removePendingNotificationRequests(withIdentifiers: ["handoff-\(id)"])
            }
        case "quit":
            NSApp.terminate(nil)
        default:
            log("unknown op \(op)")
        }
    }

    func post(_ obj: [String: Any]) {
        let id = obj["id"] as? Int ?? 0
        let content = UNMutableNotificationContent()
        content.title = obj["title"] as? String ?? "Handoff"
        if let sub = obj["subtitle"] as? String, !sub.isEmpty { content.subtitle = sub }
        if let body = obj["body"] as? String, !body.isEmpty { content.body = body }
        if (obj["sound"] as? Bool) ?? true { content.sound = .default }
        content.categoryIdentifier = categoryId
        content.threadIdentifier = "handoff"
        content.userInfo = ["handoffId": id]
        let request = UNNotificationRequest(identifier: "handoff-\(id)", content: content, trigger: nil)
        center.add(request) { error in
            if let error = error { log("deliver error #\(id): \(error.localizedDescription)") }
            else { log("delivered #\(id)") }
        }
    }

    // MARK: delegate

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Show banners even though our "app" is technically frontmost-capable.
        if #available(macOS 11.0, *) {
            completionHandler([.banner, .list, .sound])
        } else {
            completionHandler([.alert, .sound])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["handoffId"] as? Int ?? 0
        var action: String
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier: action = "open"
        case UNNotificationDismissActionIdentifier: action = "dismissed"
        default: action = response.actionIdentifier
        }
        log("action #\(id) \(action)")
        if action == "dismissed" || id == 0 {
            completionHandler()
            return
        }
        postAction(id: id, action: action) { completionHandler() }
    }

    func postAction(id: Int, action: String, done: @escaping () -> Void) {
        if port == 0, let p = readDaemonPort() { port = p }
        guard let url = URL(string: "http://127.0.0.1:\(port)/actions") else { done(); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["id": id, "action": action])
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req) { data, resp, error in
            if let error = error { log("post error: \(error.localizedDescription)") }
            else if let http = resp as? HTTPURLResponse, http.statusCode >= 300 {
                log("post failed: \(http.statusCode) \(String(data: data ?? Data(), encoding: .utf8) ?? "")")
            }
            done()
        }.resume()
    }
}

// MARK: main

var port = 0
var spawned = false
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--port"), i + 1 < args.count, let p = Int(args[i + 1]) {
    port = p
    spawned = true
}
if port == 0 { port = readDaemonPort() ?? 7391 }

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon
let delegate = App(port: port, spawned: spawned)
app.delegate = delegate
app.run()
