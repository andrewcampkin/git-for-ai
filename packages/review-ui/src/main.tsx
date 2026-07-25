import { createRoot } from "react-dom/client";

import { App } from "./App";
import { captureActionToken } from "./lib/actions";
import "./styles.css";

// Before anything reads the hash: the desktop host passes its launch token in the URL
// fragment, and this takes it into memory and clears the address (see lib/actions.ts).
captureActionToken();

createRoot(document.getElementById("root")!).render(<App />);
