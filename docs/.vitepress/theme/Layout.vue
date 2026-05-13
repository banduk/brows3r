<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import DownloadButtons from "./DownloadButtons.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #home-hero-after>
      <div id="download" class="downloads-slot">
        <div class="downloads-slot__inner">
          <div class="container">
            <DownloadButtons />
          </div>
        </div>
      </div>
    </template>
  </Layout>
</template>

<style scoped>
.downloads-slot {
  position: relative;
}

.downloads-slot__inner {
  padding: 0 24px;
  margin: 0 auto;
}

.downloads-slot .container {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px;
}

@media (min-width: 768px) {
  .downloads-slot__inner {
    padding: 0 48px;
  }
}

@media (min-width: 960px) {
  .downloads-slot__inner {
    padding: 0 64px;
  }
}
</style>
