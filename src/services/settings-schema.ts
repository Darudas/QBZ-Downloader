import { z } from 'zod';
import { CONFIG } from '../config.js';
import { FAVORITES_AUTO_DOWNLOAD_TYPES, FAVORITES_SYNC_INTERVAL_RANGE } from '../config-values.js';
import { settingsService, type KnownSettingKey } from './settings.js';
import { ValidationError, type ValidationIssue } from '../utils/errors.js';
import { isSystemRoot } from '../utils/system-root.js';

/**
 * Per-key validation for every setting that may be written from outside
 * (REST `POST /api/settings/update`, config import) plus the much smaller
 * view and allowlist exposed to MCP clients.
 *
 * Every validator takes the raw JSON value and yields the string that is
 * stored. Keys without a validator are not writable through these paths:
 * Qobuz account bundles (own routes), DASHBOARD_HOST (deployment config) and
 * every MCP_* key (own admin routes; the token hash is never writable here).
 */

type SettingValidator = z.ZodType<string>;

/** True when `value` contains an ASCII control character (other than the allowed ones). */
const hasControlChars = (value: string, allowed = ''): boolean => {
    for (const char of value) {
        const code = char.charCodeAt(0);
        if ((code < 0x20 || code === 0x7f) && !allowed.includes(char)) return true;
    }
    return false;
};

const bool = z
    .union([z.boolean(), z.enum(['true', 'false'])], { error: 'Expected true or false' })
    .transform((value) => String(value));

const int = (min: number, max: number) =>
    z
        .union(
            [z.number(), z.string().trim().regex(/^-?\d+$/).transform(Number)],
            { error: 'Expected a whole number' }
        )
        .pipe(
            z
                .number()
                .int('Expected a whole number')
                .min(min, `Must be at least ${min}`)
                .max(max, `Must be at most ${max}`)
        )
        .transform((value) => String(value));

const choice = <const T extends readonly [string, ...string[]]>(values: T) =>
    z.enum(values, { error: `Expected one of: ${values.join(', ')}` });

const text = (max: number) =>
    z
        .string()
        .trim()
        .max(max, `Must be at most ${max} characters`)
        .refine((value) => !hasControlChars(value), 'Must not contain control characters');

/** API keys, tokens and ids: a single word without whitespace. */
const credential = (max: number) =>
    z
        .string()
        .trim()
        .min(1, 'Must not be empty')
        .max(max, `Must be at most ${max} characters`)
        .regex(/^\S+$/, 'Must not contain whitespace');

const numericId = z.string().trim().regex(/^\d{1,20}$/, 'Must be numeric');

/**
 * A directory the app writes into. The system volume root would make every
 * file of the system "managed"; other drive roots and NAS shares are fine.
 */
const directory = text(1024)
    .refine((value) => value.length > 0, 'Must not be empty')
    .refine((value) => !isSystemRoot(value), 'Must not be the root of the system drive');

const isDotSegment = (segment: string): boolean => /^\.+$/.test(segment.trim());

/**
 * Folder/file naming templates. They are rendered below the download root,
 * so they must stay relative and must not climb out of it. Rendering also
 * neutralises these (MetadataProcessor); rejecting them here gives the user an
 * error instead of a silently different folder.
 */
const template = (kind: 'folder' | 'file') => {
    const base = text(255)
        .refine((value) => value.length > 0, 'Must not be empty')
        .refine(
            (value) => !/^([/\\]|[A-Za-z]:)/.test(value),
            'Must be a relative template (no leading slash or drive letter)'
        )
        .refine(
            (value) => !value.split(/[/\\]/).some(isDotSegment),
            'Must not contain "." or ".." path segments'
        );
    return kind === 'file'
        ? base.refine((value) => !/[/\\]/.test(value), 'Must not contain path separators')
        : base;
};

const httpUrl = text(2048).refine((value) => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}, 'Must be an http(s) URL');

