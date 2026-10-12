import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SettingsService } from './settings.js';
import { databaseService } from './database/index.js';

import { encryptionService } from '../utils/encryption.js';
import { eventBus, EVENTS } from '../utils/events.js';

// Mock dependencies
vi.mock('./database/index.js', () => ({
    databaseService: {
        getDb: vi.fn().mockReturnValue({
            exec: vi.fn(),
            prepare: vi.fn().mockReturnValue({
                all: vi.fn().mockReturnValue([]),
                run: vi.fn()
            }),
            transaction: vi.fn().mockImplementation((fn) => fn)
        })
    }
}));

vi.mock('../utils/logger.js', () => ({
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        success: vi.fn()
    }
}));

vi.mock('../utils/encryption.js', () => ({
    encryptionService: {
        encryptSync: vi.fn((v) => `enc_${v}`),
        decryptSync: vi.fn((v) => v.replace('enc_', '')),
        isEncryptedSync: vi.fn(() => true),
    }
}));

describe('SettingsService', () => {
    let settings: SettingsService;

    beforeEach(() => {
        vi.clearAllMocks();
        settings = new SettingsService();
    });

    it('should set and get a normal setting', () => {
        const emitSpy = vi.spyOn(eventBus, 'emit');
        settings.set('UI_THEME', 'dark');
        expect(settings.get('UI_THEME')).toBe('dark');
        expect(databaseService.getDb().prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO app_settings'));
        expect(emitSpy).toHaveBeenCalledWith(EVENTS.SETTINGS.UPDATED, { keys: ['UI_THEME'] });
    });

    it('should encrypt sensitive keys', () => {
        settings.set('AI_API_KEY', 'secret-key');
        expect(encryptionService.encryptSync).toHaveBeenCalledWith('secret-key');
        expect(settings.get('AI_API_KEY')).toBe('secret-key');
    });

    it('should encrypt stored Qobuz account bundles', () => {
        settings.set('QOBUZ_ACCOUNTS', '[{"name":"Personal","token":"secret"}]');
        expect(encryptionService.encryptSync).toHaveBeenCalledWith('[{"name":"Personal","token":"secret"}]');
    });

    it('should handle setMany correctly', () => {
        const emitSpy = vi.spyOn(eventBus, 'emit');
        settings.setMany({
            'UI_THEME': 'VAL1',
            'UI_ACCENT': 'VAL2'
        });
        expect(settings.get('UI_THEME')).toBe('VAL1');
        expect(settings.get('UI_ACCENT')).toBe('VAL2');
        expect(emitSpy).toHaveBeenCalledWith(EVENTS.SETTINGS.UPDATED, { keys: ['UI_THEME', 'UI_ACCENT'] });
    });

    it('refuses unknown keys so nothing like QBZ_DESKTOP reaches process.env', () => {
        expect(() => settings.set('QBZ_DESKTOP', '1')).toThrow(/Unknown setting key/);
        expect(() => settings.setMany({ UI_THEME: 'x', QBZ_FFMPEG_PATH: '/tmp/evil' })).toThrow(/Unknown setting key/);
        expect(process.env.QBZ_DESKTOP).toBeUndefined();
        expect(settings.get('UI_THEME')).not.toBe('x');
    });

    it('never mirrors the MCP token hash into process.env', () => {
        settings.set('MCP_TOKEN_HASH', 'a'.repeat(64));
        expect(process.env.MCP_TOKEN_HASH).toBeUndefined();
    });

    it('never mirrors secrets into process.env, but still mirrors plain settings', () => {
        const before = process.env.AI_API_KEY;
        settings.setMany({ AI_API_KEY: 'sk-secret', UI_ACCENT: '#123456' });
        expect(process.env.AI_API_KEY).toBe(before);
        expect(process.env.UI_ACCENT).toBe('#123456');
        delete process.env.UI_ACCENT;
    });

    it('does not import MCP_TOKEN_* from the environment', () => {
        process.env.MCP_TOKEN_HASH = 'b'.repeat(64);
        try {
            expect(settings.get('MCP_TOKEN_HASH')).toBeUndefined();
        } finally {
            delete process.env.MCP_TOKEN_HASH;
        }
    });

    it('accepts the favorites auto-download keys', () => {
        settings.setMany({
            FAVORITES_AUTO_DOWNLOAD: 'true',
            FAVORITES_AUTO_DOWNLOAD_TYPES: 'albums',
            FAVORITES_SYNC_INTERVAL_HOURS: '6'
        });
        expect(settings.get('FAVORITES_AUTO_DOWNLOAD_TYPES')).toBe('albums');
    });

    it('should return many settings at once', () => {
        settings.set('UI_THEME', '1');
        settings.set('UI_ACCENT', '2');
        const many = settings.getMany(['UI_THEME', 'UI_ACCENT', 'UI_LANGUAGE']);
        expect(many).toEqual({
            'UI_THEME': '1',
            'UI_ACCENT': '2',
            'UI_LANGUAGE': undefined
        });
    });

    it('should initialize and load from database', () => {
        vi.mocked(databaseService.getDb().prepare('').all).mockReturnValueOnce([
            { key: 'LOADED', value: 'yes' }
        ]);

        expect(settings.get('LOADED')).toBe('yes');
    });

    describe('environment overrides', () => {
        afterEach(() => {
            delete process.env.DASHBOARD_PASSWORD;
        });

        it('should let an env var override a value already stored in the database', () => {
            process.env.DASHBOARD_PASSWORD = 'from-env';
            vi.mocked(databaseService.getDb().prepare('').all).mockReturnValueOnce([
                { key: 'DASHBOARD_PASSWORD', value: 'enc_from-database' }
            ]);

            expect(settings.get('DASHBOARD_PASSWORD')).toBe('from-env');
            expect(encryptionService.encryptSync).toHaveBeenCalledWith('from-env');
        });

        it('should keep the stored value when the env var is not set', () => {
            vi.mocked(databaseService.getDb().prepare('').all).mockReturnValueOnce([
                { key: 'DASHBOARD_PASSWORD', value: 'enc_from-database' }
            ]);

            expect(settings.get('DASHBOARD_PASSWORD')).toBe('from-database');
            expect(encryptionService.encryptSync).not.toHaveBeenCalledWith('from-database');
        });

        it('should not rewrite the database when env matches the stored value', () => {
            process.env.DASHBOARD_PASSWORD = 'same-value';
            vi.mocked(databaseService.getDb().prepare('').all).mockReturnValueOnce([
                { key: 'DASHBOARD_PASSWORD', value: 'enc_same-value' }
            ]);

            expect(settings.get('DASHBOARD_PASSWORD')).toBe('same-value');
            expect(encryptionService.encryptSync).not.toHaveBeenCalledWith('same-value');
        });
    });
});
