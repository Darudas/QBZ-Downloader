import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock('./settings.js', async () => {
    const { eventBus, EVENTS } = await import('../utils/events.js');
    return {
        settingsService: {
            get: (key: string) => state.settings.get(key),
            setMany: vi.fn((values: Record<string, string>) => {
                for (const [key, value] of Object.entries(values)) state.settings.set(key, value);
                eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: Object.keys(values) });
            })
        }
    };
});

import {
    applySafeSettings,
    filterImportedSettings,
    getSafeSettings,
    parseSettingsUpdate,
    resolveSettingField,
    validateSettingValue
} from './settings-schema.js';
import { settingsService } from './settings.js';
import { eventBus, EVENTS } from '../utils/events.js';
import { ValidationError } from '../utils/errors.js';

beforeEach(() => {
    state.settings.clear();
    vi.mocked(settingsService.setMany).mockClear();
    eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: [] });
});

describe('resolveSettingField', () => {
    it('maps dashboard field names, aliases and upper-case keys', () => {
        expect(resolveSettingField('downloads_path')).toBe('DOWNLOADS_PATH');
        expect(resolveSettingField('token')).toBe('QOBUZ_USER_AUTH_TOKEN');
        expect(resolveSettingField('app_id')).toBe('QOBUZ_APP_ID');
        expect(resolveSettingField('UI_THEME')).toBe('UI_THEME');
    });

    it('does not resolve read-only keys', () => {
        for (const field of ['mcp_token_hash', 'MCP_ENABLED', 'dashboard_host', 'qobuz_accounts', 'settings']) {
            expect(resolveSettingField(field)).toBeNull();
        }
    });
});

describe('validateSettingValue', () => {
    it.each([
        ['DEFAULT_QUALITY', 27, '27'],
        ['DEFAULT_QUALITY', 'MAX', 'max'],
        ['DEFAULT_QUALITY', 'ask', 'ask'],
        ['STREAMING_QUALITY', '6', '6'],
        ['MAX_CONCURRENCY', '4', '4'],
        ['EMBED_COVER_ART', true, 'true'],
        ['EMBED_COVER_ART', 'false', 'false'],
        ['FOLDER_TEMPLATE', '{albumArtist}/{album} [{year}]', '{albumArtist}/{album} [{year}]'],
        ['FOLDER_TEMPLATE', '{album}...', '{album}...'],
        ['FILE_TEMPLATE', '{track_number}. {title}', '{track_number}. {title}'],
        ['FAVORITES_AUTO_DOWNLOAD_TYPES', 'tracks, albums,tracks', 'tracks,albums'],
        ['FAVORITES_AUTO_DOWNLOAD_TYPES', ['albums'], 'albums'],
        ['FAVORITES_SYNC_INTERVAL_HOURS', 24, '24'],
        ['MEDIA_SERVER_URL', 'http://plex.local:32400', 'http://plex.local:32400'],
        ['UI_BATCH_STAGING_URLS', 'https://a\nhttps://b', 'https://a\nhttps://b'],
        ['DASHBOARD_PASSWORD', '', '']
    ])('%s accepts %o', (key, value, stored) => {
        expect(validateSettingValue(key, value)).toEqual({ ok: true, value: stored });
    });

    it.each([
        ['DEFAULT_QUALITY', 8],
        ['STREAMING_QUALITY', 'max'],
        ['MAX_CONCURRENCY', 2.5],
        ['MAX_CONCURRENCY', '1e3'],
        ['RETRY_ATTEMPTS', -1],
        ['EMBED_COVER_ART', 1],
        ['FOLDER_TEMPLATE', '..'],
        ['FOLDER_TEMPLATE', '{artist}/../../x'],
        ['FOLDER_TEMPLATE', '{artist}\\..\\x'],
        ['FOLDER_TEMPLATE', '\\\\server\\share\\{album}'],
        ['FOLDER_TEMPLATE', 'D:{album}'],
        ['FOLDER_TEMPLATE', '{album}\u0000'],
        ['FILE_TEMPLATE', '../{title}'],
        ['FILE_TEMPLATE', '..'],
        ['DOWNLOADS_PATH', '/'],
        ['EXPORT_PATH', '/'],
        ['QOBUZ_USER_ID', 'abc'],
        ['QOBUZ_USER_AUTH_TOKEN', 'two words'],
        ['FAVORITES_AUTO_DOWNLOAD_TYPES', 'artists'],
        ['FAVORITES_AUTO_DOWNLOAD_TYPES', ''],
        ['FAVORITES_SYNC_INTERVAL_HOURS', 0],
        ['MEDIA_SERVER_URL', 'javascript:alert(1)'],
        ['UI_LAST_TAB', '../settings'],
        ['MCP_TOKEN_HASH', 'f'.repeat(64)],
        ['DASHBOARD_HOST', '0.0.0.0']
    ])('%s rejects %o', (key, value) => {
        expect(validateSettingValue(key, value).ok).toBe(false);
    });
});

