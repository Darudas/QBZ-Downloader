# Handover: Qobuz library + MCP (branch `claude/lucid-clarke-915f6x`)

As of this handover, everything is committed and pushed: 398 backend tests and 82 client tests pass,
`tsc` passes, lint has 0 errors and `npm run build` works.
Related documents:
- `docs/qobuz-library-and-mcp.md`: full plan, architecture decisions, security model and detailed status.
- `docs/mcp.md`: user guide for setting up MCP clients.

## What works

- **MCP server** (`src/mcp/`) with 49 tools.
  - It is off by default and needs a bearer token in every mode.
  - The token is stored only as a SHA-256 hash in the `MCP_TOKEN_HASH` setting, which is never mirrored
    into `process.env`.
  - Permission groups: `read` (always on), `library`, `download` and `manage` (on by default), and
    `destructive` (off by default; every call also needs `confirm: true`).
  - Files:
    - `server.ts`: tools, one `McpServer` per request
    - `http.ts`: the `/mcp` endpoint and the `/api/mcp/*` admin routes
    - `token.ts`: token and config
    - `bridge.ts`: stdio bridge, exposed as the `qbz-mcp` bin
  - Tests: `src/mcp/mcp.test.ts` uses a real MCP client over HTTP.
- **Qobuz library service** (`src/services/qobuz-library/`)
  - favorites, user playlists, purchases
  - featured albums and playlists, labels, similar artists, artist releases
  - account info and URL resolving
- **Downloads and queue** (`src/services/download-actions.ts`)
  - track/album/playlist/artist/label downloads, URL downloads, queue control
  - the arbitrary-file-deletion bug is fixed in `src/services/queue/upgrade-guard.ts`
- **Local library**
  - `src/services/library-upgrade.ts`: a server-side upgrade, used by REST and MCP
  - `src/services/metadata-repair.ts`: re-tags a file from a Qobuz track
  - the MCP tools `check_in_library`, `search_local_library`, `list_duplicates`, `resolve_duplicate`
    (with a containment check), `list_upgrade_candidates`, `queue_upgrade`, `list_missing_metadata` and
    `retag_file_from_qobuz`
- **Settings** reject unregistered keys, and the quality value is a strict whitelist.

## Not verified

- **No test against a real Qobuz account.** Check these endpoints first:
  - favorites: list, add, remove
  - playlists: create, add tracks, remove tracks
  - `album/getFeatured`
  - `artist/getReleasesList`

  The parameters come from cross-checking about 20 open-source clients; see the reference section in
  `docs/qobuz-library-and-mcp.md`.
- **The stdio bridge** has not been tested end to end. To try it, run
  `npm run build && QBZ_MCP_URL=… QBZ_MCP_TOKEN=… node dist/mcp/bridge.js`.

## Next steps, by priority

1. ~~MCP section in Settings~~ **done**: `client/src/components/McpSettingsSection.tsx`. Translated
   only into en/de; the other locales fall back to English. Still to do there: add the keys to the other
   7 locale files and write a component test. Original task notes:
   - It needs an enable toggle, permission-group checkboxes, generate/rotate/revoke for the token (the
     token is shown only once) and ready-to-copy client configs.
   - The backend routes already exist: `GET /api/mcp/status`, `POST /api/mcp/config` with
     `{enabled, permissions}`, `POST`/`DELETE /api/mcp/token`.
   - Add translations to all 9 locale files.
2. **REST routes for the library features** (B1). The service layer is ready:
   - `/api/favorites`
   - `/api/me/playlists`
   - `/api/purchases`
   - `/api/discover/*`
3. **UI for those features** (C1): favorites view, heart buttons, "My playlists" view and add-to-playlist
   modal.
4. **Phase A3 hardening**:
   - zod validation for `POST /api/settings/update`
   - `..` in folder/file templates
   - temporary files in the library scanner
   - a JSON error middleware
   - refuse clearing the password on a LAN bind

   Details are in `docs/qobuz-library-and-mcp.md` under "Open".
5. **More MCP tools**:
   - smart playlists
   - safe settings read and write (needs `settings-schema.ts` from A3)
   - notifications
   - `download_purchases`
   - resources and prompts

## Pitfalls

- `src/services/dashboard/index.test.ts` and `routes.test.ts` use partial `CONFIG` mocks. New modules
  imported there must be mocked; see the `../../mcp/http.js` mock in `index.test.ts`.
- `settingsService.set`/`setMany` now throw on unknown keys. Register new keys in `KNOWN_SETTING_KEYS`.
- The stdio bridge must not import any other `src/` module, because the logger writes to stdout.
- `writeMetadata` replaces **all** tags and drops the cover unless one is passed in. Never call it with
  partial data.
