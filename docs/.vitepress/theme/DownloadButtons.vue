<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

// ---------------------------------------------------------------------------
// Dynamic download buttons for the brows3r docs homepage.
//
// Fetches the latest release from the GitHub API on mount and renders a
// platform-aware card grid. If the fetch fails (rate limit, offline) the
// component degrades gracefully to a single "View all releases" button.
//
// Platform detection is best-effort: we use `userAgentData.platform` when
// available and fall back to parsing `navigator.userAgent`. The detected
// platform card is given a "Recommended for your system" badge but every
// platform's downloads remain visible.
// ---------------------------------------------------------------------------

type Platform = "mac" | "windows" | "linux";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

interface DownloadLink {
  label: string;
  href: string;
  size: string;
  sublabel?: string;
}

interface PlatformGroup {
  id: Platform;
  title: string;
  icon: string;
  links: DownloadLink[];
}

const RELEASES_URL = "https://github.com/banduk/brows3r/releases";
const LATEST_URL = "https://github.com/banduk/brows3r/releases/latest";
const API_URL =
  "https://api.github.com/repos/banduk/brows3r/releases/latest";

const release = ref<Release | null>(null);
const loading = ref(true);
const errored = ref(false);
const detected = ref<Platform | null>(null);

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function detectPlatform(): Platform | null {
  if (typeof navigator === "undefined") return null;
  const uaData = (navigator as unknown as {
    userAgentData?: { platform?: string };
  }).userAgentData;
  const raw = (uaData?.platform || navigator.platform || navigator.userAgent || "")
    .toLowerCase();
  if (raw.includes("mac")) return "mac";
  if (raw.includes("win")) return "windows";
  if (raw.includes("linux")) return "linux";
  return null;
}

function classify(asset: ReleaseAsset): DownloadLink | null {
  const name = asset.name.toLowerCase();
  const size = formatSize(asset.size);
  const base: Omit<DownloadLink, "label" | "sublabel"> = {
    href: asset.browser_download_url,
    size,
  };
  if (name.endsWith(".dmg")) {
    if (name.includes("aarch64") || name.includes("arm64")) {
      return { ...base, label: "Apple silicon (.dmg)", sublabel: "Apple silicon" };
    }
    if (name.includes("x64") || name.includes("x86_64")) {
      return { ...base, label: "Intel (.dmg)", sublabel: "Intel" };
    }
    return { ...base, label: "Universal (.dmg)", sublabel: "Universal" };
  }
  if (name.endsWith(".msi")) {
    return { ...base, label: "Installer (.msi)", sublabel: "MSI" };
  }
  if (name.endsWith(".exe")) {
    return { ...base, label: "Installer (.exe)", sublabel: "Setup" };
  }
  if (name.endsWith(".appimage")) {
    return { ...base, label: "AppImage (.AppImage)", sublabel: "Portable" };
  }
  if (name.endsWith(".deb")) {
    return { ...base, label: "Debian (.deb)", sublabel: "Debian/Ubuntu" };
  }
  if (name.endsWith(".rpm")) {
    return { ...base, label: "RPM (.rpm)", sublabel: "Fedora/openSUSE" };
  }
  return null;
}

function platformOf(asset: ReleaseAsset): Platform | null {
  const n = asset.name.toLowerCase();
  if (n.endsWith(".dmg")) return "mac";
  if (n.endsWith(".msi") || n.endsWith(".exe")) return "windows";
  if (
    n.endsWith(".appimage") ||
    n.endsWith(".deb") ||
    n.endsWith(".rpm")
  )
    return "linux";
  return null;
}

const groups = computed<PlatformGroup[]>(() => {
  if (!release.value) return [];
  const buckets: Record<Platform, DownloadLink[]> = {
    mac: [],
    windows: [],
    linux: [],
  };
  for (const asset of release.value.assets) {
    const p = platformOf(asset);
    if (!p) continue;
    const link = classify(asset);
    if (link) buckets[p].push(link);
  }
  return [
    { id: "mac", title: "macOS", icon: "apple", links: buckets.mac },
    {
      id: "windows",
      title: "Windows",
      icon: "windows",
      links: buckets.windows,
    },
    { id: "linux", title: "Linux", icon: "linux", links: buckets.linux },
  ].filter((g) => g.links.length > 0) as PlatformGroup[];
});

