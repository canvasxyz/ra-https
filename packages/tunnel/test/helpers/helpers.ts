import express, { Request, Response } from "express"
import type { AddressInfo } from "node:net"
import sodium from "libsodium-wrappers"

import { TunnelClient, TunnelServer } from "ra-https-tunnel"
import { tappdV4Base64, trusteeV5Base64, occlumSgxBase64 } from "./samples.js"
import { base64 } from "@scure/base"
import { hex, parseTdxQuote } from "ra-https-qvl"

// Ensure timers don't keep `npx ava --watch` alive (client sets 30s timeouts)
const originalSetTimeout = setTimeout
;(globalThis as any).setTimeout = ((fn: any, ms?: any, ...args: any[]) => {
  const handle: any = (originalSetTimeout as any)(fn, ms, ...args)
  if (handle && typeof handle.unref === "function") handle.unref()
  return handle
}) as any

// Polyfill CloseEvent for Node if missing
if (!(globalThis as any).CloseEvent) {
  class PolyfillCloseEvent extends Event {
    code: number
    reason: string
    wasClean: boolean
    constructor(type: string, init?: any) {
      super(type)
      this.code = init?.code ?? 1000
      this.reason = init?.reason ?? ""
      this.wasClean = Boolean(init?.wasClean)
    }
  }
  ;(globalThis as any).CloseEvent = PolyfillCloseEvent as any
}

export function loadQuote({
  sgx,
  tdxv4,
  tdxv5,
}: {
  sgx?: boolean
  tdxv4?: boolean
  tdxv5?: boolean
}): Uint8Array {
  if (sgx) {
    return base64.decode(occlumSgxBase64)
  } else if (tdxv4) {
    return base64.decode(tappdV4Base64)
  } else if (tdxv5) {
    return base64.decode(trusteeV5Base64)
  } else {
    throw new Error("loadQuote: must provide one of sgx, tdxv4, tdxv5")
  }
}

export async function startTunnelApp() {
  await sodium.ready
  const app = express()
  // Provide a simple default route used by several tests
  app.get("/hello", (_req, res) => res.status(200).send("world"))

  app.get("/hello", (_req, res) => res.status(200).send("world"))
  app.get("/ok", (_req, res) => res.status(200).send("ok"))
  app.post("/echo", (req: Request, res: Response) => {
    res.status(200).json({ received: req.body })
  })

  const quote = loadQuote({ tdxv4: true })
  const tunnelServer = await TunnelServer.initialize(app, async () => ({
    quote,
  }))

  await new Promise<void>((resolve) => {
    tunnelServer.server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = tunnelServer.server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  const quoteBodyParsed = parseTdxQuote(quote).body
  const tunnelClient = await TunnelClient.initialize(origin, {
    mrtd: hex(quoteBodyParsed.mr_td),
    report_data: hex(quoteBodyParsed.report_data),
  })

  return { tunnelServer, tunnelClient, origin }
}

export async function stopTunnel(
  tunnelServer: TunnelServer,
  tunnelClient: TunnelClient,
) {
  try {
    if (tunnelClient.ws) {
      tunnelClient.ws.onclose = () => {}
      tunnelClient.ws.close()
    }
  } catch {}

  await new Promise<void>((resolve) => {
    tunnelServer.wss.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    tunnelServer.server.close(() => resolve())
  })
}
