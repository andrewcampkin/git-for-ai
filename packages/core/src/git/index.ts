// The execa-wrapped git access layer — architecture/ARCHITECTURE.md §4.1.
// Every git operation (reads and writes alike) shells out to the user's real `git` binary
// via execa. There is no in-process git library anywhere in this module, by design.

export { runGit, GitError } from "./run.js";
export type { RunGitOptions, GitResult } from "./run.js";

export { readHead, readCommitMessage, catFile, listRefs, revParse, lsTree } from "./read.js";
export type { RefInfo, TreeEntry } from "./read.js";

export { notesShow, notesAppend, notesMerge } from "./notes.js";
export type { NotesMergeStrategy, NotesMergeOptions } from "./notes.js";

export { hashObject, mktree, commitTree, updateRef } from "./plumbing.js";
export type {
  GitObjectType,
  HashObjectOptions,
  MktreeEntry,
  CommitTreeOptions,
  UpdateRefOptions,
} from "./plumbing.js";

// Test-only helper, exported here (not from the package root) so Milestone 3 (identity) and
// Milestone 4 (ledger) can import it as `import { createFixtureRepo } from "../git/index.js"`
// without it leaking into @git-for-ai/core's production public API.
export { createFixtureRepo } from "./testFixtures.js";
export type { FixtureRepo, CommitOptions, CreateFixtureRepoOptions } from "./testFixtures.js";
