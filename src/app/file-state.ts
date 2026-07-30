import type { FileRef } from "./file-adapter";
import type { SaveState } from "./save-coordinator";

// Live document bookkeeping (Phase 7). `markdown` is the last serialized
// snapshot; the ProseMirror view owns the authoritative live state.
export interface FileState {
  name: string;
  handle: FileRef;
  markdown: string;
  dirty: boolean;
  lastSavedAt: number | null;
  // The latest write attempt. Failed writes remain dirty and recoverable.
  saveState: SaveState;
}

export function newFileState(): FileState {
  return {
    name: "untitled.md",
    handle: null,
    markdown: "",
    dirty: false,
    lastSavedAt: null,
    saveState: "saved",
  };
}
