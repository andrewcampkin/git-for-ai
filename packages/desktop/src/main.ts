// Electron main process — the desktop shell from architecture/DESKTOP.md §4. The shape is
// exactly the one the architecture anticipated: this plain-Node process starts the SAME local server `git for-ai review`
// uses (`startReviewServer` — 127.0.0.1, random port, read-only GETs) and the renderer
// loads the served SPA. One SPA codebase; no logic duplicated here.
//
// Security posture (Electron best practice, enforced not assumed):
//   - contextIsolation ON, nodeIntegration OFF, sandbox ON for every page this window
//     loads. The served SPA gets NO preload surface at all: preload.cts gates its
//     contextBridge exposure to file:// (the local picker page), so main-process
//     privileges never leak into the SPA.
//   - window.open is denied; navigation is confined to the picker file and the running
//     server's own origin.
//   - The one write action in v1 is `init` (picker button) — the same pure `runInit` the
//     CLI uses. Everything else remains the read-only server.
//
// Judgment calls:
//   1. Single window, single server (v1). DESKTOP.md leaves window-per-repo as an open
//      question (§6.2) — switching repos re-points this window and restarts the
//      server for the new repo. Server instances are cheap, but only one runs at a time
//      here.
//   2. No orphaned processes: the server runs in-process, and before-quit
//      closes it explicitly (closeAllConnections first, so keep-alive sockets from the SPA
//      can't stall `server.close()`), so a clean quit is also an observable one ("review
//      server closed" in the log).
//   3. `--smoke` flag: launch → open repo (GIT_FOR_AI_DESKTOP_REPO or cwd) → fetch
//      /api/meta from the running server → log the result → quit. This is the honest
//      self-verification seam for an app with no test harness around its shell — the log
//      lines are the evidence a launch actually worked, and it doubles as a CI-able check
//      later. It ships because instrumented verification beats a claimed one.
//   4. State lives in userData/desktop-state.json via the pure appState module; a corrupt
//      file resets to defaults rather than bricking launch (see appState.ts).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";

import { formatInitResult, runInit } from "git-for-ai/dist/commands/init.js";
import {
  startReviewServer,
  type ReviewServerHandle,
} from "git-for-ai/dist/commands/review.js";

import {
  loadAppState,
  saveAppState,
  touchRecent,
  withWindowBounds,
  type AppState,
} from "./appState.js";
import { validateRepo } from "./repoValidation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `electron . --smoke`: self-verifying launch (judgment call #3 in the header). */
const SMOKE = process.argv.includes("--smoke");

function log(message: string): void {
  console.log(`[desktop] ${message}`);
}

// ─── IPC result shapes (mirrored by the picker page's inline script) ─────────

type OpenRepoResult =
  | { status: "opened"; repoRoot: string; url: string }
  | { status: "uninitialized"; repoRoot: string }
  | { status: "invalid"; message: string };

type InitRepoResult =
  | { ok: true; repoRoot: string; summary: string }
  | { ok: false; error: string };

// ─── Mutable app state ───────────────────────────────────────────────────────

let win: BrowserWindow | null = null;
let server: ReviewServerHandle | null = null;
let state: AppState;
let stateFile = "";

// ─── Window + navigation ─────────────────────────────────────────────────────

function isAllowedNavigation(url: string): boolean {
  // file:// is only ever our own dist/picker.html (loadFile below); http is only the
  // running review server's own origin. Everything else is refused.
  if (url.startsWith("file:")) return true;
  return server !== null && url.startsWith(server.url);
}

