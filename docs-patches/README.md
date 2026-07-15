# docs-patches

Apply-ready patches for **cross-owner** documentation this branch should not edit
directly (per `.github/CODEOWNERS`).

## `root-README.patch`

Updates the root `README.md` workspace map: `@ramp/ledger` now also depends on
`@ramp/gate` (the read-only policy simulator runs the real kernel), serves
`GET /simulate`, and stamps every proof with a stable policy digest.

Root config/docs are owned by **@Srujyama**, so this is delivered as a patch
rather than an edit. Apply from the repo root:

```sh
git apply docs-patches/root-README.patch
```

Verified with `git apply --check` at authoring time.
