## ra-https-qvl

ra-https-qvl is a lightweight, WebCrypto-based SGX/TDX quote verification library written in TypeScript (ESM). It provides full chain-of-trust validation from the Intel SGX Root CA, through quoting enclave checks, down to quote signature verification.

## Features

- **TDX v4/v5 and SGX v3** quote parsing and validation
- **Certificate chain** validation to Intel SGX Root CA (ECDSA)
- **CRL-based revocation** checks (DER CRL parsing helper included)
- **QE report signature** and **QE binding** verification
- **Quote signature** verification (ECDSA P‑256)
- Small API surface; zero native dependencies

## Requirements

- Node.js 20+ (WebCrypto `crypto.subtle`)
- ESM environment (`"type": "module"`)

## Quickstart

```ts
import { verifyTdx } from "ra-https-qvl"

const ok = await verifyTdx(quote, {
  date: Date.now(),     // verification time (ms)
  crls: [],             // optional: array of DER CRLs as Uint8Array
})
```

```ts
import { verifySgx } from "ra-https-qvl"

const ok = await verifySgx(quoteBytes, {
  date: Date.now(),
  crls: [],
})
```

If cert_data is missing in the quote, you can provide the leaf, intermediate, and root PEMs via `extraCertdata`.

You can also provide alternative pinned root certificates. We embed the Intel SGX Root CA and use it as a default otherwise.

```ts
import { verifyTdx, QV_X509Certificate } from "ra-https-qvl"

const rootPem = "-----BEGIN CERTIFICATE-----..." // Intel SGX Root CA PEM
const intermediatePem = "-----BEGIN CERTIFICATE-----..."
const leafPem = "-----BEGIN CERTIFICATE-----..."

await verifyTdx(quoteBytes, {
  date: Date.now(),
  extraCertdata: [leafPem, intermediatePem, rootPem],
  // Optional: pin the expected root certificate object
  pinnedRootCerts: [new QV_X509Certificate(rootPem)],
  crls: [],
})
```

## API

- `verifyTdx(quote: Uint8Array, config?: VerifyConfig): Promise<boolean>`
- `verifyTdxBase64(quote: string, config?: VerifyConfig): Promise<boolean>`
- `verifySgx(quote: Uint8Array, config?: VerifyConfig): Promise<boolean>`
- `verifySgxBase64(quote: string, config?: VerifyConfig): Promise<boolean>`

Verification performs:
- PCK chain build and validation (leaf → intermediate → root)
- Chain validity window checks against `config.date` (or now)
- Optional CRL membership checks via `config.crls`
- Root pinning against Intel SGX Root CA by default (override via `pinnedRootCerts`)
- QE report signature verification
- QE binding check between `attestation_public_key` and QE report data
- Quote signature verification by `attestation_public_key`

Errors are thrown for invalid conditions (e.g. "invalid root", "invalid cert chain", "expired cert chain, or not yet valid", "revoked certificate in cert chain", "invalid qe report signature", "invalid qe report binding", "invalid signature over quote", "only TDX/SGX is supported", "only ECDSA att_key_type is supported", "only PCK cert_data is supported", "missing certdata", "Unsupported quote version").

### Configuration

```ts
export interface VerifyConfig {
  crls: Uint8Array[]                 // DER CRLs for revocation checks (optional; [] if none)
  pinnedRootCerts?: QV_X509Certificate[]
  date?: number                      // ms since epoch; defaults to now
  extraCertdata?: string[]           // PEM blocks when quote lacks embedded cert_data
}
```

Defaults: `pinnedRootCerts` pins Intel SGX Root CA. Provide your own to narrow trust.

### Parsers

- `parseTdxQuote(quote: Uint8Array)` / `parseTdxQuoteBase64(quote: string)`
- `parseSgxQuote(quote: Uint8Array)` / `parseSgxQuoteBase64(quote: string)`

These return `{ header, body, signature }` views with typed fields:
- TDX: v4 or v5 supported (TEE type 129)
- SGX: v3 supported (TEE type 0)

### Formatters

Human‑readable JSON views for logging:
- `formatTDXHeader(header)`
- `formatTDXQuoteBodyV4(body)`
- `formatTdxSignature(signature)`

## Limitations

- No TCB checks (for now)
- Only ECDSA attestation key (P‑256) is supported (for now)
- Only DCAP `cert_data` type 5 is supported
- QE report must be present for QE signature/binding checks

## License

MIT (C) 2025
