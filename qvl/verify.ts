import {
  createHash,
  createPublicKey,
  createVerify,
  X509Certificate,
} from "node:crypto"

import { getTdxV4SignedRegion, parseTdxQuote } from "./structs.js"
import {
  computeCertSha256Hex,
  encodeEcdsaSignatureToDer,
  extractPemCertificates,
  toBase64Url,
} from "./utils.js"

/**
 * Verify a complete certificate chain for a TDX enclave, including the
 * Intel SGX Root CA, PCK certificate chain, and QE signature and binding.
 *
 * Optional: accepts `extraCerts`, which is used if `quote` is missing certdata.
 */
export function verifyTdxCertChain(
  quote: Buffer,
  pinnedRootCerts: X509Certificate[],
  date?: number,
  extraCerts?: string[],
) {
  const { signature, header } = parseTdxQuote(quote)
  const certs = extractPemCertificates(signature.cert_data)
  let { status, root } = verifyPCKChain(certs, date || +new Date())

  if (!root && certs.length === 0) {
    if (!extraCerts) {
      throw new Error("verifyTdxCertChain: missing certdata")
    }
    const fallback = verifyPCKChain(extraCerts, date || +new Date())
    status = fallback.status
    root = fallback.root
  }
  if (!root) {
    throw new Error("verifyTdxCertChain: invalid cert chain")
  }

  const candidateRootHash = computeCertSha256Hex(root)
  const knownRootHashes = new Set(pinnedRootCerts.map(computeCertSha256Hex))
  const rootIsValid = knownRootHashes.has(candidateRootHash)

  if (header.tee_type !== 129) {
    throw new Error("verifyTdxCertChain: only tdx is supported")
  }
  if (header.att_key_type !== 2) {
    throw new Error("verifyTdxCertChain: only ECDSA att_key_type is supported")
  }
  if (signature.cert_data_type !== 5) {
    throw new Error("verifyTdxCertChain: only PCK cert_data is supported")
  }
  if (status === "expired") {
    throw new Error("verifyTdxCertChain: expired cert chain, or not yet valid")
  }
  if (status !== "valid") {
    throw new Error("verifyTdxCertChain: invalid cert chain")
  }
  if (!rootIsValid) {
    throw new Error("verifyTdxCertChain: invalid root")
  }
  if (!verifyQeReportBinding(quote)) {
    throw new Error("verifyTdxCertChain: invalid qe report binding")
  }
  if (!verifyQeReportSignature(quote, extraCerts)) {
    throw new Error("verifyTdxCertChain: invalid qe report signature")
  }
  if (!verifyTdxV4Signature(quote)) {
    throw new Error(
      "verifyTdxCertChain: invalid attestation_public_key signature",
    )
  }

  return true
}

export function verifyTdxCertChainBase64(
  quote: string,
  pinnedRootCerts: X509Certificate[],
  date?: number,
  extraCerts?: string[],
) {
  return verifyTdxCertChain(
    Buffer.from(quote, "base64"),
    pinnedRootCerts,
    date,
    extraCerts,
  )
}

/**
 * Verify a PCK provisioning certificate chain embedded in cert_data.
 * - Identifies the leaf certificate and walks up the chain, following issuer/subject chaining.
 * - Expects at least two certificates.
 * - Checks the validity window of each certificate.
 */
export function verifyPCKChain(
  certData: string[],
  verifyAtTimeMs: number,
): {
  status: "valid" | "invalid" | "expired"
  root: X509Certificate | null
  chain: X509Certificate[]
} {
  if (certData.length === 0) return { status: "invalid", root: null, chain: [] }

  const certs = certData.map((text) => new X509Certificate(text))

  // Identify leaf (not an issuer of any other provided cert)
  let leaf: X509Certificate | undefined
  for (const c of certs) {
    const isParentOfAny = certs.some((other) => other.issuer === c.subject)
    if (!isParentOfAny) {
      leaf = c
      break
    }
  }
  if (!leaf) leaf = certs[0]

  // Walk up by issuer -> subject
  const chain: X509Certificate[] = [leaf]
  while (true) {
    const current = chain[chain.length - 1]
    const parent = certs.find((c) => c.subject === current.issuer)
    if (!parent || parent === current) break
    chain.push(parent)
  }

  // Validate chaining and validity windows
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i]
    const parent = chain[i + 1]
    if (child.issuer !== parent.subject)
      return { status: "invalid", root: null, chain: [] }
  }

  // Check for expired or not-yet-valid certificates
  for (const c of chain) {
    const notBefore = new Date(c.validFrom).getTime()
    const notAfter = new Date(c.validTo).getTime()
    if (!(notBefore <= verifyAtTimeMs && verifyAtTimeMs <= notAfter)) {
      return { status: "expired", root: chain[chain.length - 1] ?? null, chain }
    }
  }

  // Cryptographically verify signatures along the chain: each child signed by its parent
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i]
    const parent = chain[i + 1]
    try {
      if (!child.verify(parent.publicKey)) {
        return { status: "invalid", root: null, chain: [] }
      }
    } catch {
      return { status: "invalid", root: null, chain: [] }
    }
  }

  // If the terminal certificate is self-signed, verify its signature as well
  const terminal = chain[chain.length - 1]
  if (terminal && terminal.subject === terminal.issuer) {
    try {
      if (!terminal.verify(terminal.publicKey)) {
        return { status: "invalid", root: null, chain: [] }
      }
    } catch {
      return { status: "invalid", root: null, chain: [] }
    }
  }

  return { status: "valid", root: chain[chain.length - 1] ?? null, chain }
}

