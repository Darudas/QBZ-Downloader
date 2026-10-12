import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

/**
 * Release heading for `version` in a Keep-a-Changelog file.
 *
 * - The version already has a heading: nothing changes (sync-version runs on
 *   every `build:full`, so this must be idempotent).
 * - Otherwise the `## [Unreleased]` section becomes `## [version] - date`.
 * - Without an Unreleased section nothing is renamed: the old code renamed
 *   the first versioned heading, i.e. the previous release, and left
 *   [Unreleased] in place.
 *
 * Returns the new text and what happened.
 */
export function updateChangelog(text, version, date = new Date().toISOString().slice(0, 10)) {
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^## \\[${escaped}\\]`, 'm').test(text)) {
        return { text, action: 'unchanged' };
    }
    const unreleased = /^## \[Unreleased\][^\n]*$/im;
    if (unreleased.test(text)) {
        return { text: text.replace(unreleased, `## [${version}] - ${date}`), action: 'released' };
    }
    return { text, action: 'missing' };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main();
}

function main() {
    const packagePath = 'package.json';
    const manifestPath = 'client/public/manifest.json';
    const readmePath = 'README.md';
    const changelogPath = 'CHANGELOG.md';

    const { version } = JSON.parse(readFileSync(packagePath, 'utf-8'));

    const clientPackagePath = 'client/package.json';

    // 1. Update manifest.json
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        manifest.version = version;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
        console.log(`✅ Updated ${manifestPath} to v${version}`);
    } catch (e) {
        console.error(`Failed to update ${manifestPath}:`, e.message);
    }

    // 1.5 Update client/package.json
    try {
        const clientPackage = JSON.parse(readFileSync(clientPackagePath, 'utf-8'));
        clientPackage.version = version;
        writeFileSync(clientPackagePath, JSON.stringify(clientPackage, null, 2) + '\n');
        console.log(`✅ Updated ${clientPackagePath} to v${version}`);
    } catch (e) {
        console.error(`Failed to update ${clientPackagePath}:`, e.message);
    }

    // 1.6 Update lockfiles
    for (const lockPath of ['package-lock.json', 'client/package-lock.json']) {
        try {
            const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
            lock.version = version;
            if (lock.packages?.['']) lock.packages[''].version = version;
            writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
            console.log(`✅ Updated ${lockPath} to v${version}`);
        } catch (e) {
            console.error(`Failed to update ${lockPath}:`, e.message);
        }
    }

    // 2. Update README.md badge
    try {
        let readme = readFileSync(readmePath, 'utf-8');
        // Match the shields.io version badge, keeping the color code
        readme = readme.replace(
            /https:\/\/img\.shields\.io\/badge\/version-\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?-([A-Fa-f0-9]+)/g,
            `https://img.shields.io/badge/version-${version}-$2`
        );
        // Match the highlight text (e.g. "> **🚀 v5.2.0:")
        readme = readme.replace(
            /> \*\*🚀 v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?/g,
            `> **🚀 v${version}`
        );
        writeFileSync(readmePath, readme);
        console.log(`✅ Updated ${readmePath} to v${version}`);
    } catch (e) {
        console.error(`Failed to update ${readmePath}:`, e.message);
    }

    // 3. Turn the CHANGELOG's [Unreleased] section into this version's release
    try {
        const { text, action } = updateChangelog(readFileSync(changelogPath, 'utf-8'), version);
        if (action === 'released') {
            writeFileSync(changelogPath, text);
            console.log(`✅ Renamed [Unreleased] in ${changelogPath} to v${version}`);
        } else if (action === 'unchanged') {
            console.log(`✅ ${changelogPath} already has a v${version} entry`);
        } else {
            console.warn(`⚠️ ${changelogPath} has no [Unreleased] section and no v${version} entry; left unchanged`);
        }
    } catch (e) {
        console.error(`Failed to update ${changelogPath}:`, e.message);
    }
}
