// Ask panel (REVIEW_UI.md §4.5): visibly present but DISABLED, with an honest note.
// Pretending to answer would violate the product's core honesty rule; showing nothing
// would hide where the surface is going. So: present, inert, labeled.

export function AskPanel() {
  return (
    <section className="ask" aria-disabled="true">
      <h2 id="ask">Ask</h2>
      <div className="ask-controls">
        <input
          type="text"
          disabled
          placeholder="Ask about this repository's changes — e.g. why was the session store replaced?"
        />
        <button type="button" disabled>
          Ask
        </button>
      </div>
      <p className="ask-note">
        Arrives with M12. The local index (<code>git for-ai reindex</code>) exists, but the
        ask/query surface is not wired to this UI yet — this panel is disabled rather than
        pretending to answer.
      </p>
    </section>
  );
}
