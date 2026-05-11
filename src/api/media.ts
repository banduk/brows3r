/**
 * API module for the loopback media server.
 *
 * The media server is an axum HTTP server bound to `127.0.0.1:0` at app
 * start. `mediaRegister` mints a signed session token and returns a loopback
 * URL that the frontend embeds directly as a `<video>` or `<audio>` `src`.
 * The browser's byte-range requests are proxied transparently to S3, enabling
 * video seeking.
 *
 * Tokens expire after 1 hour or on session end, whichever is first.
 *
 * OCP: adding a new kind of media operation (e.g. thumbnail URL) is one new
 * function here + one new Rust command — this module's shape does not change.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Response returned by `mediaRegister`.
 *
 * Mirrors `src-tauri/src/commands/media_cmd.rs` MediaRegisterResponse.
 */
export interface MediaRegisterResponse {
  /**
   * Loopback URL ready to use as a `<video>` or `<audio>` `src`.
   *
   * Format: `http://127.0.0.1:<port>/m/<token>`
   */
  url: string;
  /**
   * Unix epoch **seconds** at which the token expires.
   *
   * Use this to schedule a token refresh before playback stalls.
   */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Mint a signed session token for the given S3 object and return a loopback URL.
 *
 * The URL can be set directly as the `src` attribute of a `<video>` or
 * `<audio>` element. The loopback server handles byte-range requests so video
 * seeking works without the frontend doing anything special.
 *
 * The token expires after 1 hour or when the session ends. Use `expiresAt` to
 * schedule a pre-emptive refresh before the token lapses.
 *
 * @param profileId - The profile whose credentials service the stream.
 * @param bucket    - S3 bucket containing the object.
 * @param key       - Full S3 object key.
 */
export function mediaRegister(
  profileId: string,
  bucket: string,
  key: string,
): Promise<MediaRegisterResponse> {
  return invoke<MediaRegisterResponse>("media_register", {
    profileId,
    bucket,
    key,
  });
}

/**
 * Immediately revoke a single media token.
 *
 * After revocation any request using the token returns 403. The backend emits
 * a `media:revoked` event so UI components subscribed to it can react.
 *
 * This call is idempotent — revoking an already-revoked or unknown token is
 * not an error.
 *
 * @param token - The token string from `MediaRegisterResponse.url`.
 */
export function mediaRevoke(token: string): Promise<void> {
  return invoke<void>("media_revoke", { token });
}