const QUALITY_CODES = ['5', '6', '7', '27'] as const;

const qualityCode = z
    .union([z.number(), z.string().trim()])
    .transform((value) => String(value))
    .pipe(choice(QUALITY_CODES));

const defaultQuality = z
    .union([z.number(), z.string().trim().toLowerCase()])
    .transform((value) => String(value))
    .pipe(choice([...QUALITY_CODES, 'ask', 'min', 'max']));

const favoritesTypes = z
    .union([
        z.array(z.string()),
        z.string().transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
    ])
    .pipe(z.array(choice(FAVORITES_AUTO_DOWNLOAD_TYPES)).min(1, 'Select at least one type'))
    .transform((types) => Array.from(new Set(types)).join(','));

export const SETTING_VALIDATORS = {
    QOBUZ_APP_ID: numericId,
    QOBUZ_APP_SECRET: credential(256),
    QOBUZ_USER_AUTH_TOKEN: credential(2048),
    QOBUZ_USER_ID: numericId,
    SPOTIFY_CLIENT_ID: credential(256),
    SPOTIFY_CLIENT_SECRET: credential(256),
    DOWNLOADS_PATH: directory,
    EXPORT_PATH: directory,
    DEFAULT_QUALITY: defaultQuality,
    STREAMING_QUALITY: qualityCode,
    MAX_CONCURRENCY: int(1, 20),
    RETRY_ATTEMPTS: int(0, 20),
    RETRY_DELAY: int(0, 600_000),
    BANDWIDTH_LIMIT: int(0, 10_000_000),
    FOLDER_TEMPLATE: template('folder'),
    FILE_TEMPLATE: template('file'),
    EMBED_COVER_ART: bool,
    SAVE_COVER_FILE: bool,
    COVER_SIZE: choice(['small', 'large', 'max']),
    DOWNLOAD_LYRICS: bool,
    EMBED_LYRICS: bool,
    SAVE_LRC_FILE: bool,
    LYRICS_TYPE: choice(['synced', 'plain', 'both']),
    DASHBOARD_PORT: int(1, 65535),
    DASHBOARD_PASSWORD: text(256),
    AI_REPAIR_ENABLED: bool,
    AI_PROVIDER: choice(['none', 'gemini', 'openai']),
    AI_API_KEY: credential(512),
    AI_MODEL: z.string().trim().regex(/^[\w.:/-]{1,100}$/, 'Invalid model name'),
    MEDIA_SERVER_ENABLED: bool,
    MEDIA_SERVER_TYPE: choice(['none', 'plex', 'jellyfin', 'webhook']),
    MEDIA_SERVER_URL: httpUrl,
    MEDIA_SERVER_TOKEN: credential(512),
    MEDIA_SERVER_LIBRARY_ID: text(128),
    EXPORT_ENABLED: bool,
    EXPORT_FORMAT: choice(['mp3', 'aac', 'opus']),
    EXPORT_BITRATE: z.string().trim().regex(/^\d{2,3}k$/, 'Expected a bitrate such as 320k'),
    EXPORT_KEEP_ORIGINAL: bool,
    UI_BATCH_STAGING_URLS: z
        .string()
        .max(100_000, 'Too long')
        .refine(
            (value) => !hasControlChars(value, '\r\n'),
            'Must not contain control characters'
        ),
    UI_LAST_TAB: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Invalid tab'),
    UI_ACTIVE_THEME_ID: z.string().trim().regex(/^[A-Za-z0-9_-]{0,100}$/, 'Invalid theme id'),
    UI_LANGUAGE: z.string().trim().regex(/^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/, 'Invalid language'),
    UI_THEME: choice(['dark', 'light']),
    UI_ACCENT: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/, 'Expected a hex color'),
    FAVORITES_AUTO_DOWNLOAD: bool,
    FAVORITES_AUTO_DOWNLOAD_TYPES: favoritesTypes,
    FAVORITES_SYNC_INTERVAL_HOURS: int(FAVORITES_SYNC_INTERVAL_RANGE.min, FAVORITES_SYNC_INTERVAL_RANGE.max)
} satisfies Partial<Record<KnownSettingKey, SettingValidator>>;