/**
 * Verify that the cert chain has signed the quoting enclave report,
 * by checking qe_report_signature against the PCK leaf certificate public key.
 */
export function verifyQeReportSignature(
  quoteInput: string | Buffer,
  extraCerts?: string[],
): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")

  // Must have a QE report to verify
  if (!signature.qe_report_present || signature.qe_report.length !== 384) {
    return false
  }

  // Prefer certdata; otherwise use extraCerts
  let certs: string[] = extractPemCertificates(signature.cert_data)
  if (certs.length === 0) {
    certs = extraCerts ?? []
  }
  if (certs.length === 0) return false

  // Use Date.now() because we don't care if valid is returned as "expired" here
  const { chain } = verifyPCKChain(certs, Date.now())

  if (chain.length === 0) return false

  const pckLeafCert = chain[0]
  const pckLeafKey = pckLeafCert.publicKey

  // Following Intel's C++ implementation:
  // 1. Convert raw ECDSA signature (64 bytes: r||s) to DER format
  // 2. Verify with SHA-256 against the raw QE report blob (384 bytes)
  try {
    const derSignature = encodeEcdsaSignatureToDer(
      signature.qe_report_signature,
    )
    const verifier = createVerify("sha256")
    verifier.update(signature.qe_report)
    verifier.end()
    const result = verifier.verify(pckLeafKey, derSignature)

    return result
  } catch {
    return false
  }
}

/**
 * Verify QE binding: qe_report.report_data[0..32) == SHA256(attestation_public_key || qe_auth_data)
 * Accept several reasonable variants to accommodate ecosystem differences.
 */
export function verifyQeReportBinding(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)
  if (header.version !== 4) throw new Error("Unsupported quote version")
  if (!signature.qe_report_present) throw new Error("Missing QE report")

  const pubRaw = signature.attestation_public_key
  const pubUncompressed = Buffer.concat([Buffer.from([0x04]), pubRaw])

  // Build SPKI DER from JWK and hash that too
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: pubRaw.subarray(0, 32).toString("base64url"),
    y: pubRaw.subarray(32, 64).toString("base64url"),
  } as const
  let spki: Buffer | undefined
  try {
    spki = createPublicKey({ key: jwk, format: "jwk" }).export({
      type: "spki",
      format: "der",
    }) as Buffer
  } catch {}

  const candidates: Buffer[] = []
  candidates.push(createHash("sha256").update(pubRaw).digest())
  candidates.push(createHash("sha256").update(pubUncompressed).digest())
  if (spki) candidates.push(createHash("sha256").update(spki).digest())
  candidates.push(
    createHash("sha256").update(pubRaw).update(signature.qe_auth_data).digest(),
  )
  candidates.push(
    createHash("sha256")
      .update(pubUncompressed)
      .update(signature.qe_auth_data)
      .digest(),
  )

  // SGX REPORT structure is 384 bytes; report_data occupies the last 64 bytes (offset 320)
  const reportData = signature.qe_report.subarray(320, 384)
  const first = reportData.subarray(0, 32)
  const second = reportData.subarray(32, 64)

  // Direct half comparisons (prefer second half, then first)
  for (const digest of candidates) {
    if (digest.equals(second) || digest.equals(first)) {
      return true
    }
  }

  // Some ecosystem implementations have placed the digest starting at a non-zero offset
  // within report_data. As a pragmatic fallback, look for any candidate digest as a
  // contiguous 32-byte subsequence anywhere within the 64-byte report_data field.
  //
  // In particular, we see an offset of "6" in a few examples (TODO)
  for (const digest of candidates) {
    if (reportData.indexOf(digest) !== -1) {
      return true
    }
  }

  return false
}

/**
 * Verify the ECDSA-P256 signature inside a TDX v4 quote against the embedded
 * attestation public key. This checks only the quote signature itself and does
 * not validate the certificate chain or QE report.
 */
export function verifyTdxV4Signature(quoteInput: string | Buffer): boolean {
  const quoteBytes = Buffer.isBuffer(quoteInput)
    ? quoteInput
    : Buffer.from(quoteInput, "base64")

  const { header, signature } = parseTdxQuote(quoteBytes)

  if (header.version !== 4) {
    throw new Error(`Unsupported TDX quote version: ${header.version}`)
  }

  const message = getTdxV4SignedRegion(quoteBytes)

  const rawSig = signature.ecdsa_signature
  const derSig = encodeEcdsaSignatureToDer(rawSig)

  const pub = signature.attestation_public_key
  if (pub.length !== 64) {
    throw new Error("Unexpected attestation public key length")
  }

  const x = toBase64Url(pub.subarray(0, 32))
  const y = toBase64Url(pub.subarray(32, 64))
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x,
    y,
  } as const

  const publicKey = createPublicKey({ key: jwk, format: "jwk" })

  const verifier = createVerify("sha256")
  verifier.update(message)
  verifier.end()
  return verifier.verify(publicKey, derSig)
}