const formattedDate = computed(() => {
  if (!release.value) return "";
  const d = new Date(release.value.published_at);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
});

onMounted(async () => {
  detected.value = detectPlatform();
  try {
    const r = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    release.value = (await r.json()) as Release;
  } catch {
    errored.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="downloads">
    <header class="downloads__header">
      <div>
        <h2 class="downloads__title">Download brows3r</h2>
        <p class="downloads__subtitle">
          Signed desktop builds for macOS, Windows, and Linux.
          <template v-if="release">
            Latest release
            <a :href="release.html_url" target="_blank" rel="noopener"
              ><strong>{{ release.tag_name }}</strong></a
            >
            · {{ formattedDate }}.
          </template>
        </p>
      </div>
      <a class="downloads__all" :href="RELEASES_URL" target="_blank" rel="noopener">
        All releases &rarr;
      </a>
    </header>

    <div v-if="loading" class="downloads__state">Loading latest release…</div>

    <div v-else-if="errored || groups.length === 0" class="downloads__state">
      <p>
        Couldn't fetch the latest release manifest from GitHub.
      </p>
      <a class="downloads__cta" :href="LATEST_URL" target="_blank" rel="noopener">
        Open latest release on GitHub &rarr;
      </a>
    </div>

    <div v-else class="downloads__grid">
      <article
        v-for="group in groups"
        :key="group.id"
        class="downloads__card"
        :class="{ 'downloads__card--recommended': detected === group.id }"
      >
        <header class="downloads__card-head">
          <span class="downloads__icon" :data-icon="group.icon" aria-hidden="true">
            <svg
              v-if="group.icon === 'apple'"
              viewBox="0 0 24 24"
              width="22"
              height="22"
            >
              <path
                fill="currentColor"
                d="M16.365 1.43c0 1.14-.49 2.27-1.29 3.09-.86.9-2.28 1.6-3.41 1.5-.14-1.1.46-2.27 1.22-3.08.86-.92 2.31-1.6 3.48-1.51zm3.7 17.06c-.65 1.41-.97 2.04-1.81 3.29-1.18 1.75-2.84 3.93-4.9 3.95-1.83.02-2.3-1.18-4.78-1.16-2.48.01-3 1.18-4.83 1.16-2.06-.02-3.63-1.99-4.81-3.74C-1.7 16.6-1.04 11.32 1.13 8.46 2.69 6.43 5 5.18 7.18 5.18c2.06 0 3.36 1.13 5.07 1.13 1.66 0 2.66-1.13 5.05-1.13 1.92 0 3.97 1.04 5.42 2.84-4.76 2.6-3.98 9.35-2.65 10.47z"
              />
            </svg>
            <svg
              v-else-if="group.icon === 'windows'"
              viewBox="0 0 24 24"
              width="22"
              height="22"
            >
              <path
                fill="currentColor"
                d="M3 5.1 10.5 4v7.5H3V5.1zM3 18.9 10.5 20v-7.5H3v6.4zM11.5 4 21 2.6v8.9h-9.5V4zm0 16 9.5 1.4v-8.9h-9.5V20z"
              />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="22" height="22">
              <path
                fill="currentColor"
                d="M12 2c-2.2 0-3.5 1.7-3.5 4.1 0 1.3.5 2.3.5 3.4 0 1.1-1.2 2-2.3 3.3-1 1.2-1.7 2.7-1.7 4 0 2 1 2.6 1 3.7 0 .5-.4 1-.4 1.4 0 .8.6 1.1 1.3 1.1 1.5 0 3-1.4 4.5-1.4 1.6 0 3.2 1.4 4.7 1.4.7 0 1.2-.3 1.2-1 0-.5-.3-1-.3-1.5 0-1.1 1.1-1.7 1.1-3.7 0-1.4-.8-2.9-1.8-4.1-1.1-1.3-2.3-2.1-2.3-3.2 0-1.1.5-2.1.5-3.4 0-2.4-1.3-4.1-3.5-4.1zM10.5 5c.3 0 .6.4.6.9s-.3 1-.6 1-.6-.5-.6-1 .3-.9.6-.9zm3 0c.3 0 .6.4.6.9s-.3 1-.6 1-.6-.5-.6-1 .3-.9.6-.9zM12 8.4c.6 0 1.2.5 1.6.9-.2.2-.5.5-1 .7-.3.1-.6.3-.6.6 0 .4.4.4.7.4s.6-.1 1-.2c-.2.5-.9.9-1.7.9s-1.5-.4-1.7-.9c.4.1.7.2 1 .2s.7 0 .7-.4c0-.3-.3-.5-.6-.6-.5-.2-.8-.5-1-.7.4-.4 1-.9 1.6-.9z"
              />
            </svg>
          </span>
          <h3 class="downloads__platform">{{ group.title }}</h3>
          <span
            v-if="detected === group.id"
            class="downloads__badge"
            aria-label="Recommended for your system"
            >Detected</span
          >
        </header>
        <ul class="downloads__list">
          <li
            v-for="link in group.links"
            :key="link.href"
            class="downloads__item"
          >
            <a
              :href="link.href"
              class="downloads__link"
              :class="{ 'downloads__link--primary': detected === group.id }"
            >
              <span class="downloads__link-label">{{ link.label }}</span>
              <span class="downloads__link-size">{{ link.size }}</span>
            </a>
          </li>
        </ul>
      </article>
    </div>

    <p class="downloads__foot">
      Looking for older builds, checksums, or release notes?
      <a :href="RELEASES_URL" target="_blank" rel="noopener"
        >Browse the full releases page</a
      >.
    </p>
  </section>
</template>

<style scoped>
.downloads {
  margin: 3rem 0 1rem;
  padding: 1.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--vp-c-brand-1) 6%, transparent),
    transparent 80%
  );
}

