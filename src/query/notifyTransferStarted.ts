/**
 * Single discreet "Transfer started" toast fired once per user click.
 *
 * Replaces the previous per-file "Download complete" toast — that was
 * spammy for folder downloads (one per arquivo, even coalesced felt
 * noisy) and redundant now that:
 *   - the StatusBar Activity chip turns green and shows the count
 *     while transfers are running, and
 *   - the full-pane Activity Center surfaces the entire history with
 *     filters, search and per-batch "Open folder" actions.
 *
 * The Started toast is a one-time confirmation that the click was
 * accepted; the user finds detail / progress / completion in the
 * Activity Center via the chip or Cmd+Shift+A.
 */

import i18n from "@/i18n";
import { notify } from "@/lib/errors";
import { useUiStore } from "@/store/ui";

export type TransferKind = "download" | "upload";

export function notifyTransferStarted(count: number, kind: TransferKind): void {
  if (count <= 0) return;
  const t = i18n.t.bind(i18n);

  const titleKey =
    kind === "upload"
      ? "transfersStarted.titleUpload"
      : "transfersStarted.titleDownload";
  const messageKey =
    count === 1
      ? "transfersStarted.messageOne"
      : "transfersStarted.messageMany";

  notify({
    id: `transfer-started-${kind}-${Date.now().toString()}`,
    title: t(titleKey),
    message: t(messageKey, { count }),
    severity: "info",
    action: {
      label: t("transfersStarted.view"),
      onClick: () => {
        useUiStore.getState().setActivityCenterOpen(true);
      },
    },
  });
}
