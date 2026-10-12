import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import NodeID3 from 'node-id3';
import { execFileSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { patchFlacComments, patchTags, readFlacComments } from './tag-editor.js';

const block = (type: number, payload: Buffer, last = false): Buffer => {
    const header = Buffer.alloc(4);
    header[0] = (last ? 0x80 : 0) | type;
    header.writeUIntBE(payload.length, 1, 3);
    return Buffer.concat([header, payload]);
};

const vorbis = (comments: string[]): Buffer => {
    const u32 = (n: number) => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n);
        return b;
    };
    const vendor = Buffer.from('reference libFLAC', 'utf8');
    return Buffer.concat([
        u32(vendor.length),
        vendor,
        u32(comments.length),
        ...comments.flatMap((c) => {
            const buf = Buffer.from(c, 'utf8');
            return [u32(buf.length), buf];
        })
    ]);
};

const STREAMINFO = Buffer.alloc(34, 7);
const PICTURE = Buffer.from('picture-block-payload-with-jpeg-bytes', 'utf8');
const AUDIO = Buffer.from([0xff, 0xf8, 0x69, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

const flacFile = (comments: string[] | null): Buffer =>
    Buffer.concat([
        Buffer.from('fLaC', 'ascii'),
        block(0, STREAMINFO),
        ...(comments ? [block(4, vorbis(comments))] : []),
        block(6, PICTURE, true),
        AUDIO
    ]);

/** Returns [type, last, payload] for every metadata block, plus the trailing audio bytes. */
const parseFlac = (data: Buffer) => {
    const blocks: Array<{ type: number; last: boolean; payload: Buffer }> = [];
    let pos = 4;
    let last = false;
    while (!last) {
        last = (data[pos]! & 0x80) !== 0;
        const size = data.readUIntBE(pos + 1, 3);
        blocks.push({ type: data[pos]! & 0x7f, last, payload: data.subarray(pos + 4, pos + 4 + size) });
        pos += 4 + size;
    }
    return { blocks, audio: data.subarray(pos) };
};

describe('tag-editor', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-tags-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('replaces only the named Vorbis comments and keeps cover, other tags and audio', () => {
        const file = path.join(dir, 'a.flac');
        fs.writeFileSync(
            file,
            flacFile(['TITLE=Old', 'title=old lower', 'ARTIST=Band', 'REPLAYGAIN_TRACK_GAIN=-6.5 dB', 'LYRICS=line 1\nline 2'])
        );

        patchTags(file, { title: 'New Title', genre: 'Jazz', year: '2001' });

        const comments = readFlacComments(file);
        expect(comments.TITLE).toEqual(['New Title']);
        expect(comments.GENRE).toEqual(['Jazz']);
        expect(comments.DATE).toEqual(['2001']);
        expect(comments.YEAR).toEqual(['2001']);
        expect(comments.ARTIST).toEqual(['Band']);
        expect(comments.REPLAYGAIN_TRACK_GAIN).toEqual(['-6.5 dB']);
        expect(comments.LYRICS).toEqual(['line 1\nline 2']);

        const parsed = parseFlac(fs.readFileSync(file));
        expect(parsed.blocks.map((b) => [b.type, b.last])).toEqual([
            [0, false],
            [4, false],
            [6, true]
        ]);
        expect(parsed.blocks[0]!.payload.equals(STREAMINFO)).toBe(true);
        expect(parsed.blocks[2]!.payload.equals(PICTURE)).toBe(true);
        expect(parsed.audio.equals(AUDIO)).toBe(true);
        expect(fs.readdirSync(dir)).toEqual(['a.flac']);
    });

    it('edits the target of a symlink, keeps the link and the file permissions', () => {
        const real = path.join(dir, 'real.flac');
        const link = path.join(dir, 'link.flac');
        fs.writeFileSync(real, flacFile(['TITLE=Old']));
        fs.chmodSync(real, 0o640);
        fs.symlinkSync(real, link);

        patchTags(link, { title: 'New' });

        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFlacComments(real).TITLE).toEqual(['New']);
        expect(fs.statSync(real).mode & 0o777).toBe(0o640);
        expect(fs.readdirSync(dir).sort()).toEqual(['link.flac', 'real.flac']);
    });

    it.skipIf(!ffmpegPath || !fs.existsSync(String(ffmpegPath)))(
        'keeps the decoded audio of a real FLAC identical when tags grow and shrink',
        () => {
            const ffmpeg = String(ffmpegPath);
            const file = path.join(dir, 'real.flac');
            execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-metadata', 'TITLE=Old', file]);
            const audioMd5 = () =>
                execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'md5', '-']).toString().trim();
            const before = audioMd5();

            patchTags(file, { title: 'x'.repeat(5000), comment: 'grown' });
            expect(readFlacComments(file).TITLE).toEqual(['x'.repeat(5000)]);
            expect(audioMd5()).toBe(before);

            patchTags(file, { title: 'Short', comment: '' });
            expect(readFlacComments(file).TITLE).toEqual(['Short']);
            expect(audioMd5()).toBe(before);
        }
    );

    it('removes a tag when the new value is empty', () => {
        const file = path.join(dir, 'b.flac');
        fs.writeFileSync(file, flacFile(['COMMENT=downloaded by x', 'TITLE=T']));
        patchTags(file, { comment: '' });
        const comments = readFlacComments(file);
        expect(comments.COMMENT).toBeUndefined();
        expect(comments.TITLE).toEqual(['T']);
    });

    it('adds a comment block after STREAMINFO when the file has none', () => {
        const file = path.join(dir, 'c.flac');
        fs.writeFileSync(file, flacFile(null));
        patchFlacComments(file, { TITLE: 'Fresh' });
        const parsed = parseFlac(fs.readFileSync(file));
        expect(parsed.blocks.map((b) => [b.type, b.last])).toEqual([
            [0, false],
            [4, false],
            [6, true]
        ]);
        expect(readFlacComments(file).TITLE).toEqual(['Fresh']);
        expect(parsed.audio.equals(AUDIO)).toBe(true);
    });

    it('refuses files that are not FLAC and leaves them untouched', () => {
        const file = path.join(dir, 'fake.flac');
        fs.writeFileSync(file, 'ID3 not flac at all');
        expect(() => patchTags(file, { title: 'x' })).toThrow('Not a FLAC file');
        expect(fs.readFileSync(file, 'utf8')).toBe('ID3 not flac at all');
        expect(() => patchTags(path.join(dir, 'x.m4a'), { title: 'x' })).toThrow(/not supported/);
    });

    it('merges ID3 frames for MP3 and keeps the cover', () => {
        const file = path.join(dir, 'd.mp3');
        fs.writeFileSync(file, Buffer.alloc(256, 0));
        const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
        NodeID3.write(
            {
                title: 'Old',
                artist: 'Band',
                album: 'Record',
                trackNumber: '3/12',
                image: { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: cover }
            },
            file
        );

        patchTags(file, { title: 'New', trackNumber: '4', albumArtist: 'Various' });

        const tags = NodeID3.read(file);
        expect(tags.title).toBe('New');
        expect(tags.artist).toBe('Band');
        expect(tags.album).toBe('Record');
        expect(tags.trackNumber).toBe('4/12');
        expect(tags.performerInfo).toBe('Various');
        const image = tags.image as { imageBuffer?: Buffer } | undefined;
        expect(image?.imageBuffer?.equals(cover)).toBe(true);
    });
});
