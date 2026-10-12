import { describe, it, expect, vi } from 'vitest';

vi.mock('./services/settings.js', () => ({ settingsService: { get: vi.fn() } }));
vi.mock('./utils/events.js', () => ({ eventBus: { on: vi.fn() }, EVENTS: { SETTINGS: { UPDATED: 'u' } } }));

import { normalizeDownloadQuality } from './config.js';

describe('normalizeDownloadQuality', () => {
    it('accepts only Qobuz format ids and aliases', () => {
        expect(normalizeDownloadQuality(6)).toBe(6);
        expect(normalizeDownloadQuality('7')).toBe(7);
        expect(normalizeDownloadQuality('max')).toBe(27);
        expect(normalizeDownloadQuality('min')).toBe(5);
    });

    it('falls back for anything else', () => {
        expect(normalizeDownloadQuality(999, 6)).toBe(6);
        expect(normalizeDownloadQuality(-1)).toBe(27);
        expect(normalizeDownloadQuality('3', 'bogus')).toBe(27);
        expect(normalizeDownloadQuality('ask', 7)).toBe(7);
    });
});
