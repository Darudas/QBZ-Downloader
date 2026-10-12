import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import NodeID3 from 'node-id3';
import { ValidationError } from '../utils/errors.js';

/**
 * In-place tag patching for single fields.
 *
 * MetadataService.writeMetadata rebuilds a file's tags from a full Qobuz
 * metadata object: every tag it does not know is dropped and the cover is
 * removed unless one is passed in. An edit of a few fields must not do that,
 * so this module only touches the named fields:
 *
 * - FLAC: the VORBIS_COMMENT block is rewritten with the named keys
 *   replaced; all other comments, the PICTURE block and the audio frames are
 *   copied byte for byte.
 * - MP3: node-id3's `update` merges the named frames into the existing tag,
 *   keeping APIC (cover) and every other frame.
 *
 * Both write a temporary file next to the original and rename it over the
 * original, so an interrupted write never leaves a half-written track.
 */

export type EditableTagField =
    | 'title'
    | 'artist'
    | 'album'
    | 'albumArtist'
    | 'genre'
    | 'year'
    | 'trackNumber'
    | 'totalTracks'
    | 'discNumber'
    | 'totalDiscs'
    | 'composer'
    | 'label'
    | 'isrc'
    | 'copyright'
    | 'comment';

/** A string sets the field, an empty string removes it. */
export type TagChanges = Partial<Record<EditableTagField, string>>;

export const EDITABLE_TAG_FORMATS = ['.flac', '.mp3'] as const;

const VORBIS_KEYS: Record<EditableTagField, string[]> = {
    title: ['TITLE'],
    artist: ['ARTIST'],
    album: ['ALBUM'],
    albumArtist: ['ALBUMARTIST'],
    genre: ['GENRE'],
    year: ['DATE', 'YEAR'],
    trackNumber: ['TRACKNUMBER'],
    totalTracks: ['TRACKTOTAL', 'TOTALTRACKS'],
    discNumber: ['DISCNUMBER'],
    totalDiscs: ['DISCTOTAL', 'TOTALDISCS'],
    composer: ['COMPOSER'],
    label: ['LABEL', 'PUBLISHER'],
    isrc: ['ISRC'],
    copyright: ['COPYRIGHT'],
    comment: ['COMMENT']
};

