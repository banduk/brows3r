/**
 * EditorPreviewInner — lazy module boundary for Monaco chunk splitting.
 *
 * This file is imported via React.lazy in EditorPreview.tsx so that the
 * monaco-editor chunk is only loaded when the user enters edit mode.
 * Vite's manualChunks config ensures it lands in a separate "monaco" chunk.
 */

export { EditorPreviewCoreImpl as EditorPreviewInner } from "./EditorPreview";
