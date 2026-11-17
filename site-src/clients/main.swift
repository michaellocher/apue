import Foundation

// Api.swift: apue-types https://localhost:8443 --lang swift --out Api.swift
// Pinning a self-signed certificate works on Apple platforms; on Linux the system trust store decides.
let pem = try String(contentsOfFile: "cert.pem", encoding: .utf8)
let c = try Client(baseURL: URL(string: "https://localhost:8443")!, options: .init(pinnedCertificates: [pem]))

let todo = try await c.todosCreate(.init(title: "buy milk"))  // POST + Idempotency-Key
print(Int(todo.id), todo.title)

do {
  _ = try await c.todosCreate(.init(title: ""))
} catch let problem as ApueError {
  print(problem.status, problem.type)  // 400 https://michaellocher.github.io/apue/problems/validation-failed
}

for try await t in c.todosWatch() {  // a server stream; leaving the loop cancels it
  print(t.title)
}
