# AI control over MCP

QBZ-Downloader includes an MCP (Model Context Protocol) server. With it, an AI assistant can search
Qobuz, manage your Qobuz favorites and playlists, start downloads, and run the download queue. It
works with Claude Desktop, Claude Code, Open WebUI, n8n, Cursor and any other MCP client.

- **Endpoint:** `http://<host>:<dashboard-port>/mcp` (Streamable HTTP). In Docker that is port 3000.
- **stdio bridge:** `dist/mcp/bridge.js` (`qbz-mcp`), for clients that only start local commands.
- The MCP server is **off by default** and always requires a bearer token, also in desktop mode and on
  installs without a dashboard password.

## 1. Enable it and create a token

In the dashboard, open **Settings → AI control (MCP)**. There you can enable the endpoint, choose the
allowed actions, generate the token (shown once) and copy ready-made client configs.

Alternatively, use the dashboard API. Its routes sit behind the dashboard password, so send
`x-password` if you set one.

```bash
H='x-password: <dashboard password>'   # omit if no password is set
URL=http://127.0.0.1:3000

curl -s -X POST -H "$H" -H 'content-type: application/json' \
     -d '{"enabled": true}' $URL/api/mcp/config

# Prints the token ONCE. Only its hash is stored. Running this again rotates the token.
curl -s -X POST -H "$H" $URL/api/mcp/token

curl -s -H "$H" $URL/api/mcp/status              # current state
curl -s -X DELETE -H "$H" $URL/api/mcp/token     # revoke the token
```

On headless/Docker installs you can instead set the environment variable `QBZ_MCP_TOKEN` (32+
characters, for example from `openssl rand -base64 32`). It is accepted in addition to a stored token
and is never written to the database. You still have to enable MCP with the call above or with
`MCP_ENABLED=true`.

## 2. Permissions

Tools are grouped. A tool from a disabled group is not offered to the AI at all.