export type WritableSettingKey = keyof typeof SETTING_VALIDATORS;

const WRITABLE_KEYS = new Set<string>(Object.keys(SETTING_VALIDATORS));

/** Keys an empty string may clear. For every other key an empty value means "unchanged". */
export const CLEARABLE_SETTING_KEYS: ReadonlySet<string> = new Set<WritableSettingKey>([
    'DASHBOARD_PASSWORD',
    'UI_BATCH_STAGING_URLS',
    'UI_ACTIVE_THEME_ID'
]);

/** Field names the dashboard sends that are not just the lower-cased setting key. */
const FIELD_ALIASES: Readonly<Record<string, WritableSettingKey>> = {
    app_id: 'QOBUZ_APP_ID',
    app_secret: 'QOBUZ_APP_SECRET',
    user_auth_token: 'QOBUZ_USER_AUTH_TOKEN',
    token: 'QOBUZ_USER_AUTH_TOKEN',
    user_id: 'QOBUZ_USER_ID'
};

/** Map a request field (`downloads_path`, `DOWNLOADS_PATH`, `app_id`) to a writable key. */
export function resolveSettingField(field: string): WritableSettingKey | null {
    const lower = field.toLowerCase();
    const alias = FIELD_ALIASES[lower];
    if (alias) return alias;
    const upper = field.toUpperCase();
    return WRITABLE_KEYS.has(upper) ? (upper as WritableSettingKey) : null;
}

/** Validate one value for `key`. Returns the string to store, or the first problem. */
export function validateSettingValue(
    key: string,
    value: unknown
): { ok: true; value: string } | { ok: false; message: string } {
    if (!WRITABLE_KEYS.has(key)) return { ok: false, message: 'Unknown or read-only setting' };
    const result = (SETTING_VALIDATORS as Record<string, SettingValidator>)[key]!.safeParse(value);
    if (result.success) return { ok: true, value: result.data };
    return { ok: false, message: result.error.issues[0]?.message || 'Invalid value' };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

function throwIfIssues(issues: ValidationIssue[]): void {
    if (issues.length === 0) return;
    const summary = issues
        .slice(0, 5)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ');
    throw new ValidationError(`Invalid settings: ${summary}`, issues.slice(0, 20));
}

/**
 * Parse the body of `POST /api/settings/update`. Fields may be sent at the top
 * level or nested under `settings` (SettingsContext), by lower-case field name
 * or setting key. Unknown and read-only fields are rejected; null/undefined
 * values and empty strings for non-clearable keys are ignored, because the
 * settings form sends blank inputs for secrets it does not want to change.
 *
 * @throws ValidationError listing every invalid field (values are never echoed).
 */
export function parseSettingsUpdate(body: unknown): Partial<Record<WritableSettingKey, string>> {
    if (!isPlainObject(body)) throw new ValidationError('Request body must be a JSON object');
    const { settings: nested, ...topLevel } = body;
    if (nested !== undefined && nested !== null && !isPlainObject(nested)) {
        throw new ValidationError('"settings" must be an object');
    }

    const fields: Record<string, unknown> = { ...topLevel, ...(nested ?? {}) };
    const updates: Partial<Record<WritableSettingKey, string>> = {};
    const issues: ValidationIssue[] = [];

    for (const [field, raw] of Object.entries(fields)) {
        const key = resolveSettingField(field);
        if (!key) {
            issues.push({ path: field, message: 'Unknown or read-only setting' });
            continue;
        }
        if (raw === undefined || raw === null) continue;
        if (typeof raw === 'string' && raw.trim() === '' && !CLEARABLE_SETTING_KEYS.has(key)) continue;

        const result = validateSettingValue(key, raw);
        if (result.ok) updates[key] = result.value;
        else issues.push({ path: field, message: result.message });
    }

    throwIfIssues(issues);
    return updates;
}

/**
 * Validate settings coming from an encrypted config backup. Unlike the REST
 * route, invalid values are skipped (and reported) rather than failing the
 * whole import, so an old backup still restores everything that is valid.
 * Keys without a validator (accounts, MCP state, DASHBOARD_HOST) pass through
 * unchanged; the caller has already reduced them to KNOWN_SETTING_KEYS.
 */
export function filterImportedSettings(settings: Record<string, string>): {
    valid: Record<string, string>;
    skipped: string[];
} {
    const valid: Record<string, string> = {};
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
        if (!WRITABLE_KEYS.has(key) || value === '') {
            valid[key] = value;
            continue;
        }
        const result = validateSettingValue(key, value);
        if (result.ok) valid[key] = result.value;
        else skipped.push(key);
    }
    return { valid, skipped };
}

