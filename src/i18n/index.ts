/**
 * i18next bootstrap. Imported once from main.tsx.
 *
 * Adding a language is three lines:
 *   1. Create `src/i18n/locales/<code>.json`.
 *   2. Import + register it below.
 *   3. Add the option to the language selector in Settings.
 *
 * The runtime picks a locale by:
 *   1. Reading the persisted Settings.language (frontend store).
 *   2. Falling back to the browser's `navigator.language`.
 *   3. Falling back to "en" if no resource bundle matches.
 *
 * Translation keys use dot notation:  `menu.file.download`,
 * `settings.section.appearance.theme`. Keep keys human-readable so
 * grepping the codebase surfaces every use site.
 */

import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ptBR from "./locales/pt-BR.json";
import zhCN from "./locales/zh-CN.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "zh-CN", label: "中文 (简体)" },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "pt-BR": { translation: ptBR },
      es: { translation: es },
      fr: { translation: fr },
      de: { translation: de },
      "zh-CN": { translation: zhCN },
    },
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "brows3r:language",
      caches: ["localStorage"],
    },
  });

export default i18n;
