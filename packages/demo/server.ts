import express from "express"
import cors from "cors"
import { WebSocket } from "ws"

import {
  Message,
  IncomingChatMessage,
  BacklogMessage,
  BroadcastMessage,
} from "./types.js"

/* ********************************************************************************
 * Begin RA-HTTPS tunnel code.
 * ******************************************************************************** */
import {
  TunnelServer,
  ServerRAMockWebSocket,
  encryptedOnly,
  QuoteData,
} from "ra-https-tunnel"
import fs from "node:fs"
import { exec } from "node:child_process"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote } from "ra-https-qvl"

async function getQuote(x25519PublicKey: Uint8Array): Promise<QuoteData> {
  return await new Promise<QuoteData>(async (resolve, reject) => {
    // If config.json isn't set up, return a sample quote
    if (!fs.existsSync("config.json")) {
      console.log(
        "[ra-https-demo] TDX config.json not found, serving sample quote",
      )
      const { tappdV4Base64 } = await import("./shared/samples.js")
      resolve({
        quote: base64.decode(tappdV4Base64),
      })
      return
    }

    // Otherwise, get a quote from the SEAM (requires root)
    console.log("[ra-https-demo] Getting a quote for " + hex(x25519PublicKey))
    const userDataB64 = base64.encode(x25519PublicKey)
    const cmd = `trustauthority-cli evidence --tdx --user-data '${userDataB64}' -c config.json`
    exec(cmd, (err, stdout) => {
      if (err) {
        reject(err)
      }

      try {
        const response = JSON.parse(stdout)

        // TODO: Identify report_data binding
        const quote = base64.decode(response.tdx.quote)
        const parsed = parseTdxQuote(quote)
        const reportData = parsed.body.report_data

        console.log(reportData)
        console.log(hex(reportData))
        console.log(base64.encode(reportData))

        console.log("first 64", hex(reportData.slice(0, 32)))
        console.log("last 64", hex(reportData.slice(32)))

        resolve({
          quote: base64.decode(response.tdx.quote),
          verifier_data: response.verifier_data,
          runtime_data: response.runtime_data,
        })
      } catch (err) {
        reject(err)
      }
    })
  })
}

const app = express()
const { server, wss } = await TunnelServer.initialize(app, getQuote)

/* ********************************************************************************
 * End RA-HTTPS tunnel code.
 * ******************************************************************************** */

app.use(cors())
app.use(express.json())

let messages: Message[] = []
let totalMessageCount = 0
const MAX_MESSAGES = 30
const startTime = Date.now()
let counter = 0

// API Routes
app.get("/uptime", encryptedOnly(), (_req, res) => {
  const uptimeMs = Date.now() - startTime
  const uptimeSeconds = (Math.floor(uptimeMs) / 1000) % 60
  const uptimeMinutes = Math.floor(uptimeSeconds / 60) % 60
  const uptimeHours = Math.floor(uptimeMinutes / 60)

  const seconds = uptimeSeconds.toString().slice(0, 4)

  res.json({
    uptime: {
      formatted: `${uptimeHours ? uptimeHours + "h" : ""} ${
        uptimeMinutes ? uptimeMinutes + "m" : ""
      } ${seconds}s`,
    },
  })
})

/* ********************************************************************************
 * The encryptedOnly() middleware blocks direct requests from the Express server.
 * ******************************************************************************** */

app.post("/increment", encryptedOnly(), (_req, res) => {
  counter += 1
  res.json({ counter })
})

wss.on("connection", (ws: WebSocket) => {
  console.log("[ra-https-demo] Client connected")

  // Send message backlog to new client
  const hiddenCount = Math.max(0, totalMessageCount - messages.length)
  const backlogMessage: BacklogMessage = {
    type: "backlog",
    messages: messages,
    hiddenCount: hiddenCount,
  }
  ws.send(JSON.stringify(backlogMessage))

  ws.on("message", (data: Buffer) => {
    try {
      const message: IncomingChatMessage = JSON.parse(data.toString())

      if (message.type === "chat") {
        const chatMessage: Message = {
          id: Date.now().toString(),
          username: message.username,
          text: message.text,
          timestamp: new Date().toISOString(),
        }

        // Add to message history
        messages.push(chatMessage)
        totalMessageCount++

        // Keep only last 30 messages
        if (messages.length > MAX_MESSAGES) {
          messages = messages.slice(-MAX_MESSAGES)
        }

        // Broadcast to all connected clients
        const broadcastMessage: BroadcastMessage = {
          type: "message",
          message: chatMessage,
        }

        wss.clients.forEach((client: ServerRAMockWebSocket) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(broadcastMessage))
          }
        })
      }
    } catch (error) {
      console.error("[ra-https-demo] Error parsing message:", error)
    }
  })

  ws.on("close", () => {
    console.log("[ra-https-demo] Client disconnected")
  })
})

app.use(express.static("dist"))

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(
    `[ra-https-demo] WebSocket server running on http://localhost:${PORT}`,
  )
})