/* ------------------------------------------------------------------ */
/* MCP: safe read view and write allowlist                             */
/* ------------------------------------------------------------------ */

/**
 * What an MCP client may read: download behaviour only. Deliberately absent:
 * credentials and every token, the dashboard password, user/account ids,
 * download/export paths, folder/file templates, the media server (URL, token,
 * library id), the AI provider/key/model, the dashboard port/host, the MCP
 * configuration itself and UI state.
 */
export function getSafeSettings() {
    return {
        default_quality: CONFIG.quality.default,
        streaming_quality: CONFIG.quality.streaming,
        max_concurrency: CONFIG.download.concurrent,
        retry_attempts: CONFIG.download.retryAttempts,
        retry_delay_ms: CONFIG.download.retryDelay,
        bandwidth_limit_kbps: CONFIG.download.bandwidthLimit,
        embed_cover_art: CONFIG.metadata.embedCover,
        save_cover_file: CONFIG.metadata.saveCoverFile,
        cover_size: CONFIG.metadata.coverSize,
        download_lyrics: CONFIG.metadata.downloadLyrics,
        embed_lyrics: CONFIG.metadata.embedLyrics,
        save_lrc_file: CONFIG.metadata.saveLrcFile,
        lyrics_type: CONFIG.metadata.lyricsType,
        export_enabled: CONFIG.export.enabled,
        export_format: CONFIG.export.format,
        export_bitrate: CONFIG.export.bitrate,
        favorites_auto_download: CONFIG.favorites.autoDownload,
        favorites_auto_download_types: CONFIG.favorites.types,
        favorites_sync_interval_hours: CONFIG.favorites.intervalHours
    };
}

export type SafeSettings = ReturnType<typeof getSafeSettings>;

/**
 * What an MCP client may change. Each entry only alters how future downloads
 * are tagged, how fast the queue runs, or when favorites are synced; none
 * touches a path, a network endpoint, a credential or access control.
 * Concurrency and retries are capped below the REST limits.
 */
