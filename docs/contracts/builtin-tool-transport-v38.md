---
document_type: protocol-contract
contract: builtin-tool-transport-v38
authority: builtin-tool-transport
status: accepted
version: 38
last_updated: 2026-10-13
---

# Built-in Tool Transport v38

Inherits [v37](builtin-tool-transport-v37.md), with Transport/CLI 38, capability
`builtin_cli.transport.v38`, IPC 3 and Envelope 2. Operation inputs, Agent Output 10,
permissions, leases, request correlation, idempotency and error recovery are unchanged.

## Result and catalog

Envelope 2 contains `contractVersion`, `ok`, `operation`, `requestId`, and exactly one of
`result` or `error`. It has no digest receipt. Construction and decoding validate ordinary
field structure, request identity and the operation result; neither hashes the full result.
The CLI continues emitting the same operation-specific JSON. Old IPC versions are rejected
before operation dispatch, so a response format mismatch cannot follow an executed command.

Catalog list/description and Core health no longer expose `catalogDigest` or
`builtinToolCatalogDigest`. Static definitions and the assembled catalog are initialized once
per process. List/help/description reuse them; returned values cannot mutate the cache.
Runtime process compatibility no longer includes this digest. Actual incompatible interface
changes use the existing protocol versions; description, examples and help edits have no
independent compatibility identity. External MCP and current Run authorization remain separate.

Historical execution envelopes and recorded evaluation artifacts remain readable as historical
JSON. New evaluation artifacts use protocol versions without a required catalog fingerprint.
Ship Core and CLI together. An old binary is not a supported writer for the new storage schema.

## Member avatar input

`member.create` and `member.update` accept run-readable PNG, JPEG or GIF through
`avatarFile`, retaining the existing single-command confirmation and retry semantics.
GIF is passed intact; Core applies the same square crop to every composited frame and
preserves frame timing and absent, finite or infinite looping. Agents do not select frames.
The original input remains limited to 10 MiB and at least 256×256 pixels. GIF additionally
allows at most 200 frames and 128 million cumulative decoded canvas pixels; APNG and WebP
are not admitted. PNG vendor data after IEND is tolerated only at upload and removed during
normalization; GIF non-rendering metadata is removed while playback extensions are retained.
Existing controlled assets are re-cropped by reference under normalized asset limits, not
the original upload minimum.
