import { describe, it, expect } from 'vitest';
import { isSystemRoot } from './system-root.js';

describe('isSystemRoot', () => {
    it('flags only / on POSIX', () => {
        expect(isSystemRoot('/', 'linux')).toBe(true);
        expect(isSystemRoot('/music', 'linux')).toBe(false);
        expect(isSystemRoot('/mnt/nas', 'darwin')).toBe(false);
    });

    it('flags only the system drive on Windows', () => {
        expect(isSystemRoot('C:\\', 'win32', 'C:')).toBe(true);
        expect(isSystemRoot('c:\\', 'win32', 'C:')).toBe(true);
        expect(isSystemRoot('D:\\', 'win32', 'C:')).toBe(false);
        expect(isSystemRoot('D:\\', 'win32', 'D:')).toBe(true);
        expect(isSystemRoot('C:\\Music', 'win32', 'C:')).toBe(false);
    });

    it('allows NAS share roots', () => {
        expect(isSystemRoot('\\\\nas\\music\\', 'win32', 'C:')).toBe(false);
        expect(isSystemRoot('\\\\nas\\music', 'win32', 'C:')).toBe(false);
    });
});
