/**
 * TextPreviewInner — lazy module boundary for the Monaco chunk used by the
 * read-only text viewer. Mirrors EditorPreviewInner so both paths share the
 * same code-split.
 */

export { TextPreviewCoreImpl as TextPreviewInner } from "./TextPreview";
