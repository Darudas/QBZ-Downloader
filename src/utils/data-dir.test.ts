import { describe, it, expect } from 'vitest';
import path from 'path';
import { APP_ROOT, resolveDataDir } from './data-dir.js';

const app = path.resolve('/opt/qbz');
const elsewhere = path.resolve('/home/user');
const existsIn = (...files: string[]) => (p: string) => files.map((f) => path.resolve(f)).includes(path.resolve(p));

describe('resolveDataDir', () => {
    it('APP_ROOT is the folder that holds src/ (or dist/)', () => {
        expect(path.basename(path.join(APP_ROOT, 'src'))).toBe('src');
        expect(APP_ROOT).toBe(path.resolve(__dirname, '..', '..'));
    });

    it('uses QBZ_DATA_DIR first, resolved against the cwd', () => {
        expect(resolveDataDir({ env: { QBZ_DATA_DIR: '/srv/qbz' }, cwd: elsewhere, appRoot: app })).toMatchObject({
            dir: path.resolve('/srv/qbz'),
            source: 'env'
        });
        expect(resolveDataDir({ env: { QBZ_DATA_DIR: 'state' }, cwd: elsewhere, appRoot: app }).dir).toBe(
            path.join(elsewhere, 'state')
        );
    });

    it('keeps <cwd>/data in desktop mode (Electron chdirs into its runtime folder)', () => {
        expect(resolveDataDir({ env: { QBZ_DESKTOP: '1' }, cwd: elsewhere, appRoot: app })).toMatchObject({
            dir: path.join(elsewhere, 'data'),
            source: 'desktop'
        });
    });

    it('is independent of the cwd for a normal start', () => {
        const fromApp = resolveDataDir({ env: {}, cwd: app, appRoot: app, exists: () => false });
        const fromElsewhere = resolveDataDir({
            env: {},
            cwd: elsewhere,
            appRoot: app,
            exists: existsIn('/opt/qbz/data/qbz.db')
        });
        expect(fromApp.dir).toBe(path.join(app, 'data'));
        expect(fromElsewhere).toEqual({ dir: path.join(app, 'data'), source: 'app', warnings: [] });
    });

    it('still finds an existing install that was always started from another folder', () => {
        const result = resolveDataDir({
            env: {},
            cwd: elsewhere,
            appRoot: app,
            exists: existsIn('/home/user/data/qbz.db', '/home/user/data/.secret.key')
        });
        expect(result.dir).toBe(path.join(elsewhere, 'data'));
        expect(result.source).toBe('legacy-cwd');
        expect(result.warnings[0]).toContain('QBZ_DATA_DIR');
    });

    it('prefers the app folder when both have data, and says so', () => {
        const result = resolveDataDir({
            env: {},
            cwd: elsewhere,
            appRoot: app,
            exists: existsIn('/opt/qbz/data/qbz.db', '/home/user/data/qbz.db')
        });
        expect(result.dir).toBe(path.join(app, 'data'));
        expect(result.warnings).toHaveLength(1);
    });

    it('starts fresh installs in the app folder', () => {
        expect(resolveDataDir({ env: {}, cwd: elsewhere, appRoot: app, exists: () => false })).toEqual({
            dir: path.join(app, 'data'),
            source: 'app',
            warnings: []
        });
    });
});
