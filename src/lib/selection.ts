/**
 * SelectionModel and useSelection hook.
 *
 * SelectionModel<T> is UI-agnostic and holds selected IDs in a Set<string>.
 * useSelection<T> wraps it with React state and mouse/keyboard modifier logic.
 *
 * OCP: SelectionModel is decoupled from the view — Tree, Gallery, and Flat
 * views all supply their own `getId` strategy and reuse the same model.
 */

import { useState } from "react";

// ---------------------------------------------------------------------------
// SelectionModel
// ---------------------------------------------------------------------------

/**
 * Stateful selection model backed by a `Set<string>` of item IDs.
 *
 * All mutating methods return a *new* `SelectionModel` instance (immutable
 * update pattern) so React state triggers re-renders correctly.
 */
export class SelectionModel<_T = unknown> {
  readonly ids: ReadonlySet<string>;

  constructor(ids?: Iterable<string>) {
    this.ids = new Set(ids);
  }

  // -- queries ----------------------------------------------------------------

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }

  toArray(): string[] {
    return Array.from(this.ids);
  }

  // -- mutations (return new instance) ----------------------------------------

  add(id: string): SelectionModel<_T> {
    if (this.ids.has(id)) return this;
    const next = new Set(this.ids);
    next.add(id);
    return new SelectionModel<_T>(next);
  }

  remove(id: string): SelectionModel<_T> {
    if (!this.ids.has(id)) return this;
    const next = new Set(this.ids);
    next.delete(id);
    return new SelectionModel<_T>(next);
  }

  toggle(id: string): SelectionModel<_T> {
    return this.ids.has(id) ? this.remove(id) : this.add(id);
  }

  /**
   * Select all items between anchor and target indices (inclusive) in `items`.
   * Clears any prior selection and replaces it with the range.
   */
  range<T>(
    anchor: number,
    target: number,
    items: T[],
    getId: (item: T) => string,
  ): SelectionModel<_T> {
    const lo = Math.min(anchor, target);
    const hi = Math.max(anchor, target);
    const ids = items.slice(lo, hi + 1).map(getId);
    return new SelectionModel<_T>(ids);
  }

  clear(): SelectionModel<_T> {
    if (this.ids.size === 0) return this;
    return new SelectionModel<_T>();
  }
}

// ---------------------------------------------------------------------------
// useSelection hook
// ---------------------------------------------------------------------------

export interface UseSelectionResult<T> {
  selection: SelectionModel<T>;
  isSelected: (id: string) => boolean;
  /** Call from a row's onClick handler with the item and the event. */
  onClick: (item: T, index: number, e: React.MouseEvent) => void;
  /** Bind to the list container's onKeyDown for Cmd/Ctrl+A. */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Cursor index (highlighted row; moves with keyboard nav). */
  cursor: number;
  setCursor: (index: number) => void;
}

/**
 * React hook that manages selection state with modifier-aware click handling
 * and Cmd/Ctrl+A keyboard shortcut.
 *
 * @param items    - The ordered list of items currently displayed.
 * @param getId    - Extract a stable unique ID from an item.
 */
export function useSelection<T>(
  items: T[],
  getId: (item: T) => string,
): UseSelectionResult<T> {
  const [selection, setSelection] = useState<SelectionModel<T>>(
    () => new SelectionModel<T>(),
  );
  // anchor: index used for shift-click range start
  const [anchor, setAnchor] = useState<number>(0);
  // cursor: highlighted row index for keyboard nav
  const [cursor, setCursor] = useState<number>(0);

  function isSelected(id: string): boolean {
    return selection.has(id);
  }

  function onClick(item: T, index: number, e: React.MouseEvent): void {
    const id = getId(item);
    const meta = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    if (shift) {
      // Range select from anchor to clicked row (replaces current selection).
      setSelection((s) => s.range(anchor, index, items, getId));
      setCursor(index);
    } else if (meta) {
      // Toggle the individual item without moving the anchor.
      setSelection((s) => s.toggle(id));
      setCursor(index);
    } else {
      // Plain click: select only this item and set anchor.
      setSelection(new SelectionModel<T>([id]));
      setAnchor(index);
      setCursor(index);
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key === "a") {
      e.preventDefault();
      setSelection(new SelectionModel<T>(items.map(getId)));
    }
  }

  return { selection, isSelected, onClick, onKeyDown, cursor, setCursor };
}
