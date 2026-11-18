#!/usr/bin/env node
// opentunnel-mcp — expose local ports through a blind TLS tunnel (https://opentunnel.xyz)
// Wraps the official @opentunnel/client SDK. The MCP process holds the bridge
// connection, so tunnels stay up while opencode runs and go down when it quits
// (the Rust CLI's background service is Linux/macOS only, so this is the Windows path).
import process from "node:process"
import crypto from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as ot from "@opentunnel/client"

const { create } = ot
// Guarded: the SDK documents isValidRouteName; fall back to a DNS-label regex if absent.
const isValidRouteName =
  typeof ot.isValidRouteName === "function"
    ? ot.isValidRouteName
    : (name) => /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)

const NAME = "opentunnel"
const VERSION = "0.1.0"
const TARGET_RE = /^[a-zA-Z0-9._-]+:\d{1,5}$/

// ---- state -----------------------------------------------------------------
let client = null // lazy OpenTunnel SDK client
let connection = null // live tunnel connection (the bridge)
let routes = {} // SDK-shaped route map: name -> "host:port" | {target, proxyProtocol}
const events = [] // ring buffer of recent client events (for status/debug)

function getClient() {
  if (!client) client = create()
  return client
}

function noteEvent(event) {
  let text
  try {
    text = JSON.stringify(event)
  } catch {
    text = String(event)
  }
  events.push({ at: new Date().toISOString(), event: text.slice(0, 300) })
  if (events.length > 30) events.shift()
}

function randomName() {
  // e.g. "ot3f9a2c" — one lowercase DNS label, starts with a letter
  return "ot" + crypto.randomBytes(3).toString("hex")
}

function normalizeRoute(input) {
  // accepts "127.0.0.1:3000" or { target, proxy_protocol }
  if (typeof input === "string") {
    if (!TARGET_RE.test(input)) throw new Error(`invalid target "${input}" (expected host:port)`)
    return input
  }
  if (input && typeof input === "object" && typeof input.target === "string") {
    if (!TARGET_RE.test(input.target)) throw new Error(`invalid target "${input.target}" (expected host:port)`)
    if (input.proxy_protocol !== undefined && !["v1", "v2"].includes(input.proxy_protocol)) {
      throw new Error(`proxy_protocol must be "v1" or "v2"`)
    }
    return { target: input.target, proxyProtocol: input.proxy_protocol }
  }
  throw new Error(`route must be a "host:port" string or { target, proxy_protocol }`)
}

function displayRoutes() {
  const out = {}
  for (const [name, r] of Object.entries(routes)) {
    out[name] = typeof r === "string" ? r : `${r.target} (proxy-protocol ${r.proxyProtocol})`
  }
  return out
}

// ---- tools -----------------------------------------------------------------
const server = new McpServer({ name: NAME, version: VERSION })

function tool(name, description, schema, fn) {
  server.tool(name, description, schema, async (args) => {
    try {
      const result = await fn(args ?? {})
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `${name} failed: ${err?.message ?? String(err)}` }],
      }
    }
  })
}

tool(
  "status",
  "Show the OpenTunnel state: tunnel identity (hostname), whether the bridge is connected, current routes with their public URLs, and recent events",
  {},
  async () => {
    const identity = await getClient().tunnel.get().catch(() => undefined)
    return {
      connected: Boolean(connection),
      hostname: identity?.hostname ?? null,
      tunnel_id: identity?.id ?? null,
      routes: displayRoutes(),
      urls: connection ? connection.urls : null,
      connection_status: connection ? connection.status() : "closed",
      recent_events: events.slice(-10),
      hint: connection ? null : "not connected — call expose to bring the tunnel up",
    }
  },
)

tool(
  "expose",
  "Expose a local port (or explicit target) through the tunnel and return its public HTTPS URL. Merges into the current routes. First call creates the tunnel and may take a minute (certificate issuance)",
  {
    port: z.number().int().min(1).max(65535).optional().describe("Local port; target becomes 127.0.0.1:<port>"),
    target: z.string().optional().describe('Explicit target as "host:port" (e.g. "127.0.0.1:8765")'),
    name: z.string().optional().describe("Route name = subdomain label (omit for a random unguessable name, '@' for the bare hostname)"),
    proxy_protocol: z.enum(["v1", "v2"]).optional().describe("Send a PROXY protocol header with the visitor's address to the target"),
  },
  async ({ port, target, name, proxy_protocol }) => {
    if (port === undefined && target === undefined) throw new Error("pass port or target")
    if (port !== undefined && target !== undefined) throw new Error("pass port or target, not both")
    const target_ = target ?? `127.0.0.1:${port}`
    const name_ = name ?? randomName()
    if (!isValidRouteName(name_)) {
      throw new Error(`invalid route name "${name_}" (one lowercase DNS label, or "@")`)
    }
    const route = normalizeRoute(proxy_protocol ? { target: target_, proxy_protocol } : target_)
    const next = { ...routes, [name_]: route }
    if (connection) {
      await connection.setRoutes(next)
    } else {
      connection = await getClient().tunnel.connect({ routes: next, onEvent: noteEvent })
    }
    routes = next
    return {
      name: name_,
      url: connection.urls[name_] ?? null,
      urls: connection.urls,
      routes: displayRoutes(),
    }
  },
)

tool(
  "set_routes",
  "Replace ALL routes at once (like the CLI's route list hand-edit). Pass {} to unexpose everything while staying connected",
  {
    routes: z
      .record(
        z.string(),
        z.union([z.string(), z.object({ target: z.string(), proxy_protocol: z.enum(["v1", "v2"]).optional() })]),
      )
      .describe('Map of route name -> "host:port" or { target, proxy_protocol }'),
  },
  async ({ routes: input }) => {
    const next = {}
    for (const [name, value] of Object.entries(input)) {
      if (!isValidRouteName(name)) throw new Error(`invalid route name "${name}" (one lowercase DNS label, or "@")`)
      next[name] = normalizeRoute(value)
    }
    if (connection) {
      await connection.setRoutes(next)
    } else if (Object.keys(next).length > 0) {
      connection = await getClient().tunnel.connect({ routes: next, onEvent: noteEvent })
    }
    routes = next
    return { urls: connection ? connection.urls : null, routes: displayRoutes() }
  },
)

tool(
  "close",
  "Disconnect the tunnel bridge (routes are cleared; the tunnel identity and its hostname are kept for reuse)",
  {},
  async () => {
    if (!connection) return { connected: false }
    try {
      await connection.close()
    } finally {
      connection = null
      routes = {}
    }
    return { connected: false, closed: true }
  },
)

tool(
  "delete_tunnel",
  "Permanently delete the tunnel — its hostname is lost for good. Requires confirm: true",
  { confirm: z.boolean().describe("Must be true — this cannot be undone") },
  async ({ confirm }) => {
    if (confirm !== true) throw new Error('pass confirm: true — this deletes the tunnel hostname for good')
    if (connection) {
      try {
        await connection.close()
      } catch {
        // already closed
      }
      connection = null
      routes = {}
    }
    await getClient().tunnel.remove()
    return { deleted: true }
  },
)

// ---- lifecycle -------------------------------------------------------------
async function shutdown() {
  try {
    await client?.dispose()
  } catch {
    // best effort
  }
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

const transport = new StdioServerTransport()
transport.onclose = () => {
  shutdown()
}
await server.connect(transport)
console.error(`[opentunnel-mcp] ready (v${VERSION}, node ${process.version})`)
