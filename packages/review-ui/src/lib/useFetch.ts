// Tiny fetch-into-state hook. All requests are same-origin GETs against the read-only
// local API (REVIEW_UI.md §2) — there is nothing else this app is allowed to talk to.
// Errors surface verbatim (the server's {error} body when present) — never swallowed.

import { useEffect, useState } from "react";

export type Fetched<T> =
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ok"; data: T };

/**
 * `reloadKey` re-runs the request when it changes — the one case being a write that just
 * landed (the annotate form), where the page must re-read rather than show what it fetched
 * before the change existed. Bumping a counter is deliberate over a cache-busting query
 * parameter: the URL stays the honest address of the resource.
 */
export function useFetch<T>(url: string, reloadKey = 0): Fetched<T> {
  const [result, setResult] = useState<Fetched<T>>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    setResult({ state: "loading" });
    fetch(url)
      .then(async (response) => {
        const body: unknown = await response.json();
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
        return body as T;
      })
      .then((data) => {
        if (!cancelled) {
          setResult({ state: "ok", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({
            state: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, reloadKey]);

  return result;
}
