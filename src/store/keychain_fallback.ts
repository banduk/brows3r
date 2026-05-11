/**
 * Zustand slice tracking keychain fallback prompt session state.
 *
 * `hasShownKeychainFallback` — true once the prompt has been displayed this
 * session. NOT persisted to localStorage so it resets every app launch.
 * This ensures users on the FileBackend are reminded to enter their
 * passphrase every session.
 */

import { create } from "zustand";

interface KeychainFallbackState {
  /** Whether the fallback prompt has been shown this session. */
  hasShownKeychainFallback: boolean;
  /** Mark the prompt as shown for this session. */
  markShown(): void;
}

export const useKeychainFallbackStore = create<KeychainFallbackState>()(
  (set) => ({
    hasShownKeychainFallback: false,
    markShown: () => set({ hasShownKeychainFallback: true }),
  }),
);
