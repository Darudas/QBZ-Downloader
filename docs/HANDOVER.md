# Handover: Qobuz library + MCP (branch `claude/lucid-clarke-915f6x`)

Everything is committed and pushed. Current state: 682 backend tests and 176 client tests pass,
`tsc` passes (backend and client), lint has 0 errors, `npm run build` works and
`npm audit --omit=dev --audit-level=high` is clean.
Related documents:
- `docs/qobuz-library-and-mcp.md`: plan, architecture decisions, security model, detailed status.
- `docs/mcp.md`: user guide for MCP clients (tool list, resources, prompts, favorites auto-download).

All planned phases (A1–A3, B1, B2, C1) are implemented. The remaining risk is that nothing has been
run against a real Qobuz account yet (see "Not verified").

## What exists

**Qobuz library (REST + UI)**
- Service: `src/services/qobuz-library/` (favorites, own playlists, purchases, featured albums and
  playlists, labels, similar artists, releases, account, URL resolving).
- Routes: `src/services/dashboard/routers/qobuz-library.routes.ts`: `/api/favorites` (+ `/ids`,
  `/download`, `/sync`), `/api/me/playlists` (CRUD, tracks, follow), `/api/purchases` (+ `/ids`,
  `/download`), `/api/discover/{albums,playlists}`, `/api/label/:id`, `/api/artist/:id/{similar,releases}`,
  `/api/account`, `/api/resolve`.
- UI: Favorites, My playlists (detail at `/my_playlists/:id`), Discover, Purchases, Label page
  (`/label/:id`), similar artists and full discography on the artist page, hearts everywhere
  (`FavoriteButton` + `stores/favoritesStore.ts`), heart in the player, `AddToPlaylistModal`,
  history-aware back buttons, favorites auto-download section in Settings. `apiJson` in
  `client/src/utils/api.ts` throws the server's error message; `useLatestRequest` drops stale responses.
- Favorites auto-download: `src/services/favorites-sync.ts`. The first check (and any check for a type
  that was off or not checked for a long time) only records a baseline; it never bulk-downloads old
  favorites. "Download all missing" does that on request.

**MCP** (`src/mcp/`): 70 tools in the groups read / library / download / manage / destructive, plus
`qbz://status`, `qbz://queue` and five prompts. Off by default, bearer token always required, Host
and Origin checks, only real 401s count towards the auth limit. Destructive tools and the two tools
that permanently change files (`queue_upgrade`, `retag_file_from_qobuz`) need `confirm: true`.
The stdio bridge (`qbz-mcp`) has an end-to-end test.

**Local library**: `library-lookup.ts` (already downloaded = row + file on disk; albums complete /
partial / missing), `library-actions.ts` (upgrade, duplicates, delete, tag edits),
`tag-editor.ts` (patches FLAC/MP3 tags in place; a test checks real ffmpeg FLAC audio stays
byte-identical), scanner ignores `.qbz-part/-replace/-backup` files, subfolder scans keep the rest of
the index, DB v13 indexes. Index rows are matched by every stored path form (relative/absolute).

**Hardening**: per-key settings validation (`settings-schema.ts`), templates cannot leave the download
root, only the system volume root is refused as a library folder (other drives and NAS shares are fine),
JSON error middleware, password-guess limit on all `/api` routes and the socket.io handshake, random
login sessions (`session-store.ts`) so a logged-in browser is not locked out by someone guessing behind
the same address, `TRUST_PROXY` for reverse proxies, reset needs `{confirm:'RESET'}` and keeps the
dashboard password on a network bind, imports never clear the password, Qobuz calls fail fast with a
setup hint when no app id is configured, data folder independent of the current directory
(`src/utils/data-dir.ts`, `QBZ_DATA_DIR`).

## Not verified

- **No test against a real Qobuz account.** Check these first: favorites list/add/remove, playlist
  create/add/remove tracks/delete, follow, purchases, `album/getFeatured`, `artist/getReleasesList`,
  `artist/getSimilarArtists`, `label/get`. Parameters come from cross-checking about 20 open-source
  clients (reference section in `docs/qobuz-library-and-mcp.md`).
- UI views were checked in the running app with injected sample data and against the error path
  without credentials, not with real Qobuz responses.
- Windows-specific behaviour (drive roots, file locks during tag edits) is covered by unit tests only.

## Pitfalls

- `src/services/dashboard/index.test.ts` and `routes.test.ts` use partial `CONFIG`/settings mocks. New
  modules imported there must be mocked.
- `settingsService.set`/`setMany` throw on unknown keys; register new keys in `KNOWN_SETTING_KEYS` and
  add a validator in `settings-schema.ts`, otherwise the settings route rejects them.
- The stdio bridge must not import any other `src/` module, because the logger writes to stdout.
- `writeMetadata` replaces **all** tags and drops the cover unless one is passed in. Use
  `tag-editor.ts` (`patchTags`) for edits.
- `QobuzAPI.appId` is a getter over `CONFIG`; tests override it with `Object.defineProperty`.
