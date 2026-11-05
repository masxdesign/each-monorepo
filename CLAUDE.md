# EACH monorepo

Sessions usually start here, at the monorepo root, but most work is in the React app. Its
full instructions are imported at the bottom and apply to every session.

**Paths in the imported section are relative to `apps/frontend/property-pub-react/`**, so
`src/...` means `apps/frontend/property-pub-react/src/...`. Run the app's npm scripts from
that folder (`npm run deploy:dev`, `npm run deploy`, `npx vitest`, `npx eslint`).

## Layout

| Path | What | Branch |
|---|---|---|
| `apps/frontend/property-pub-react` | The React SPA (submodule) | `develop` |
| `apps/backend/property-pub` | property-pub API + SSR (submodule) | `develop` |
| `apps/backend/bizchat` | Messaging, department clients (submodule) | `feature/pc-map` |
| `packages/backend-shared/*` | Shared backend packages, e.g. `oauth` (submodules) | `develop` |

Check the real branch with `git -C <path> branch --show-current`; these move. Outside this
repo: `../4prop` (PHP app), `../4prop-container` (Docker, nginx), `../4prop-k8s-deployments`.

Each backend has its own `CLAUDE.md`, read when you work in that folder.

## Committing

Each submodule is its own repo: commit and push there first, then bump it here
(`git add <path>`, commit, push). Only when asked.

## App instructions

@apps/frontend/property-pub-react/CLAUDE.md
