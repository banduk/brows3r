import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import DownloadButtons from "./DownloadButtons.vue";
import Layout from "./Layout.vue";

// Custom VitePress theme: a Layout wrapper that injects the dynamic
// `<DownloadButtons />` component into the `home-hero-after` slot so the
// downloads grid renders immediately below the hero (and above the features
// grid) on the homepage. The component is also globally registered so it can
// be embedded in any markdown page.
export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("DownloadButtons", DownloadButtons);
  },
} satisfies Theme;
