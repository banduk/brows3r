/**
 * KeychainFallbackPrompt — modal shown when the OS keychain is unavailable.
 *
 * Listens for the `keychain:fallback-required` Tauri event. Displays once
 * per session (tracked in `useKeychainFallbackStore`). The user enters a
 * passphrase (with confirmation) which is forwarded to the Rust backend via
 * `keychainFallbackUnlock`.
 *
 * A11y: Dialog with labelled title, described fields, sr-only labels.
 *
 * OCP: The rest of the app does not import this component; it is wired into
 * the shell layout as an opt-in slot that only activates via the event.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { keychainFallbackUnlock } from "@/api/profiles";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listen } from "@/lib/tauri";
import { useKeychainFallbackStore } from "@/store/keychain_fallback";

// ---------------------------------------------------------------------------
// useKeychainFallback — hook
// ---------------------------------------------------------------------------

/**
 * Listens for `keychain:fallback-required` and opens the prompt exactly
 * once per session. Returns the open state and a close handler so the
 * prompt component can be controlled from outside.
 *
 * Mount this hook in the shell layout so it is always active.
 */
export function useKeychainFallback(): {
  open: boolean;
  closePrompt(): void;
} {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen("keychain:fallback-required", () => {
      // Read the current store state directly (not from a stale closure) so
      // the gates are always evaluated against the live value.
      const {
        hasShownKeychainFallback,
        hasUnlockedKeychainFallback,
        markShown,
      } = useKeychainFallbackStore.getState();
      // Sticky gate: if the user has already configured a passphrase in a
      // previous session, don't prompt again. They can reset via Settings.
      if (hasUnlockedKeychainFallback) return;
      if (!hasShownKeychainFallback) {
        markShown();
        setOpen(true);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // Listen registration failed (e.g. in non-Tauri env). Silently ignore.
      });

    return () => {
      unlisten?.();
    };
  }, []);

  return {
    open,
    closePrompt: () => setOpen(false),
  };
}

// ---------------------------------------------------------------------------
// KeychainFallbackPrompt — modal component
// ---------------------------------------------------------------------------

interface KeychainFallbackPromptProps {
  open: boolean;
  onClose(): void;
}

export function KeychainFallbackPrompt({
  open,
  onClose,
}: KeychainFallbackPromptProps) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset form when the dialog opens.
  useEffect(() => {
    if (open) {
      setPassphrase("");
      setConfirm("");
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (passphrase.length === 0) {
      setError(t("keychain.errors.empty"));
      return;
    }
    if (passphrase !== confirm) {
      setError(t("keychain.errors.mismatch"));
      return;
    }

    setSubmitting(true);
    try {
      await keychainFallbackUnlock(passphrase);
      // Persist the "unlocked" marker so future launches don't re-prompt.
      useKeychainFallbackStore.getState().markUnlocked();
      onClose();
    } catch (err: unknown) {
      const msg =
        err !== null &&
        typeof err === "object" &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : t("keychain.errors.generic");
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby="kfp-description">
        <DialogHeader>
          <DialogTitle>{t("keychain.promptTitle")}</DialogTitle>
          <DialogDescription id="kfp-description">
            {t("keychain.promptDescription")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="kfp-passphrase" className="text-sm font-medium">
                {t("keychain.passphrase")}
              </label>
              <input
                id="kfp-passphrase"
                type="password"
                autoComplete="new-password"
                required
                aria-describedby={error !== null ? "kfp-error" : undefined}
                className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={passphrase}
                onChange={(e) => setPassphrase(e.currentTarget.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="kfp-confirm" className="text-sm font-medium">
                {t("keychain.confirmPassphrase")}
              </label>
              <input
                id="kfp-confirm"
                type="password"
                autoComplete="new-password"
                required
                className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={confirm}
                onChange={(e) => setConfirm(e.currentTarget.value)}
                disabled={submitting}
              />
            </div>

            {error !== null && (
              <p
                id="kfp-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting
                ? t("keychain.unlocking")
                : t("keychain.setPassphrase")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
