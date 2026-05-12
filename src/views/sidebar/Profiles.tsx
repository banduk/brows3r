/**
 * Profiles sidebar panel.
 *
 * Renders the list of profiles from the backend, a source badge per row,
 * a validation-status indicator, and a "..." context menu with Edit, Delete,
 * and Validate actions.  An "Add profile" button at the bottom opens the
 * ProfileEditor in create mode.
 *
 * OCP:
 * - Source badge labels/colors live in `SOURCE_BADGE` — one map entry per source.
 * - Validation indicator logic is isolated in `ValidationDot`.
 * - Each row action calls the API directly and invalidates `keys.profiles()`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ProfileSource,
  type ProfileSummary,
  profileDelete,
  profilesList,
  profileValidate,
} from "@/api/profiles";
import { PopoverMenu } from "@/components/PopoverMenu";
import { Button } from "@/components/ui/button";
import { surfaceError, surfaceUnknownError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { keys } from "@/query/keys";
import { usePanesStore } from "@/store/panes";
import { ProfileEditor } from "@/views/settings/ProfileEditor";

// ---------------------------------------------------------------------------
// Source badge
// ---------------------------------------------------------------------------

/** Maps ProfileSource → human label + colour class. OCP: one entry per source. */
const SOURCE_BADGE: Record<
  ProfileSource,
  { label: string; className: string }