.downloads__header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.downloads__title {
  margin: 0;
  font-size: 1.6rem;
  letter-spacing: -0.01em;
  border: none;
  padding: 0;
}

.downloads__subtitle {
  margin: 0.35rem 0 0;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
}

.downloads__subtitle strong {
  color: var(--vp-c-brand-1);
}

.downloads__all {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  white-space: nowrap;
}

.downloads__all:hover {
  text-decoration: underline;
}

.downloads__state {
  padding: 1rem 0;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
}

.downloads__cta {
  display: inline-block;
  margin-top: 0.5rem;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.downloads__grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.downloads__card {
  display: flex;
  flex-direction: column;
  padding: 1rem 1.1rem 1.1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.downloads__card:hover {
  border-color: var(--vp-c-brand-2);
}

.downloads__card--recommended {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 1px var(--vp-c-brand-1) inset;
}

.downloads__card-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.85rem;
}

.downloads__icon {
  display: inline-flex;
  color: var(--vp-c-text-1);
}

.downloads__platform {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  border: none;
  padding: 0;
}

.downloads__badge {
  margin-left: auto;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--vp-c-bg);
  background: var(--vp-c-brand-1);
}

.downloads__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.downloads__item {
  margin: 0;
}

.downloads__link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  text-decoration: none;
  color: var(--vp-c-text-1);
  font-weight: 500;
  font-size: 0.92rem;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.downloads__link:hover {
  border-color: var(--vp-c-brand-2);
  background: color-mix(in srgb, var(--vp-c-brand-1) 8%, transparent);
}

.downloads__link--primary {
  background: var(--vp-c-brand-1);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand-1);
}

.downloads__link--primary:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
  color: var(--vp-c-bg);
}

.downloads__link-size {
  font-size: 0.8rem;
  opacity: 0.8;
}

.downloads__foot {
  margin: 1.25rem 0 0;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}
</style>
