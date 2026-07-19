// Copy the non-TypeScript assets tsc doesn't emit (the picker page) into dist/.
// Kept as a plain script so `build` stays `tsc -b` + one copy — no bundler.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const dist = join(here, "..", "dist");

mkdirSync(dist, { recursive: true });
cpSync(join(src, "picker.html"), join(dist, "picker.html"));
