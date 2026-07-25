// Client half of the action endpoints (DESKTOP.md §5 step 4b). Actions are the only
// requests this app makes that can change a repository, so three things are true here and
// nowhere else in the SPA:
//
//   1. The launch token arrives in the URL FRAGMENT (`#token=…`), which the browser never
//      sends to any server. It is read once, kept in memory, and wiped from the address
//      bar immediately — so a reload, a screenshot, or a copied URL never carries it.
//   2. It is sent as a header, never a body field or query parameter: a cross-origin form
//      cannot set a custom header, so no page in the user's browser can drive these
//      endpoints even if it guesses the port.
//   3. Without a token, `runAction` refuses locally instead of sending a request that
//      would be rejected anyway. In the browser (`git for-ai review`) there is no token
//      and no actions panel — the server does not even serve these routes.

/** One action job as the server reports it (mirrors ReviewActionJob in the CLI). */
export interface ActionJob {
  id: string;
  action: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  progress: string[];
  result?: unknown;
  error?: string;
}

let token: string | null = null;

/**
 * Take the launch token out of the URL fragment, if the host put one there. Call once,
 * before the router reads the hash — this leaves the address as a normal `#/` route.
 */
export function captureActionToken(): void {
  const match = /^#token=([^&]+)$/.exec(window.location.hash);
  if (match === null) {
    return;
  }
  token = decodeURIComponent(match[1]!);
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#/`,
  );
}

/** True when this window was given a token (i.e. it is the desktop app's own renderer). */
export function hasActionToken(): boolean {
  return token !== null;
}

async function parse(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

/** Start an action. Resolves with the job that was accepted (status `running`). */
export async function runAction(
  name: string,
  body: Record<string, unknown> = {},
): Promise<ActionJob> {
  if (token === null) {
    throw new Error("this window cannot run actions");
  }
  const response = await fetch(`/api/actions/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-git-for-ai-token": token },
    body: JSON.stringify(body),
  });
  return (await parse(response)) as ActionJob;
}

/** Read a job's current state (progress lines included). */
export async function readJob(id: string): Promise<ActionJob> {
  if (token === null) {
    throw new Error("this window cannot run actions");
  }
  const response = await fetch(`/api/actions/jobs/${encodeURIComponent(id)}`, {
    headers: { "x-git-for-ai-token": token },
  });
  return (await parse(response)) as ActionJob;
}

/** How often a running job is re-read while its panel is open. */
export const JOB_POLL_MS = 700;