> = {
  awsCredentials: {
    label: "AWS",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  awsConfig: {
    label: "AWS",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  manual: {
    label: "Manual",
    className:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  },
  env: {
    label: "Env",
    className:
      "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  },
};

// ---------------------------------------------------------------------------
// ValidationDot
// ---------------------------------------------------------------------------

/** Threshold below which a validation is considered "stale" (10 min). */
const STALE_THRESHOLD_MS = 10 * 60 * 1_000;

type ValidationStatus = "valid" | "stale" | "unvalidated";

function getValidationStatus(validatedAt?: number): ValidationStatus {
  if (validatedAt === undefined) return "unvalidated";
  const age = Date.now() - validatedAt;
  return age <= STALE_THRESHOLD_MS ? "valid" : "stale";
}

interface ValidationDotProps {
  validatedAt?: number;
}

function ValidationDot({ validatedAt }: ValidationDotProps) {
  const status = getValidationStatus(validatedAt);
  const { t } = useTranslation();
  const dotClass =
    status === "valid"
      ? "bg-green-500"
      : status === "stale"
        ? "bg-gray-400"
        : "bg-red-400";
  const label =
    status === "valid"
      ? t("profiles.validatedRecently")
      : status === "stale"
        ? t("profiles.validationStale")
        : t("profiles.notValidated");

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block size-2 shrink-0 rounded-full ${dotClass}`}
    />
  );
}

// ---------------------------------------------------------------------------
// ProfileRowMenu — uses PopoverMenu so the dropdown escapes scrollable
// sidebar ancestors via position: fixed.
// ---------------------------------------------------------------------------

interface ProfileRowMenuProps {
  profile: ProfileSummary;
  onEdit(profile: ProfileSummary): void;
  onDelete(profile: ProfileSummary): void;
  onValidate(profile: ProfileSummary): void;
}

function ProfileRowMenu({
  profile,
  onEdit,
  onDelete,
  onValidate,
}: ProfileRowMenuProps) {
  const { t } = useTranslation();
  return (
    <PopoverMenu
      triggerLabel={t("profiles.rowActionsAria", { name: profile.displayName })}
      triggerIcon={<MoreHorizontalIcon />}
      items={[
        { label: t("profiles.edit"), onClick: () => onEdit(profile) },
        { label: t("profiles.validate"), onClick: () => onValidate(profile) },
        {
          label: t("profiles.delete"),
          onClick: () => onDelete(profile),
          variant: "danger",
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Profiles (main export)
// ---------------------------------------------------------------------------

export function Profiles() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const activePaneId = usePanesStore((s) => s.activePaneId);
  const setLocation = usePanesStore((s) => s.setLocation);
  const activeProfileId = usePanesStore(
    (s) =>
      s.panes.find((p) => p.id === s.activePaneId)?.location?.profileId ?? null,
  );

  const [editorMode, setEditorMode] = useState<
    | { kind: "closed" }
    | { kind: "create" }
    | { kind: "edit"; profileId: string }
  >({ kind: "closed" });

  const {
    data: profiles = [],
    isLoading,
    error: profilesError,
  } = useQuery({
    queryKey: keys.profiles(),
    queryFn: profilesList,
  });

  // Surface a persistent fetch failure to the notifications panel.
  // Without this the sidebar shows "Loading profiles…" forever when
  // `profiles_list` keeps failing (corrupt store file, disk error)
  // and the user has no idea why no profiles appear.
  useEffect(() => {
    if (!profilesError) return;
    void surfaceUnknownError(profilesError, {
      operation: "profiles_list",
      context: "background",
      title: "Failed to load profiles",
    });
  }, [profilesError]);

  const deleteMutation = useMutation({
    mutationFn: (profileId: string) => profileDelete(profileId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.profiles() });
    },
    onError: (err, profileId) =>
      surfaceUnknownError(err, {
        operation: "profile_delete",
        resource: profileId,
        title: "Failed to delete profile",
      }),
  });

  const validateMutation = useMutation({
    mutationFn: (profileId: string) => profileValidate(profileId),
    onSuccess: async (report) => {
      void queryClient.invalidateQueries({ queryKey: keys.profiles() });

      // The backend's `profile_validate` command always returns Ok(report)
      // even when the AWS probe fails — the failure lives in `report.error`.
      // Without surfacing it here the user sees the validation dot stay
      // grey/red with no clue about *why* (SSO token expired, region wrong,
      // credentials missing, etc.).
      if (!report.ok && report.error) {
        await surfaceError(report.error, {
          operation: "profile_validate",
          resource: report.profileId,
          title: "Profile validation failed",
        });
      }
    },
    onError: (err, profileId) =>
      surfaceUnknownError(err, {
        operation: "profile_validate",
        resource: profileId,
        title: "Profile validation failed",
      }),
  });

  function handleEdit(profile: ProfileSummary) {
    setEditorMode({ kind: "edit", profileId: profile.id });
  }

  function handleDelete(profile: ProfileSummary) {
    if (
      window.confirm(t("profiles.deleteConfirm", { name: profile.displayName }))
    ) {
      deleteMutation.mutate(profile.id);
    }
  }

  function handleValidate(profile: ProfileSummary) {
    validateMutation.mutate(profile.id);
  }

  function handleNavigate(profile: ProfileSummary) {
    // Navigate into the profile: bucket = null signals BucketListView in
    // the main pane, where the user picks a bucket to drill into.
    setLocation(activePaneId, {
      profileId: profile.id,
      bucket: null,
      prefix: "",
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* "Add profile" pinned at the top so it is always visible regardless
          of how many profiles are in the list. Sidebar can be narrow without
          the button getting pushed out of view. */}
      <div className="shrink-0 border-b border-border/40 p-2">
        <Button
          variant="ghost"
          className="w-full justify-start gap-1.5 text-sm"
          onClick={() => setEditorMode({ kind: "create" })}
        >
          <PlusIcon className="size-4 shrink-0" />
          <span className="truncate">{t("sidebar.addProfile")}</span>
        </Button>
      </div>

      {/* Scrollable list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && !profilesError && (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            {t("profiles.loading")}
          </p>
        )}

        {profilesError && (
          <p
            className="px-3 py-4 text-sm text-destructive"
            role="alert"
            data-testid="profiles-load-error"
          >
            {t("profiles.loadError")}{" "}
            {profilesError instanceof Error
              ? profilesError.message
              : t("profiles.checkNotifications")}
          </p>
        )}

        {!isLoading && !profilesError && profiles.length === 0 && (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            {t("profiles.empty")}
          </p>
        )}

        <ul aria-label={t("profiles.listAria")}>
          {profiles.map((profile) => {
            const badge = SOURCE_BADGE[profile.source];
            const isActive = profile.id === activeProfileId;
            return (
              <li
                key={profile.id}
                className={cn(
                  "flex items-center gap-0 hover:bg-accent/50",
                  isActive && "bg-accent/40",
                )}
              >
                <button
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => handleNavigate(profile)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left"
                >
                  <ValidationDot validatedAt={profile.validatedAt} />

                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {profile.displayName}
                  </span>

                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </button>

                <div className="pr-1">
                  <ProfileRowMenu
                    profile={profile}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onValidate={handleValidate}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {editorMode.kind !== "closed" && (
        <ProfileEditor
          mode={editorMode.kind === "create" ? "create" : "edit"}
          profileId={
            editorMode.kind === "edit" ? editorMode.profileId : undefined
          }
          onClose={() => setEditorMode({ kind: "closed" })}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: keys.profiles() });
            setEditorMode({ kind: "closed" });
          }}
        />
      )}
    </div>
  );
}
