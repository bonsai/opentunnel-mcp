// End-to-end test for opentunnel-mcp.
// Spawns the MCP server, speaks the stdio protocol (NDJSON), exposes a local
// HTTP server through a real tunnel, and fetches the public URL.
// Creates a real tunnel on opentunnel.xyz (free, no account; the profile's
// identity is kept on disk for reuse). First run may take a minute: the
// tunnel's certificate is issued through ZeroSSL.
import http from "node:http"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import path from "node:path"

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js")
const OVERALL_TIMEOUT_MS = 6 * 60 * 1000

const timer = setTimeout(() => {
  console.error("E2E FAIL: overall timeout")
  process.exit(1)
}, OVERALL_TIMEOUT_MS)

// 1. local target server on an ephemeral port
const target = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" })
  res.end(`opentunnel-mcp e2e ${req.url}`)
})
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve))
const targetPort = target.address().port
console.log(`[e2e] local target on 127.0.0.1:${targetPort}`)

// 2. spawn the MCP server
const child = spawn(process.execPath, [INDEX], { stdio: ["pipe", "pipe", "pipe"] })
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`))
child.on("exit", (code, signal) => console.log(`[e2e] server exited (${code ?? signal})`))

let nextId = 1
const pending = new Map()
const rl = createInterface({ input: child.stdout })
rl.on("line", (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

function send(method, params) {
  const id = nextId++
  const wire = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${method}`))
    }, 4 * 60 * 1000)
    pending.set(id, (msg) => {
      clearTimeout(t)
      resolve(msg)
    })
    child.stdin.write(wire)
  })
}

function parseResult(msg) {
  if (msg.error) throw new Error(`tool error: ${msg.error.message ?? JSON.stringify(msg.error)}`)
  return JSON.parse(msg.result.content[0].text)
}

try {
  // 3. handshake
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "opentunnel-mcp-e2e", version: "0.0.1" },
  })
  console.log(`[e2e] initialized: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

  // 4. expose the local port (creates the tunnel + certificate on first run)
  console.log("[e2e] calling expose (first run may take a minute for certificate issuance)...")
  const exposed = parseResult(await send("tools/call", { name: "expose", arguments: { port: targetPort } }))
  const url = exposed.url
  if (!url) throw new Error(`expose returned no url: ${JSON.stringify(exposed)}`)
  console.log(`[e2e] public URL: ${url}`)

  // 5. fetch the public URL through the real tunnel
  let ok = false
  for (let attempt = 1; attempt <= 10 && !ok; attempt++) {
    try {
      const res = await fetch(url)
      const body = await res.text()
      console.log(`[e2e] fetch attempt ${attempt}: HTTP ${res.status} "${body.trim()}"`)
      if (res.status === 200 && body.includes("opentunnel-mcp e2e")) ok = true
    } catch (err) {
      console.log(`[e2e] fetch attempt ${attempt} failed: ${err.cause?.code ?? err.message}`)
    }
    if (!ok) await new Promise((r) => setTimeout(r, 5000))
  }
  if (!ok) throw new Error("public URL never returned the expected body")

  // 6. status / set_routes / close
  const status = parseResult(await send("tools/call", { name: "status", arguments: {} }))
  console.log(`[e2e] status: connected=${status.connected} hostname=${status.hostname}`)
  if (!status.connected) throw new Error("status says not connected")
  const cleared = parseResult(
    await send("tools/call", { name: "set_routes", arguments: { routes: {} } }),
  )
  console.log(`[e2e] set_routes({}) -> urls=${JSON.stringify(cleared.urls)}`)
  const closed = parseResult(await send("tools/call", { name: "close", arguments: {} }))
  console.log(`[e2e] close -> ${JSON.stringify(closed)}`)
  if (closed.connected !== false) throw new Error("close did not disconnect")

  console.log("E2E PASS")
} catch (err) {
  console.error(`E2E FAIL: ${err.message}`)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  child.kill()
  target.close()
  setTimeout(() => process.exit(process.exitCode ?? 0), 500)
}