export const SAFE_SETTINGS_INPUT_SHAPE = {
    default_quality: z
        .union([z.literal(5), z.literal(6), z.literal(7), z.literal(27), z.literal('max'), z.literal('min')])
        .optional()
        .describe('Default download quality: 5=MP3 320, 6=FLAC 16/44.1, 7=FLAC 24/<=96kHz, 27=FLAC 24/<=192kHz'),
    streaming_quality: z
        .union([z.literal(5), z.literal(6), z.literal(7), z.literal(27)])
        .optional()
        .describe('Quality used for in-app playback'),
    max_concurrency: z.number().int().min(1).max(10).optional().describe('Parallel downloads (1-10)'),
    retry_attempts: z.number().int().min(0).max(10).optional().describe('Retries per failed download (0-10)'),
    bandwidth_limit_kbps: z
        .number()
        .int()
        .min(0)
        .max(10_000_000)
        .optional()
        .describe('Per-stream bandwidth limit in KB/s, 0 = unlimited'),
    embed_cover_art: z.boolean().optional().describe('Embed the cover into audio files'),
    save_cover_file: z.boolean().optional().describe('Save cover.jpg into the album folder'),
    cover_size: z.enum(['small', 'large', 'max']).optional().describe('Cover size to download'),
    download_lyrics: z.boolean().optional().describe('Fetch lyrics for downloaded tracks'),
    embed_lyrics: z.boolean().optional().describe('Embed lyrics into audio files'),
    save_lrc_file: z.boolean().optional().describe('Save synced lyrics as .lrc next to the file'),
    lyrics_type: z.enum(['synced', 'plain', 'both']).optional().describe('Which lyrics to keep'),
    favorites_auto_download: z.boolean().optional().describe('Download new Qobuz favorites automatically'),
    favorites_auto_download_types: z
        .array(z.enum(FAVORITES_AUTO_DOWNLOAD_TYPES))
        .min(1)
        .max(2)
        .optional()
        .describe('Favorite types to auto-download'),
    favorites_sync_interval_hours: z
        .number()
        .int()
        .min(FAVORITES_SYNC_INTERVAL_RANGE.min)
        .max(FAVORITES_SYNC_INTERVAL_RANGE.max)
        .optional()
        .describe('Hours between favorites syncs (1-168)')
};

export const safeSettingsUpdateSchema = z.object(SAFE_SETTINGS_INPUT_SHAPE).strict();
export type SafeSettingsUpdate = z.input<typeof safeSettingsUpdateSchema>;

const SAFE_FIELD_KEYS: Record<keyof typeof SAFE_SETTINGS_INPUT_SHAPE, WritableSettingKey> = {
    default_quality: 'DEFAULT_QUALITY',
    streaming_quality: 'STREAMING_QUALITY',
    max_concurrency: 'MAX_CONCURRENCY',
    retry_attempts: 'RETRY_ATTEMPTS',
    bandwidth_limit_kbps: 'BANDWIDTH_LIMIT',
    embed_cover_art: 'EMBED_COVER_ART',
    save_cover_file: 'SAVE_COVER_FILE',
    cover_size: 'COVER_SIZE',
    download_lyrics: 'DOWNLOAD_LYRICS',
    embed_lyrics: 'EMBED_LYRICS',
    save_lrc_file: 'SAVE_LRC_FILE',
    lyrics_type: 'LYRICS_TYPE',
    favorites_auto_download: 'FAVORITES_AUTO_DOWNLOAD',
    favorites_auto_download_types: 'FAVORITES_AUTO_DOWNLOAD_TYPES',
    favorites_sync_interval_hours: 'FAVORITES_SYNC_INTERVAL_HOURS'
};

/**
 * Apply an MCP settings change. Only the allowlisted fields are accepted
 * (unknown fields are an error, not silently dropped); each value is
 * re-validated with the REST validator before it is stored.
 */
export function applySafeSettings(input: unknown): { updated: string[]; settings: SafeSettings } {
    const parsed = safeSettingsUpdateSchema.safeParse(input ?? {});
    if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'Invalid settings');

    const updates: Record<string, string> = {};
    const updated: string[] = [];
    const issues: ValidationIssue[] = [];
    for (const [field, value] of Object.entries(parsed.data)) {
        if (value === undefined) continue;
        const key = SAFE_FIELD_KEYS[field as keyof typeof SAFE_FIELD_KEYS];
        const result = validateSettingValue(key, value);
        if (result.ok) {
            updates[key] = result.value;
            updated.push(field);
        } else {
            issues.push({ path: field, message: result.message });
        }
    }
    throwIfIssues(issues);
    if (updated.length === 0) throw new ValidationError('No settings to change were given');

    settingsService.setMany(updates);
    return { updated, settings: getSafeSettings() };
}
