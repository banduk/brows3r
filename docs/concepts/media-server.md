# Media loopback server

The WebView needs URLs it can dereference (for `<img>`, `<video>`,
`<audio>`, `<iframe>`, and `fetch()` calls from pdf.js). Streaming S3
bytes through IPC would burn CPU and serialise around the Rust runtime.
The fix is a loopback HTTP server.

## Topology

```
WebView                        Rust process
─────────                      ────────────
<video src="…">                ┌──────────────────────────┐
   │                           │  media_server (axum)     │
   │ HTTP GET                  │   listening on           │
   │  /m/<token>               │   127.0.0.1:<random>     │
   ├──────────────────────────►│                          │
   │                           │   token registry         │
   │                           │   ↓                      │
   │                           │   s3_client_pool         │
   │                           │   ↓ aws-sdk-s3 GetObject │
   │                           │                          │
   │  bytes (chunked) +        │                          │
   │  ACAO: *                  │                          │
   │◄──────────────────────────┤                          │
   ▼                           └──────────────────────────┘
```

## Lifecycle of a media request

1. **Mint token.** The React component calls `mediaRegister(profileId,
   bucket, key)` over IPC. Rust generates a 32-byte random token, records
   `{token → (profileId, bucket, key, sessionId, mintedAt)}` in the
   in-memory `TokenRegistry`, and returns a URL of the form
   `http://127.0.0.1:<port>/m/<token>`.
2. **WebView dereferences.** The HTML element (or pdf.js' `fetch`) loads
   from the URL. The browser is happy because it's same-machine and the
   server emits `Access-Control-Allow-Origin: *`.
3. **Server validates.** The token registry looks up the record. Three
   outcomes:
   - Not found → 404.
   - Found but session-revoked or expired → 403 + emit
     `media:revoked` event with the URL.
   - Valid → continue.
4. **Server streams.** Rust builds the S3 client from the pool, issues
   `GetObject` (with optional `Range` if the browser sent one), and pipes
   the response body to the WebView. Response headers carry the original
   `Content-Type`, `Content-Length`, and `Content-Range` (for partial
   content).
5. **Component unmounts.** React's cleanup calls `mediaRevoke(token)`,
   removing the registry entry.

## Why CORS matters

`<img>`, `<video>`, `<audio>` with `src=` (no `crossorigin` attribute)
bypass CORS — the browser displays the bytes without asking. **pdf.js**
is different: react-pdf uses `fetch()` under the hood, and `fetch()`
enforces CORS by default.

Without `Access-Control-Allow-Origin: *` the PDF preview surfaced
`UnknownErrorException: Load failed` on every load. The header is now
emitted by every response from the loopback server. A `*` value is safe
in this context: the tokens are unguessable, brows3r mints the URLs, and
nothing else on the machine knows the random port number.

## Threat model

| Attacker | Has? | Mitigation |
|---|---|---|
| Other process on the same machine | Knows nothing; tokens are unguessable | n/a (information-theoretic) |
| Browser extension in the WebView | The same access as the rest of the WebView | Out of scope; Tauri's sandboxing applies |
| Compromised npm dep | Can call `fetch('http://127.0.0.1:?/m/?')` randomly | Would need both the port AND a valid token; tokens are mint-on-demand and short-lived |
| Stack overflow in axum router | Could read past the token? | axum is parameterised; tokens come from a static map, not user-controllable indexing |

## Session revocation

When the user quits the app, `revoke_session(session_id)` walks the
registry and drops every entry tagged with that session. The
`MediaServerHandle` then triggers graceful shutdown via the oneshot
channel, and the port is freed.

The session ID is a UUIDv4 minted at app start. Tokens carry it so that a
sequence like "quit, reopen, paste an old loopback URL" cannot dereference
into the new session.

## Performance

`reqwest` (the SDK's HTTP client) and `axum` both stream byte-by-byte
without buffering the body. A 4 GB MP4 preview holds at most ~64 KB in
memory at any moment (the size of `ReaderStream`'s internal chunk).

Range requests pass through 1:1: when the user seeks in `<video>`, the
browser sends `Range: bytes=20480000-`, brows3r forwards `Range:
bytes=20480000-` to S3, and the response is 206 Partial Content end-to-end.