function createWindow(): void {
  const bounds = state.windowBounds;
  win = new BrowserWindow({
    width: bounds?.width ?? 1200,
    height: bounds?.height ?? 800,
    ...(bounds !== null ? { x: bounds.x, y: bounds.y } : {}),
    title: "git-for-ai",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  log("window created");

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
    }
  });
  // The title is ours ("git-for-ai — <repo>"), not the page's.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.on("close", () => {
    if (win !== null) {
      state = withWindowBounds(state, win.getNormalBounds());
      saveAppState(stateFile, state);
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

async function showPicker(previous?: OpenRepoResult): Promise<void> {
  if (win === null) return;
  const query: Record<string, string> = { recents: JSON.stringify(state.recentRepos) };
  if (previous?.status === "invalid") {
    query["error"] = previous.message;
  }
  if (previous?.status === "uninitialized") {
    query["uninitialized"] = previous.repoRoot;
  }
  await win.loadFile(join(__dirname, "picker.html"), { query });
  win.setTitle("git-for-ai — choose a repository");
  log("picker shown");
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

async function stopServer(): Promise<void> {
  if (server === null) return;
  const handle = server;
  server = null;
  // Keep-alive sockets from the SPA would otherwise stall close() indefinitely.
  handle.server.closeAllConnections();
  try {
    await handle.close();
    log("review server closed");
  } catch (error) {
    log(`review server close failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function openRepo(dir: string): Promise<OpenRepoResult> {
  const validation = await validateRepo(dir);
  if (validation.status === "invalid") {
    log(`open rejected: ${validation.message}`);
    return { status: "invalid", message: validation.message };
  }
  if (validation.status === "uninitialized") {
    log(`repo not initialized: ${validation.repoRoot}`);
    return { status: "uninitialized", repoRoot: validation.repoRoot };
  }

  await stopServer();
  let handle: ReviewServerHandle;
  // A fresh token per server launch (DESKTOP.md §5 step 4b). It is what makes the write
  // endpoints reachable from THIS window and from nothing else on the machine: no
  // endpoint ever serves it, and it dies with the server it was minted for.
  const actionToken = randomUUID();
  try {
    // `mode: "desktop"` only sets the capability flags /api/meta advertises (DESKTOP.md
    // §4): same server — the SPA uses it to decide which panes belong in this host.
    handle = await startReviewServer({
      cwd: validation.repoRoot,
      mode: "desktop",
      actionToken,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`review server failed to start: ${message}`);
    return { status: "invalid", message };
  }
  server = handle;
  log(`review server started at ${handle.url} for ${validation.repoRoot}`);

  state = touchRecent(state, validation.repoRoot);
  saveAppState(stateFile, state);

  if (win !== null) {
    // The token travels in the URL FRAGMENT, which browsers never send to a server and
    // which no other local process can read out of this window. The SPA takes it into
    // memory and clears it from the address on first read.
    await win.loadURL(`${handle.url}#token=${actionToken}`);
    win.setTitle(`git-for-ai — ${basename(validation.repoRoot)}`);
    log(`SPA loaded (title: git-for-ai — ${basename(validation.repoRoot)})`);
  }
  return { status: "opened", repoRoot: validation.repoRoot, url: handle.url };
}

// ─── Menu ────────────────────────────────────────────────────────────────────

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Repository…",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            void showPicker();
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ─── IPC (the picker's whole surface: pickFolder / openRepo / init) ──────────

function registerIpc(): void {
  ipcMain.handle("picker:pick-folder", async (): Promise<string | null> => {
    if (win === null) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "Choose a git repository",
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("picker:open-repo", async (_event, dir: unknown): Promise<OpenRepoResult> => {
    if (typeof dir !== "string" || dir.trim() === "") {
      return { status: "invalid", message: "expected a folder path" };
    }
    return openRepo(dir);
  });

  ipcMain.handle("picker:init", async (_event, dir: unknown): Promise<InitRepoResult> => {
    if (typeof dir !== "string" || dir.trim() === "") {
      return { ok: false, error: "expected a folder path" };
    }
    try {
      // The ONE write action in the v1 shell — the identical pure function the CLI runs.
      const result = await runInit({ cwd: dir });
      log(`initialized ${result.repoRoot}`);
      return { ok: true, repoRoot: result.repoRoot, summary: formatInitResult(result) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

// ─── Smoke mode (judgment call #3) ───────────────────────────────────────────

async function runSmoke(): Promise<void> {
  try {
    if (server === null) {
      log("SMOKE FAIL: no review server running after startup");
      app.exit(1);
      return;
    }
    const response = await fetch(new URL("/api/meta", server.url));
    if (!response.ok) {
      log(`SMOKE FAIL: /api/meta -> HTTP ${response.status}`);
      app.exit(1);
      return;
    }
    const meta = (await response.json()) as {
      repoName?: string;
      repoRoot?: string;
      initialized?: boolean;
      head?: { shortSha?: string } | null;
    };
    log(
      `SMOKE /api/meta: repoName=${meta.repoName ?? "?"} repoRoot=${meta.repoRoot ?? "?"} ` +
        `initialized=${String(meta.initialized)} head=${meta.head?.shortSha ?? "none"}`,
    );
    log("SMOKE OK — quitting");
    app.quit();
  } catch (error) {
    log(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

async function openInitialTarget(): Promise<void> {
  const smokeRepo = process.env["GIT_FOR_AI_DESKTOP_REPO"];
  const target = SMOKE
    ? smokeRepo !== undefined && smokeRepo !== ""
      ? smokeRepo
      : process.cwd()
    : state.lastRepo !== null && existsSync(state.lastRepo)
      ? state.lastRepo
      : null;

  if (target === null) {
    await showPicker();
    return;
  }
  const result = await openRepo(target);
  if (result.status !== "opened") {
    await showPicker(result);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win !== null) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on("window-all-closed", () => {
    // v1 keeps this uniform across platforms: no window, no app (and no orphaned server).
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (server !== null) {
      // Close the server first, then quit for real — the no-orphans rule, observable.
      event.preventDefault();
      void stopServer().finally(() => app.quit());
    }
  });

  void app.whenReady().then(async () => {
    stateFile = join(app.getPath("userData"), "desktop-state.json");
    state = loadAppState(stateFile);
    Menu.setApplicationMenu(buildMenu());
    registerIpc();
    createWindow();
    await openInitialTarget();
    if (SMOKE) {
      await runSmoke();
    }
  });
}
