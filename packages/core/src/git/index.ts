// Placeholder. The execa-wrapped git access layer — architecture/ARCHITECTURE.md §4.1.
// Every git operation (reads and writes alike) shells out to the user's real `git` binary.
// Planned exports: runGit(args), readHead(), readCommitMessage(sha), listRefs(pattern),
// notesShow(ref, sha), notesAdd(ref, sha, body), notesMerge(...), catFile(blobSha), etc.
export {};