const tempPathFor = (filePath: string): string =>
    // Ends in .tmp so the library scanner never indexes it.
    `${filePath}.qbz-edit-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;

function replaceAtomically(filePath: string, data: Buffer): void {
    const tmp = tempPathFor(filePath);
    fs.writeFileSync(tmp, data);
    try {
        fs.renameSync(tmp, filePath);
    } catch (error) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        throw error;
    }
}

/* ------------------------------------------------------------------ */
/* FLAC                                                                 */
/* ------------------------------------------------------------------ */

const FLAC_BLOCK_STREAMINFO = 0;
const FLAC_BLOCK_VORBIS_COMMENT = 4;
const MAX_FLAC_BLOCK = 0xffffff;

interface FlacBlock {
    type: number;
    start: number;
    end: number;
}

function readFlacBlocks(data: Buffer): FlacBlock[] {
    if (data.length < 8 || data.toString('ascii', 0, 4) !== 'fLaC') {
        throw new ValidationError('Not a FLAC file');
    }
    const blocks: FlacBlock[] = [];
    let pos = 4;
    let last = false;
    while (!last) {
        if (pos + 4 > data.length) throw new ValidationError('Truncated FLAC metadata');
        const header = data[pos]!;
        last = (header & 0x80) !== 0;
        const size = data.readUIntBE(pos + 1, 3);
        const end = pos + 4 + size;
        if (end > data.length) throw new ValidationError('Truncated FLAC metadata');
        blocks.push({ type: header & 0x7f, start: pos, end });
        pos = end;
    }
    return blocks;
}

function parseVorbisComments(body: Buffer): { vendor: Buffer; comments: Buffer[] } {
    if (body.length < 8) throw new ValidationError('Invalid Vorbis comment block');
    const vendorLen = body.readUInt32LE(0);
    if (4 + vendorLen + 4 > body.length) throw new ValidationError('Invalid Vorbis comment block');
    const vendor = body.subarray(4, 4 + vendorLen);
    let p = 4 + vendorLen;
    const count = body.readUInt32LE(p);
    p += 4;
    const comments: Buffer[] = [];
    for (let i = 0; i < count; i++) {
        if (p + 4 > body.length) throw new ValidationError('Invalid Vorbis comment block');
        const len = body.readUInt32LE(p);
        p += 4;
        if (p + len > body.length) throw new ValidationError('Invalid Vorbis comment block');
        comments.push(body.subarray(p, p + len));
        p += len;
    }
    return { vendor, comments };
}

function buildVorbisComments(vendor: Buffer, comments: Buffer[]): Buffer {
    const parts: Buffer[] = [];
    const u32 = (value: number) => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(value);
        return buf;
    };
    parts.push(u32(vendor.length), vendor, u32(comments.length));
    for (const comment of comments) parts.push(u32(comment.length), comment);
    return Buffer.concat(parts);
}

/** Replaces the named Vorbis comment keys (case-insensitive). An empty value removes the key. */
export function patchFlacComments(filePath: string, changes: Record<string, string>): void {
    const data = fs.readFileSync(filePath);
    const blocks = readFlacBlocks(data);
    const keys = new Set(Object.keys(changes).map((key) => key.toUpperCase()));

    const existing = blocks.find((block) => block.type === FLAC_BLOCK_VORBIS_COMMENT);
    const parsed = existing
        ? parseVorbisComments(data.subarray(existing.start + 4, existing.end))
        : { vendor: Buffer.from('QBZ-Downloader', 'utf8'), comments: [] as Buffer[] };

    const kept = parsed.comments.filter((comment) => {
        const text = comment.toString('utf8');
        const eq = text.indexOf('=');
        return !(eq > 0 && keys.has(text.slice(0, eq).toUpperCase()));
    });
    for (const [key, value] of Object.entries(changes)) {
        if (value === '') continue;
        kept.push(Buffer.from(`${key.toUpperCase()}=${value}`, 'utf8'));
    }

    const body = buildVorbisComments(parsed.vendor, kept);
    if (body.length > MAX_FLAC_BLOCK) throw new ValidationError('Tags are too large for a FLAC metadata block');

    const blockFor = (type: number, last: boolean, payload: Buffer): Buffer => {
        const header = Buffer.alloc(4);
        header[0] = (last ? 0x80 : 0) | type;
        header.writeUIntBE(payload.length, 1, 3);
        return Buffer.concat([header, payload]);
    };

    const audioStart = blocks[blocks.length - 1]!.end;
    const out: Buffer[] = [data.subarray(0, 4)];
    const metadataBlocks = blocks.map((block) => ({
        type: block.type,
        payload:
            block === existing ? body : data.subarray(block.start + 4, block.end)
    }));
    if (!existing) {
        // A new comment block goes right after STREAMINFO, which must stay first.
        const streamInfoIndex = metadataBlocks.findIndex((block) => block.type === FLAC_BLOCK_STREAMINFO);
        metadataBlocks.splice(streamInfoIndex + 1, 0, { type: FLAC_BLOCK_VORBIS_COMMENT, payload: body });
    }
    metadataBlocks.forEach((block, index) => {
        out.push(blockFor(block.type, index === metadataBlocks.length - 1, block.payload));
    });
    out.push(data.subarray(audioStart));

    replaceAtomically(filePath, Buffer.concat(out));
}

/** Reads all Vorbis comments as upper-case key → values. */
export function readFlacComments(filePath: string): Record<string, string[]> {
    const data = fs.readFileSync(filePath);
    const block = readFlacBlocks(data).find((b) => b.type === FLAC_BLOCK_VORBIS_COMMENT);
    const result: Record<string, string[]> = {};
    if (!block) return result;
    for (const comment of parseVorbisComments(data.subarray(block.start + 4, block.end)).comments) {
        const text = comment.toString('utf8');
        const eq = text.indexOf('=');
        if (eq <= 0) continue;
        const key = text.slice(0, eq).toUpperCase();
        (result[key] ??= []).push(text.slice(eq + 1));
    }
    return result;
}

/* ------------------------------------------------------------------ */
/* MP3                                                                  */
/* ------------------------------------------------------------------ */

const splitPair = (value: string | undefined): [string, string] => {
    const [first = '', second = ''] = String(value ?? '').split('/');
    return [first.trim(), second.trim()];
};
const joinPair = (first: string, second: string): string => (second ? `${first}/${second}` : first);

function patchMp3Tags(filePath: string, changes: TagChanges): void {
    const data = fs.readFileSync(filePath);
    const current = NodeID3.read(data);
    const tags: NodeID3.Tags = {};

    if (changes.title !== undefined) tags.title = changes.title;
    if (changes.artist !== undefined) tags.artist = changes.artist;
    if (changes.album !== undefined) tags.album = changes.album;
    if (changes.albumArtist !== undefined) tags.performerInfo = changes.albumArtist;
    if (changes.genre !== undefined) tags.genre = changes.genre;
    if (changes.year !== undefined) tags.year = changes.year;
    if (changes.composer !== undefined) tags.composer = changes.composer;
    if (changes.label !== undefined) tags.publisher = changes.label;
    if (changes.isrc !== undefined) tags.ISRC = changes.isrc;
    if (changes.copyright !== undefined) tags.copyright = changes.copyright;
    if (changes.comment !== undefined) tags.comment = { language: 'eng', text: changes.comment };
    if (changes.trackNumber !== undefined || changes.totalTracks !== undefined) {
        const [number, total] = splitPair(current.trackNumber);
        tags.trackNumber = joinPair(changes.trackNumber ?? number, changes.totalTracks ?? total);
    }
    if (changes.discNumber !== undefined || changes.totalDiscs !== undefined) {
        const [number, total] = splitPair(current.partOfSet);
        tags.partOfSet = joinPair(changes.discNumber ?? number, changes.totalDiscs ?? total);
    }

    const updated = NodeID3.update(tags, data);
    if (!Buffer.isBuffer(updated)) throw new Error('Failed to write ID3 tags');
    replaceAtomically(filePath, updated);
}

/* ------------------------------------------------------------------ */

/** Applies `changes` to a FLAC or MP3 file, keeping every other tag and the cover. */
export function patchTags(filePath: string, changes: TagChanges): void {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.flac') {
        const vorbis: Record<string, string> = {};
        for (const [field, value] of Object.entries(changes) as [EditableTagField, string | undefined][]) {
            if (value === undefined) continue;
            for (const key of VORBIS_KEYS[field]) vorbis[key] = value;
        }
        patchFlacComments(filePath, vorbis);
        return;
    }
    if (ext === '.mp3') {
        patchMp3Tags(filePath, changes);
        return;
    }
    throw new ValidationError(`Editing tags is not supported for ${ext || 'files without an extension'}`);
}
