# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
Changesets drive versioning, the changelog, and npm publishing for the
`roboport` package.

When you make a user-facing change, add a changeset:

```sh
bun run changeset
```

Pick the bump (`patch` / `minor` / `major`) and write a short summary. Commit
the generated `.changeset/*.md` file with your PR.

On push to `main`, the Release workflow either opens a "Version Packages" PR
(consuming pending changesets) or, once that PR is merged, publishes the new
version to npm.

See the [docs](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)
for details.