| Group | Tools | Default |
|---|---|---|
| `read` | `get_status`, `get_account_info`, `search_catalog`, `resolve_qobuz_url`, `get_album`, `get_track`, `get_artist`, `get_artist_releases`, `get_similar_artists`, `get_playlist`, `get_label`, `get_featured_albums`, `get_featured_playlists`, `list_genres`, `get_lyrics`, `list_favorites`, `check_favorites`, `list_my_playlists`, `list_purchases`, `get_queue`, `get_queue_item`, `get_download_history`, `get_scan_status`, `get_library_stats`, `check_in_library`, `search_local_library`, `list_duplicates`, `list_upgrade_candidates`, `list_missing_metadata`, `list_watched_playlists`, `list_smart_playlists`, `get_smart_playlist_tracks`, `list_notifications` , `get_settings` (safe subset: quality, concurrency, cover/lyrics options, favorites auto-download; no credentials, paths or URLs) | always on |
| `library` | `add_favorites`, `remove_favorites`, `create_playlist`, `update_playlist`, `add_tracks_to_playlist`, `remove_tracks_from_playlist`, `follow_playlist`, `unfollow_playlist` | on |
| `download` | `download`, `download_urls`, `download_favorites`, `download_purchases`, `control_queue`, `cancel_queue_item`, `retry_queue_item`, `set_queue_priority`, `download_lyrics` (saves an `.lrc` next to a downloaded track) | on |
| `manage` | `start_library_scan`, `abort_library_scan`, `edit_track_metadata` (changes single tags of a FLAC/MP3 file, keeps the rest and the cover), `watch_playlist`, `unwatch_playlist`, `sync_watched_playlists`, `sync_favorites_now`, `create_smart_playlist`, `delete_smart_playlist`, `mark_notifications_read`, `queue_upgrade` (replaces the old file after the better one is downloaded), `retag_file_from_qobuz` (rewrites a file's tags and cover from a Qobuz track), `update_settings` (allowlisted fields only) | on |
| `destructive` | `delete_playlist`, `delete_library_file` (only indexed files inside the library folders), `clear_pending_queue`, `clear_download_history`, `remove_history_entry` (both keep the files on disk), `resolve_duplicate` (deletes the worse file of a pair; refuses files outside the library folders). Each also needs `confirm: true` | **off** |

### Resources and prompts

Resources (read-only, always available):

| URI | Content |
|---|---|
| `qbz://status` | Same JSON as `get_status`: version, credentials state, queue statistics, scan state, favorites auto-download schedule |
| `qbz://queue` | Running and pending downloads (up to 100) with queue statistics |

Prompts are ready-made workflows the client can offer as commands. A prompt is only listed when the
tools it uses are enabled.

| Prompt | Arguments | Needs |
|---|---|---|
| `download_discography` | `artist` | `download` |
| `sync_favorites` | – | `download` |
| `find_hires_upgrades` | – | `manage` |
| `clean_duplicates` | – | always; it only reports unless `destructive` is enabled |
| `build_playlist` | `theme` | `library` |

### Favorites auto-download

With the settings `FAVORITES_AUTO_DOWNLOAD=true`, `FAVORITES_AUTO_DOWNLOAD_TYPES` (`albums`, `tracks` or
both) and `FAVORITES_SYNC_INTERVAL_HOURS` (1–168, default 6), the app checks your Qobuz favorites on that
interval and queues the ones added since the last check. The first check for an account and type, and
the first check after the setting is switched on, only records the current favorites as a baseline and
downloads nothing; use `download_favorites` (or "Download all missing" in the dashboard) for the existing
list. `sync_favorites_now` (and `POST /api/favorites/sync`) runs a check immediately, even when the
schedule is off; `GET /api/favorites/sync` shows the last and next check.

To change the enabled groups (`read` is always on):

```bash
curl -s -X POST -H "$H" -H 'content-type: application/json' \
     -d '{"permissions": ["library", "download", "manage"]}' $URL/api/mcp/config
```

The AI never gets access to Qobuz credentials, the dashboard password, paths and templates, system
reset, media-server or AI settings, or config import/export.

## 3. Connect a client

**Claude Code**

```bash
claude mcp add --transport http qbz http://127.0.0.1:3000/mcp --header "Authorization: Bearer <token>"
```

**Claude Desktop**: `claude_desktop_config.json` only supports stdio, so use the bridge. Build the app
first with `npm run build`.

```json
{ "mcpServers": { "qbz": {
    "command": "node",
    "args": ["/absolute/path/QBZ-Downloader/dist/mcp/bridge.js"],
    "env": { "QBZ_MCP_URL": "http://127.0.0.1:3000/mcp", "QBZ_MCP_TOKEN": "<token>" } } } }
```

**Open WebUI** (v0.6.31 or later): go to Admin Settings → Integrations → External Tool Servers → Add
Connection. Choose type "MCP (Streamable HTTP)", URL `http://<qbz-host>:3000/mcp`, auth "Bearer" with the
token. When Open WebUI runs in Docker, `127.0.0.1` points to its own container, not to QBZ. In that case
use the LAN address of QBZ. A LAN bind requires a dashboard password.

**n8n**: add an "MCP Client Tool" node with endpoint `http://<qbz-host>:3000/mcp`, transport
"HTTP Streamable", and Bearer auth with the token.

**Cursor**: in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "qbz": { "url": "http://127.0.0.1:3000/mcp",
    "headers": { "Authorization": "Bearer <token>" } } } }
```

claude.ai web connectors are not supported. They need a public HTTPS endpoint with OAuth.

## Examples

- "Download all albums by Radiohead I don't have yet, in the best quality."
- "Add Kind of Blue to my favorites and create a private playlist 'Late night jazz' with its first three
  tracks."
- "What new releases are there in jazz this week? Queue the three with the best reviews."
- "Download all my favorite albums."
- "Pause the queue. Which downloads failed? Retry them."
- "Do I already have Kind of Blue? If only partly, download the missing tracks."
- "Scan my library, show me the duplicates and the files that can be upgraded to Hi-Res."
- "Download everything I bought on Qobuz that I don't have yet."
- "Make a smart playlist of my Hi-Res jazz and list its tracks."

## Security notes

- The token is stored only as a SHA-256 hash in an encrypted setting. It is never mirrored into
  `process.env` and is compared in constant time.
- `/mcp` has its own rate limit (600 requests per 5 min) and an auth-failure limit (20 per 15 min). It
  rejects requests carrying a foreign `Origin` and limits bodies to 1 MB.
- When the server listens on a loopback address, `/mcp` only accepts the `Host` values `localhost`,
  `127.0.0.1` and `[::1]` with the server's port (protection against DNS rebinding). A reverse proxy in
  front of a loopback-bound instance must forward one of these, for example
  `proxy_set_header Host 127.0.0.1:3000;` in nginx.
- Every tool call is logged by name (`MCP tool <name> ok|error`), never with its arguments.
- Error messages are sanitized: Qobuz tokens or request internals never reach the AI.
- Text that comes from Qobuz (titles, descriptions) or the lyrics providers is data. The server
  instructions tell the AI not to follow instructions found in it; notifications and lyrics are
  length-capped.
