/**
 * Zustand slice tracking keychain fallback prompt state.
 *
 * `hasShownKeychainFallback` — true once the prompt has been displayed in
 * the current session. In-memory gate that suppresses repeat prompts within
 * a single launch.
 *
 * `hasUnlockedKeychainFallback` — true once the user has successfully set
 * a passphrase via `keychain_fallback_unlock`. Persisted to localStorage
 * so subsequent app launches do not pester the user with the same dialog
 * after they have already configured the FileBackend. The backend can still
 * emit `keychain:fallback-required` on every start, but the prompt stays
 * closed until the user explicitly resets via Settings.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface KeychainFallbackState {
  /** Whether the fallback prompt has been shown this session. */
  hasShownKeychainFallback: boolean;
  /** Whether the user has supplied a passphrase at least once. */
  hasUnlockedKeychainFallback: boolean;
  /** Mark the prompt as shown for this session. */
  markShown(): void;
  /** Mark the keychain as unlocked (sticky across launches). */
  markUnlocked(): void;
  /** Reset the persisted "unlocked" flag so the next event re-prompts. */
  resetKeychainFallback(): void;
}

export const useKeychainFallbackStore = create<KeychainFallbackState>()(
  persist(
    (set) => ({
      hasShownKeychainFallback: false,
      hasUnlockedKeychainFallback: false,
      markShown: () => set({ hasShownKeychainFallback: true }),
      markUnlocked: () => set({ hasUnlockedKeychainFallback: true }),
      resetKeychainFallback: () => set({ hasUnlockedKeychainFallback: false }),
    }),
    {
      name: "brows3r:keychain-fallback",
      // Only the sticky "unlocked" flag is persisted; the per-session gate
      // resets every launch by design.
      partialize: (state) => ({
        hasUnlockedKeychainFallback: state.hasUnlockedKeychainFallback,
      }),
    },
  ),
);