describe('parseSettingsUpdate', () => {
    it('merges top-level and nested fields and skips blank non-clearable values', () => {
        expect(
            parseSettingsUpdate({
                app_id: '',
                ai_api_key: '   ',
                max_concurrency: null,
                settings: { ui_theme: 'light', ui_active_theme_id: '' }
            })
        ).toEqual({ UI_THEME: 'light', UI_ACTIVE_THEME_ID: '' });
    });

    it('reports every invalid field at once', () => {
        try {
            parseSettingsUpdate({ cover_size: 'huge', nope: 1, max_concurrency: 99 });
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(ValidationError);
            expect((error as ValidationError).issues.map((i) => i.path).sort()).toEqual([
                'cover_size',
                'max_concurrency',
                'nope'
            ]);
        }
    });

    it('rejects non-object bodies', () => {
        expect(() => parseSettingsUpdate([])).toThrow(ValidationError);
        expect(() => parseSettingsUpdate({ settings: 'x' })).toThrow(ValidationError);
    });
});

describe('filterImportedSettings', () => {
    it('keeps valid and unvalidated keys and skips invalid values', () => {
        expect(
            filterImportedSettings({
                UI_THEME: 'dark',
                FOLDER_TEMPLATE: '../x',
                QOBUZ_ACCOUNTS: '[]',
                EXPORT_PATH: ''
            })
        ).toEqual({
            valid: { UI_THEME: 'dark', QOBUZ_ACCOUNTS: '[]', EXPORT_PATH: '' },
            skipped: ['FOLDER_TEMPLATE']
        });
    });
});

describe('MCP safe settings', () => {
    it('never exposes secrets, paths, templates, URLs or ids', () => {
        for (const [key, value] of Object.entries({
            QOBUZ_APP_ID: '123',
            QOBUZ_APP_SECRET: 'appsecret-xyz',
            QOBUZ_USER_AUTH_TOKEN: 'usertoken-xyz',
            QOBUZ_USER_ID: '98765',
            DASHBOARD_PASSWORD: 'dash-pass-xyz',
            DOWNLOADS_PATH: '/secret/music',
            EXPORT_PATH: '/secret/export',
            FOLDER_TEMPLATE: '{secret-folder}',
            FILE_TEMPLATE: '{secret-file}',
            MEDIA_SERVER_URL: 'http://media.secret',
            MEDIA_SERVER_TOKEN: 'media-token-xyz',
            AI_API_KEY: 'ai-key-xyz',
            AI_MODEL: 'secret-model',
            MCP_TOKEN_HASH: 'f'.repeat(64)
        })) {
            state.settings.set(key, value);
        }
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: [] });

        const json = JSON.stringify(getSafeSettings());
        for (const needle of ['xyz', 'secret', '98765', 'ffff', 'http']) {
            expect(json).not.toContain(needle);
        }
        expect(getSafeSettings()).toMatchObject({ default_quality: 27, embed_cover_art: true });
    });

    it('applies allowlisted fields and returns the new view', () => {
        const result = applySafeSettings({
            default_quality: 7,
            embed_cover_art: false,
            favorites_auto_download_types: ['tracks'],
            favorites_sync_interval_hours: 12
        });

        expect(settingsService.setMany).toHaveBeenCalledWith({
            DEFAULT_QUALITY: '7',
            EMBED_COVER_ART: 'false',
            FAVORITES_AUTO_DOWNLOAD_TYPES: 'tracks',
            FAVORITES_SYNC_INTERVAL_HOURS: '12'
        });
        expect(result.updated).toEqual([
            'default_quality',
            'embed_cover_art',
            'favorites_auto_download_types',
            'favorites_sync_interval_hours'
        ]);
        expect(result.settings).toMatchObject({
            default_quality: 7,
            embed_cover_art: false,
            favorites_auto_download_types: ['tracks'],
            favorites_sync_interval_hours: 12
        });
    });

    it.each([
        [{ downloads_path: '/tmp' }],
        [{ folder_template: '{album}' }],
        [{ dashboard_password: '' }],
        [{ max_concurrency: 50 }],
        [{ default_quality: 'ask' }],
        [{}]
    ])('refuses %o', (input) => {
        expect(() => applySafeSettings(input)).toThrow(ValidationError);
        expect(settingsService.setMany).not.toHaveBeenCalled();
    });
});
