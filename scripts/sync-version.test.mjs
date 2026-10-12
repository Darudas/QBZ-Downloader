import { describe, it, expect } from 'vitest';
import { updateChangelog } from './sync-version.js';

const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '- new thing',
    '',
    '## [5.6.3] - 2026-10-01',
    '',
    '- old fix',
    ''
].join('\n');

/**
 * The old step rewrote the first `## [x.y.z]` heading, which is the previous
 * release once an [Unreleased] section exists: a bump to 5.7.0 relabelled the
 * 5.6.3 notes as 5.7.0 and left [Unreleased] behind.
 */
describe('sync-version updateChangelog', () => {
    it('turns [Unreleased] into the new release and keeps the previous one', () => {
        const { text, action } = updateChangelog(changelog, '5.7.0', '2026-10-12');
        expect(action).toBe('released');
        expect(text).toContain('## [5.7.0] - 2026-10-12\n\n### Added\n- new thing');
        expect(text).toContain('## [5.6.3] - 2026-10-01');
        expect(text).not.toContain('[Unreleased]');
    });

    it('is a no-op when the version already has a heading (every build:full runs it)', () => {
        expect(updateChangelog(changelog, '5.6.3')).toEqual({ text: changelog, action: 'unchanged' });
        const released = updateChangelog(changelog, '5.7.0', '2026-10-12').text;
        expect(updateChangelog(released, '5.7.0', '2026-10-13')).toEqual({ text: released, action: 'unchanged' });
    });

    it('never renames an older release when there is no [Unreleased] section', () => {
        const noUnreleased = changelog.replace('## [Unreleased]\n\n### Added\n- new thing\n\n', '');
        expect(updateChangelog(noUnreleased, '5.7.0')).toEqual({ text: noUnreleased, action: 'missing' });
    });

    it('treats version dots literally', () => {
        const text = '## [Unreleased]\n\n## [5x6y3] - 2026-01-01\n';
        expect(updateChangelog(text, '5.6.3', '2026-02-02').action).toBe('released');
    });

    it('handles pre-release versions', () => {
        const { text } = updateChangelog(changelog, '6.0.0-beta.1', '2026-10-12');
        expect(text).toContain('## [6.0.0-beta.1] - 2026-10-12');
    });
});
