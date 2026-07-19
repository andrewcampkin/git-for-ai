// Preload for the single app window (compiled to CommonJS — dist/preload.cjs — because it
// runs in a sandboxed renderer, which only supports CJS preloads).
//
// The bridge is gated to file:// — i.e. ONLY the local picker page (dist/picker.html).
// When the window navigates to the served SPA (http://127.0.0.1:<port>/), this preload
// still runs but exposes NOTHING: the SPA is the same code `git for-ai review` serves to
// a plain browser and must keep working with zero desktop privileges (DESKTOP.md §4 —
// main-process privileges never leak into the renderer).
//
// The whole surface is the three picker verbs, nothing more: pickFolder / openRepo / init.

import { contextBridge, ipcRenderer } from "electron";

if (window.location.protocol === "file:") {
  contextBridge.exposeInMainWorld("gitForAiDesktop", {
    /** Native folder dialog; resolves to the chosen path or null when cancelled. */
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke("picker:pick-folder"),
    /** Validate + open a repo (main re-points the window on success). */
    openRepo: (dir: string): Promise<unknown> => ipcRenderer.invoke("picker:open-repo", dir),
    /** The one write action: `git for-ai init` for the given repo. */
    init: (dir: string): Promise<unknown> => ipcRenderer.invoke("picker:init", dir),
  });
}
