import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ dir: '' }));
vi.mock('./data-dir.js', () => ({ getDataDir: () => h.dir }));

import { encryptionService, getEncryptionKeyPath } from './encryption.js';

describe('encryptionService key location', () => {
    let cwdBefore: string;
    let otherCwd: string;

    beforeAll(() => {
        h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-key-'));
        otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-cwd-'));
        cwdBefore = process.cwd();
        process.chdir(otherCwd);
    });

    afterAll(() => {
        process.chdir(cwdBefore);
        fs.rmSync(h.dir, { recursive: true, force: true });
        fs.rmSync(otherCwd, { recursive: true, force: true });
    });

    it('keeps the key in the data directory, not in the current directory', () => {
        const encrypted = encryptionService.encryptSync('secret-token');
        expect(encryptionService.isEncryptedSync(encrypted)).toBe(true);
        expect(getEncryptionKeyPath()).toBe(path.join(h.dir, '.secret.key'));
        expect(fs.existsSync(path.join(h.dir, '.secret.key'))).toBe(true);
        expect(fs.existsSync(path.join(otherCwd, 'data'))).toBe(false);
        expect(encryptionService.decryptSync(encrypted)).toBe('secret-token');
    });

    it('reports a key mismatch instead of failing silently (once)', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const foreign = `${'0'.repeat(32)}:${'ab'.repeat(16)}`;
        expect(encryptionService.decryptSync(foreign)).toBe(foreign);
        expect(encryptionService.decryptSync(foreign)).toBe(foreign);
        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]?.[0])).toContain(path.join(h.dir, '.secret.key'));
        // Plain values that merely contain a colon are not "encrypted".
        expect(encryptionService.decryptSync('a:b')).toBe('a:b');
        expect(error).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });
});
