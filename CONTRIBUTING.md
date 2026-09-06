# Contributing

git-for-ai was built as a private project, almost entirely by AI coding agents directed by
one person, and is published as-is under the MIT licence.

**This repository does not accept contributions.** Pull requests and feature requests will be
closed without review, and there is no support channel.

If you want to change or extend it, fork it. The recommended way to work on a fork is to
point your own AI coding agent at it:

- [`CLAUDE.md`](CLAUDE.md) is the working context an agent needs: build and test commands, the
  rules the codebase relies on, and the platform quirks.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) covers the same ground for a person.
- The repository's own history is recorded with git-for-ai. After `git for-ai sync --fetch`,
  `git for-ai log --intent`, `git for-ai show <sha>` and `git for-ai ask "..."` explain why
  the code is the way it is, including the captured sessions that produced it.

Bug reports may be filed as issues so that others can find them, but they will not
necessarily be acted on.
