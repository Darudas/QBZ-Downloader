# Qobuz library features and AI control (MCP): plan and status

This document is the working plan for two connected features:

1. **Qobuz user library** inside QBZ-Downloader: favorites, your own Qobuz playlists, purchases and
   discovery (new releases, editor picks, labels, similar artists, full discographies, playlist search).
2. **AI control over MCP** (Model Context Protocol), so an assistant such as Claude Desktop, Claude Code,
   Open WebUI, n8n or Cursor can drive everything the app does: search, inspect, favorite, manage
   playlists, download, run the queue and maintain the local library.

It also records security problems found in the existing code that had to be fixed before an AI is
allowed to control the app.

> **Status (current branch):** the MCP server (B2, core tool set) is implemented, tested and documented
> in [`docs/mcp.md`](mcp.md); phase A is partly done. The Qobuz API layer, the Qobuz library service and
> the queue/download safety work are implemented and tested; everything else below is planned. See
> [Status](#status) for the exact list.

---

## Architecture decisions

These are fixed; later phases build on them.

| Topic | Decision |
|---|---|
| MCP SDK | v2 packages (`@modelcontextprotocol/server`, `/node`, `/client`), already in `dependencies`. v1 (`@modelcontextprotocol/sdk`) is the maintenance line. v2 serves today's 2025-era clients through its stateless legacy mode. |
| Transport | Streamable HTTP at `ALL /mcp` on the existing dashboard server (port 3000 in Docker; dynamic loopback port in desktop mode). Stateless: `createMcpHandler(factory)` plus `toNodeHandler`, with a **new `McpServer` per request** and schemas defined once at module scope. |
| stdio | Standalone bridge `src/mcp/bridge.ts`, exposed as `"bin": {"qbz-mcp": "dist/mcp/bridge.js"}`. It forwards stdio to the HTTP endpoint and reads `QBZ_MCP_URL` and `QBZ_MCP_TOKEN` from the environment, never from argv. It must not import other `src/` modules: the logger writes to stdout, which is the protocol channel. It also must not open the database itself, because that would create a second queue processor and a second SQLite writer. |
| Shared logic | REST routes and MCP tools call the **same** service functions (`qobuzLibraryService`, `downloadActionsService`, the planned `libraryLookupService`, `libraryActionsService`, `settings-schema`). Route handlers contain no business logic. |
| Validation | zod v4 for every REST body/query and every MCP tool input. |
| IDs | Album IDs are strings matching `^[A-Za-z0-9]{1,40}$`. Track, artist, playlist and label IDs are positive integers. `playlist_track_id` can exceed 2^31. |
| Quality | Only `5` (MP3 320), `6` (FLAC 16/44.1), `7` (FLAC 24/≤96), `27` (FLAC 24/≤192), plus the aliases `max`→27 and `min`→5. |

### Security model for `/mcp`

- **Off by default.** Setting `MCP_ENABLED` defaults to `false`; while disabled, `/mcp` answers 404.
- **Bearer token, always required.** This includes desktop mode and installs without a dashboard
  password.
  - The token is generated server-side with `randomBytes(32).toString('base64url')` and shown to the user
    once.
  - Only its SHA-256 is stored, in `MCP_TOKEN_HASH`, a sensitive key. It is never mirrored into
    `process.env`, never returned by `GET /api/settings`, and compared with `timingSafeEqual`.
  - For headless/Docker installs, the environment variable `QBZ_MCP_TOKEN` (32 characters or more) is
    accepted as well and is never stored.
- **Mounting.** `/mcp` is mounted after the host guard, CSRF guard and header middleware, and before the
  global `express.json`. The `/mcp` router then applies, in order:
  1. its own rate limiter;
  2. the enabled check;
  3. bearer auth, returning 401 with `WWW-Authenticate: Bearer realm="qbz-mcp"`, with an auth-failure
     limiter;
  4. a 1 MB JSON parser that returns JSON-RPC `-32700` on bad input;
  5. the handler.

  Requests with a foreign `Origin` are rejected, and loopback binds validate `Host`.
- **Permission groups.** A tool whose group is disabled is not registered at all.

| Group | Contents | Default |
|---|---|---|
| `read` | All read-only tools | always on |
| `library` | Reversible Qobuz account writes: favorites, create/update playlists, add/remove playlist tracks, follow/unfollow | on |
| `download` | Enqueue downloads, queue control, lyrics | on |
| `manage` | Scans, watched/smart playlists, metadata edits, safe settings, notifications, favorites sync | on |
| `destructive` | Delete a Qobuz playlist, resolve a duplicate (deletes a file), delete a library file, clear history, clear the pending queue | **off**; every call additionally requires `confirm: true` |

- **Never exposed to the AI:** system reset, Qobuz credentials and accounts, the dashboard password,
  download/export paths, folder/file templates, the media-server URL/token/test, the AI provider/key/model,
  config import/export, signed stream URLs, and path-based batch imports (URL imports only).
- **Errors.** Tool errors are mapped to safe messages through `toSafeErrorPayload`. Raw axios errors are
  never serialized, because they carry `user_auth_token`. Every call is audit-logged by tool name only.
- **Untrusted text.** Text that comes from Qobuz (descriptions, biographies, lyrics) is length-capped and
  returned as data.

### MCP tool catalogue (target)

Tool names are binding for the UI and documentation.

- **read**
  - Account and status: `get_status`, `get_account_info`
  - Catalog search and lookup: `search_catalog(query, type=albums|tracks|artists|playlists, limit, offset)`,
    `resolve_qobuz_url(url)`, `get_album`, `get_track`, `get_artist`,
    `get_artist_releases(artist_id, release_type, sort, limit, offset)`, `get_similar_artists`,
    `get_playlist(playlist_id, limit, offset)`, `get_label(label_id, limit, offset)`
  - Discovery: `get_featured_albums(type, genre_id, limit, offset)`, `get_featured_playlists`, `list_genres`,
    `get_lyrics`
  - Your Qobuz account: `list_favorites(type, limit, offset)`, `check_favorites`,
    `list_my_playlists(filter, limit, offset)`, `list_purchases`
  - Queue and history: `get_queue(status, limit, offset)`, `get_queue_item`, `get_download_history`
  - Local library: `search_local_library`, `check_in_library(album_ids, track_ids)`, `get_library_stats`,
    `get_scan_status`, `list_duplicates`, `list_upgrade_candidates`, `list_missing_metadata`,
    `list_watched_playlists`, `list_smart_playlists`, `get_smart_playlist_tracks`
  - App: `get_settings` (safe subset), `list_notifications`
- **library:** `add_favorites`, `remove_favorites`, `create_playlist(name, description, is_public=false, track_ids, album_id)`,
  `update_playlist`, `add_tracks_to_playlist(playlist_id, track_ids, album_id, allow_duplicates=false)`,
  `remove_tracks_from_playlist(playlist_id, track_ids | playlist_track_ids)`, `follow_playlist`, `unfollow_playlist`
- **download:** `download(type=track|album|playlist|artist|label, id, quality, track_ids?, skip_existing=true)`,
  `download_urls(urls[], quality)`, `download_favorites(type=albums|tracks|all, only_missing=true, quality)`,
  `download_purchases`, `control_queue(action=pause|resume|clear_completed|retry_failed)`, `cancel_queue_item`,
  `retry_queue_item`, `set_queue_priority(id, low|normal|high)`, `download_lyrics`
- **manage:** `start_library_scan(deep)`, `abort_library_scan`, `watch_playlist(playlist_id, interval_hours, quality)`,
  `unwatch_playlist`, `sync_watched_playlists(playlist_id?)`, `create_smart_playlist`, `delete_smart_playlist`,
  `edit_track_metadata(file_path, fields)`, `queue_upgrade(library_file_id | file_path, candidate_track_id?, quality)`,
  `update_settings(settings)`, `mark_notifications_read`, `sync_favorites_now`
- **destructive** (each also needs `confirm: true`): `delete_playlist`, `resolve_duplicate(duplicate_id, keep=auto|first|second)`,
  `delete_library_file`, `clear_download_history`, `remove_history_entry`, `clear_pending_queue`
- **Resources:** `qbz://status`, `qbz://queue`.
- **Prompts:** `download_discography(artist)`, `find_hires_upgrades`, `clean_duplicates`, `sync_favorites`,
  `build_playlist(theme)`.

Conventions for every tool:
- snake_case names of at most 40 characters;
- a precise description and a `.describe()` on every input field;
- deliberate `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` annotations;
- results as both `structuredContent` and a compact JSON text copy;
- list tools paginate with a default of 20–25 and a maximum of 100, returning
  `{items, total, offset, limit, has_more}`.

### New settings keys

| Key | Type | Default | Notes |
|---|---|---|---|
| `MCP_ENABLED` | bool | `false` | |
| `MCP_TOKEN_HASH` | secret | – | SHA-256 of the token. Sensitive. Not REST-writable, never mirrored to env. |
| `MCP_TOKEN_CREATED_AT` | ISO string | – | |
| `MCP_PERMISSIONS` | list | `library,download,manage` | `read` is implicit; `destructive` is opt-in |
| `FAVORITES_AUTO_DOWNLOAD` | bool | `false` | Download new favorites automatically |
| `FAVORITES_AUTO_DOWNLOAD_TYPES` | list | `albums,tracks` | |
| `FAVORITES_SYNC_INTERVAL_HOURS` | int | `6` | |

---

## Status

### Done (this branch)

**Foundation**
- MCP SDK v2 dependencies are installed and `npm audit --audit-level=high` is clean.
- `npm run lint` now covers all of `src/`. Before, the unquoted glob skipped routers, the database, the
  queue and the scanner on POSIX.
- `docker-compose.yml` now uses `FOLDER_TEMPLATE`. The old example used `FOLDER_STRUCTURE`, which
  nothing reads.

**A1: Qobuz API layer and library service**

*Transport (`src/api/qobuz.ts`)*
- Generic GET/POST request with a shared rate limiter.
- POST writes are form-encoded, with the token in the body and the `X-User-Auth-Token` header, never in
  the URL.
- Non-idempotent writes are retried only on 429.
- A `status:"error"` body inside a 200 response is treated as an error.

*Errors (`src/utils/errors.ts`)*
- New error classes: `ForbiddenError` (403), `NotFoundError` (404), `RateLimitError` (429),
  `ValidationError` (400). `AuthenticationError` now carries 401.
- Only a 401 marks the Qobuz token invalid. Before, any 403 logged the user out.
- New helper `toSafeErrorPayload()`.

*Other API fixes*
- The `getFileUrl` quality fallback no longer runs five requests on auth or signature errors.
- `getLyrics`/`getGoodies` no longer re-wrap errors.

*Cache (`src/utils/cache.ts`)*
- Returns clones, so routes can no longer mutate cached Qobuz objects.
- Reads no longer extend the TTL.
- New `deleteByPrefix`.
- User data uses user-scoped keys, which are cleared on account switch or credential change.

*New Qobuz methods*
- Favorites: get, ids, add, remove.
- User playlists: list, page, create, update, delete, add tracks, remove tracks, subscribe, unsubscribe.
- Purchases: list and ids.
- Featured albums and playlists.
- Label, similar artists, artist releases, album track ids.
- `lastUpdate`.
- Search with `type=playlists`.

*Shared URL parser (`src/utils/validator.ts`)*
- New `parseQobuzUrl()` handles `open.`/`play.`/`www.qobuz.com`, locales, `/interpreter/` and labels.
- The host check is fixed: `qobuz.com.evil.tld` used to pass.

*Library service (`src/services/qobuz-library/`)*
- `qobuzLibraryService` is validated with zod and handles:
  - favorites: list/check/add/remove, chunked, with cache invalidation and events;
  - playlists: owner checks, album expansion, track id → `playlist_track_id` resolution, `is_public=false`
    by default;
  - follow/unfollow, purchases, featured content, label, similar artists, releases;
  - safe account info (no token, no email) and `resolveUrl`.
- It also provides compact mappers (`toAlbumSummary` and others) and a `paginate` helper.

**A2: queue and download safety (partly done; see open items)**

*Fixed: file deletion via upgrade metadata*
- `POST /api/queue/add` used to pass client `metadata` through. The queue processor then deleted
  `metadata.oldFilePath` when `isUpgrade` was set, so any caller could delete any file.
- Caller metadata is now ignored.
- Before deleting, `src/services/queue/upgrade-guard.ts` checks that the old file is inside the managed
  roots, is in `library_files`, and is not the new file.

*Queue*
- `type` and `priority` are validated, and label is supported as a type.
- New `retry`, `retryAllFailed`, `setPriority` and `addWithResult` (reports deduplication).
- Cancelling is a real `cancelled` state, with no error notification or retry noise.

*Artist and label downloads*
- These now enqueue one item per album, paginated over all albums.
- Before, they read the wrong response shape and downloaded nothing, were capped at 50 albums, could
  deadlock on the concurrency limiter, and ran inside the HTTP request.

*`downloadActionsService` (`src/services/download-actions.ts`)*
- Single entry point for downloads: `enqueue` (with an album track subset) and `enqueueUrls`.
- Also queue control and compact queue listing.

*New and fixed REST routes*
- New routes:
  - Download and queue:
    - `POST /api/download` (generic)
    - `POST /api/download/urls`
    - `GET /api/queue/item/:id`
    - `POST /api/queue/item/:id/{retry,priority}`
    - `POST /api/queue/retry-failed`
    - `clear-pending` as a new `/api/queue/action`
  - History: `DELETE /api/history/:id` (the client already called it and always got 404), and
    `GET /api/history` with `q/limit/offset`.
  - Watched playlists: `PATCH /api/playlists/watch/:id`, `POST /api/playlists/watch/:id/sync`,
    `POST /api/playlists/watched/sync`.
- Fixes:
  - All inputs are validated with zod and errors come back as JSON.
  - Lyrics saving checks the managed roots.

*Playlist watcher*
- Validates intervals.
- Stops re-queueing permanently failed tracks every interval.
- New `syncNow`.

*Batch import*
- Spotify URLs no longer become bogus queue items.
- Batches survive deduplicated adds and no longer finalize early because of per-retry failure events.

**Follow-ups done after phase A was stopped**
- `POST /api/library/upgrade`: queues a Hi-Res upgrade for a scanned library file. The request may only
  name an indexed file inside the managed roots and one of the upgrade candidates the scanner recorded
  for it; the upgrade metadata is built server-side. The Library view's upgrade button uses it again
  (it was broken by the queue fix above).
- `normalizeDownloadQuality` is a strict whitelist (`ALLOWED_QUALITIES` = 5, 6, 7, 27; `max`/`min`
  aliases). Anything else falls back to the default instead of reaching `getFileUrl`.

**B2: MCP server (core done)**
- `src/mcp/server.ts`: 41 tools across the groups read/library/download/manage/destructive,
  registered per request according to `MCP_PERMISSIONS`. Destructive tools need `confirm: true`. The
  handler wrapper sanitizes errors and audit-logs calls by name.
- `src/mcp/http.ts`: the `/mcp` endpoint, with a rate limit, a 404 while disabled, a foreign-Origin
  reject, bearer auth plus an auth-failure limiter, and a 1 MB parser. It also holds the admin routes
  `GET /api/mcp/status`, `POST /api/mcp/config`, `POST`/`DELETE /api/mcp/token` (behind the dashboard
  password).
- `src/mcp/token.ts`: the token is hashed (`MCP_TOKEN_HASH`) and compared in constant time. The
  `QBZ_MCP_TOKEN` env override is supported. The MCP keys are registered in settings, and the hash is
  never mirrored to or imported from `process.env`.
- `src/mcp/bridge.ts` with `"bin": {"qbz-mcp": "dist/mcp/bridge.js"}`.
- Tests (`src/mcp/mcp.test.ts`) use a real MCP client over HTTP and cover the 404, 401 and foreign-Origin
  responses, tool gating per group, `confirm`, and tool calls.
- **Still open in B2:**
  - tools that depend on A3/B1 services: `check_in_library`, `search_local_library`, duplicates,
    upgrades, metadata edits, smart playlists, safe settings read/write, notifications,
    `download_purchases`, `download_lyrics`;
  - resources and prompts;
  - a Host-header check for loopback binds;
  - a bridge end-to-end test.
- **UI still missing:** the MCP section in Settings. For now enable MCP with `curl` (see `docs/mcp.md`).

**Verification:** `npx tsc --noEmit` passes, lint has 0 errors, 384 backend tests pass (272 before), and
82 client tests pass. The client typecheck passes.

### Open: still to do

**A2 leftovers.** These need checking; the agent was stopped while finishing its tests.
- Re-read `download.routes.ts` and `catalog.routes.ts` end to end.
- Add route tests for the new endpoints (retry/priority, `/download/urls`, watch PATCH/sync, history
  delete).
- The `already_downloaded` flags should use the planned `libraryLookupService` (track row plus file on
  disk). Today they use the `tracks` table, and the `albums` table is never written.

**A3: settings, library, server hardening (not started)**

*Config and settings*
- `src/config.ts`:
  - Add the `CONFIG.mcp` and `CONFIG.favorites` getters.
- `src/services/settings.ts`:
  - Register the new keys.
  - `set`/`setMany` must refuse unknown keys. Today any key, for example `QBZ_DESKTOP`, ends up in
    `process.env`, and the desktop auth bypass reads it.
  - Do not mirror secret keys into `process.env`.
  - Environment variables must not overwrite `MCP_TOKEN_*`.
- New `src/services/settings-schema.ts`:
  - The REST allowlist with per-key validation: ranges, enums, and templates without `..`.
  - `getSafeSettings()` / `applySafeSettings()` for MCP. Read: no secrets, paths, URLs or user id. Write: a
    small allowlist only.

*System routes (`system.routes.ts`)*
- Validation and the new keys.
- Cache `getUserInfo` instead of calling Qobuz on every `GET /settings`.
- `POST /system/reset` should require `{confirm:'RESET'}`, and the client must be updated to send it.
- Refuse clearing the dashboard password while the server is bound to a non-loopback address. Today that
  leaves `0.0.0.0` open with no password.

*Dashboard server (`dashboard/index.ts`)*
- App-level JSON error middleware. Today, thrown errors become Express HTML pages with stack traces.
- Count failed `x-password` attempts on all `/api` routes, not only on `/api/login`.

*Path safety*
- `FOLDER_TEMPLATE`/`FILE_TEMPLATE` containing `..` must not escape the download root.
- `isPathWithinManagedRoots` must refuse filesystem-root roots (`/`, `C:\`).

*Library scanner*
- Exclude `*.qbz-part.*`, `*.qbz-backup-*` and `*.qbz-replace-*` files. Today they get indexed and can
  be flagged as duplicates and deleted.
- `resolveDuplicate(id, {keep, dryRun})` with a containment check.
- Scanning a subfolder must not wipe the rest of the library index.
- Remove the leftover `'stereo love'` debug code.

*Database*
- `DB_VERSION` 13 with indexes on `tracks(isrc, album_id, file_path)`, `library_files(track_id)` and
  `queue_items(status)`.
- Fix the `LIMIT` interpolation in `getHistorySorted`.
- New `searchLibraryFiles`, `searchTracksPaged`, `getTracksByAlbumId`, `getLibraryFileById`.
- Fix or remove the broken `updateTrackMetadata`/`updateTrackPath`.

*New services and routes*
- `src/services/library-lookup.ts`: `checkTracks`, `checkAlbums` (complete/partial/missing),
  `searchLocalLibrary`.
- `src/services/library-actions.ts`: `queueUpgrade`, which builds the upgrade metadata server-side,
  plus `editTrackMetadata`, `deleteLibraryFile` and `resolveDuplicate`.
- Routes: `GET /api/library/search`, `GET /api/library/lookup`. (`POST /api/library/upgrade` is done;
  move its logic into `libraryActionsService.queueUpgrade` so MCP can reuse it.)

**B1: REST and services for the library features**
- Routers:
  - favorites: `/api/favorites` (list per type), `/api/favorites/ids`, `POST`/`DELETE /api/favorites`;
  - your playlists: `/api/me/playlists` (list/create) and `/api/me/playlists/:id` (get/update/delete,
    tracks add/remove, follow/unfollow);
  - purchases: `/api/purchases`;
  - discovery: `/api/discover/albums?type=&genre_id=`, `/api/discover/playlists`;
  - labels and artists: `/api/label/:id`, `/api/artist/:id/similar`, `/api/artist/:id/releases`;
  - `/api/account`.
- `downloadActionsService.downloadFavorites({type, onlyMissing, quality})` and `downloadPurchases(...)`.
- `favoritesSyncService` with optional auto-download of new favorites on an interval, plus `syncNow()`.
- Socket broadcasts for `favorites:updated` and `playlists:updated`, driven by
  `EVENTS.QOBUZ_LIBRARY.*` on the event bus.

**B2: MCP server**
- Files in `src/mcp/`:
  - `server.ts`: the factory, which takes the enabled permission groups;
  - `tools/*.ts`: one file per group;
  - `auth.ts`, `http.ts` (router and mount), `token.ts`, `bridge.ts`;
  - the resources and prompts.
- Mount it in `dashboard/index.ts` as described above.
- Token management routes, all behind the dashboard password: `GET /api/mcp/status`, `POST /api/mcp/token`
  (rotate; returns the plaintext once), `DELETE /api/mcp/token`.
- Add `"bin": {"qbz-mcp": "dist/mcp/bridge.js"}`.
- Tests:
  - an in-memory `Client` covering registration, permission gating, `confirm`, error sanitization and
    pagination;
  - HTTP tests for 401/404, foreign Origin, the Host guard, and checking that `GET /mcp` is not answered by
    the SPA;
  - a bridge end-to-end test.
- Add `CONFIG.mcp` to the `CONFIG` mocks in `routes.test.ts` and `dashboard/index.test.ts`.

**C1: dashboard UI**
- New views:
  - `FavoritesView`: Albums / Tracks / Artists tabs, "download all missing", remove;
  - `MyPlaylistsView` and `PlaylistDetailView`: create, rename, delete, remove tracks, download;
  - `DiscoverView`: featured types, genre filter, labels.
- Shared UI:
  - heart buttons (search, album, artist and player views, via `stores/favoritesStore.ts` loaded from
    `/api/favorites/ids` with optimistic updates);
  - `AddToPlaylistModal`;
  - an `apiJson` helper that checks `res.ok`.
- Settings: a new `McpSettingsSection` with enable, token generate/rotate/copy, permission groups and
  ready-to-copy configs.
- Translations in all 9 locale files.
- See the client audit notes below for existing UI bugs to fix along the way.

**C2: docs**
- README: "AI control (MCP)" with setup for Claude Desktop (stdio bridge or `mcp-remote`), Claude Code
  (`claude mcp add --transport http …`), Open WebUI ("MCP (Streamable HTTP)", bearer), n8n and Cursor;
  plus a Docker section.
- Update `AGENTS.md` and `CHANGELOG.md`.
- claude.ai web connectors need public HTTPS plus OAuth, so they are out of scope.

**D: review**
- Independent review for security, correctness, MCP protocol, UI and completeness.
- Live test with a real MCP client over HTTP and through the stdio bridge.
- Full CI: lint, `tsc`, backend and client tests, client build, `npm audit`.

---

## Client configuration (once B2 is done)

```bash
# Claude Code
claude mcp add --transport http qbz http://127.0.0.1:3000/mcp --header "Authorization: Bearer <token>"
```

```json
// Claude Desktop (claude_desktop_config.json): stdio bridge
{ "mcpServers": { "qbz": {
    "command": "node",
    "args": ["/absolute/path/QBZ-Downloader/dist/mcp/bridge.js"],
    "env": { "QBZ_MCP_URL": "http://127.0.0.1:3000/mcp", "QBZ_MCP_TOKEN": "<token>" } } } }
```

For Open WebUI, go to Admin Settings → External Tool Servers → "MCP (Streamable HTTP)" and enter the URL
`http://<server>:3000/mcp`, auth Bearer `<token>`. When Open WebUI runs in Docker, `127.0.0.1` is the Open
WebUI container itself. In that case QBZ needs a LAN bind, which requires a dashboard password.

---

## Reference: Qobuz endpoints used

The endpoints were cross-checked against about 20 open-source clients, including streamrip, qobuz-dl,
QobuzApiSharp, qobine, hifi.rs, minim, Strawberry and the LMS plugin. **None of this has been verified
against a live account**, so test it with a real account before relying on it.

- **Favorites**
  - `favorite/getUserFavorites`: `type=albums|tracks|artists`, `limit` ≤ 500, `offset`; unsigned.
  - `favorite/getUserFavoriteIds`.
  - `favorite/create` and `favorite/delete`: plural `album_ids`/`track_ids`/`artist_ids`, comma-separated.
- **Playlists**
  - `playlist/getUserPlaylists`: `filter=owner|subscriber`.
  - `playlist/get`: items carry `playlist_track_id`.
  - `playlist/create`: always send `is_public`, because the API defaults to public. Send
    `is_collaborative=false` when the playlist is not public.
  - `playlist/update`: never send `track_ids`, which replaces every track.
  - `playlist/delete`.
  - `playlist/addTracks`: `no_duplicate=true`.
  - `playlist/deleteTracks`: takes **`playlist_track_ids`**, not track ids.
  - `playlist/subscribe` and `playlist/unsubscribe`.
- **Purchases:** `purchase/getUserPurchases`, `purchase/getUserPurchasesIds` (not paginated).
- **Discovery**
  - `album/getFeatured`: `type=new-releases|most-streamed|best-sellers|press-awards|editor-picks|ideal-discography|qobuzissims|…`;
    `genre_id` for one genre, `genre_ids` for several.
  - `playlist/getFeatured`: `type=editor-picks|last-created`.
  - `label/get`: `extra=albums`.
  - `artist/getSimilarArtists`: `limit` ≤ 100.
  - `artist/getReleasesList`: `has_more` with no total; `limit` ≤ 100.
- **Pagination:** a page can hold fewer items than `limit`. Continue at `offset + limit` until `items` is
  empty or `total` is reached.
- **Writes:** non-idempotent writes (`playlist/create`, `addTracks` with duplicates allowed, `update`) must
  not be retried after a timeout. Favorite and subscribe writes are idempotent.

## Reference: existing bugs found by the audit (not yet fixed)

- **Client**
  - The command palette reads `data.suggestions`, but the route returns `{artists, albums, tracks}`, so
    results are always empty.
  - Many buttons show a success toast without checking `res.ok`. `smartFetch` returns `null` on 429 or a
    network error.
  - The `metadata` tab renders a blank page.
  - `ThemeContext` uses raw `fetch` with no auth header.
  - `LoginModal` shows a hardcoded `v5.2.0`.
- **Lyrics:** Qobuz-sourced lyrics are embedded empty. `download.ts` passes `syncedLyrics: !!synced`, a
  boolean, where `metadata.ts` expects the string.
- **Statistics:** the activity chart is always zero, because `downloaded_at` is ISO but is split on a space
  (`LibraryStatisticsService.ts`).
- **Desktop mode:** a desktop start writes `DASHBOARD_PORT`/`DASHBOARD_HOST` from Electron's environment
  into the database, so a later headless `npm start` binds 127.0.0.1:3210+.
- **`sync-version`:** on the next version bump it renames the wrong CHANGELOG heading.
- **Encryption:** the encryption key and the database path depend on the current working directory.
  Starting from another directory silently yields ciphertext instead of the credentials.
