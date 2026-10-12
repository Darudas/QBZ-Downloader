import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ValidationError, ForbiddenError } from '../../utils/errors.js';

const service = vi.hoisted(() => ({
    listFavorites: vi.fn(),
    getFavoriteIds: vi.fn(),
    checkFavorites: vi.fn(),
    addFavorites: vi.fn(),
    removeFavorites: vi.fn(),
    listUserPlaylists: vi.fn(),
    createPlaylist: vi.fn(),
    getPlaylist: vi.fn(),
    updatePlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    addTracks: vi.fn(),
    removeTracks: vi.fn(),
    followPlaylist: vi.fn(),
    unfollowPlaylist: vi.fn(),
    listPurchases: vi.fn(),
    getPurchaseIds: vi.fn(),
    getFeaturedAlbums: vi.fn(),
    getFeaturedPlaylists: vi.fn(),
    getLabel: vi.fn(),
    getSimilarArtists: vi.fn(),
    getArtistReleases: vi.fn(),
    getAccountInfo: vi.fn(),
    resolveUrl: vi.fn()
}));

vi.mock('../qobuz-library/index.js', () => ({ qobuzLibraryService: service }));
vi.mock('../../utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import qobuzLibraryRouter from './routers/qobuz-library.routes.js';

const app = express();
app.use(express.json());
app.use('/api', qobuzLibraryRouter);

const page = { items: [], total: 0, offset: 0, limit: 25, has_more: false };

describe('Qobuz library routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('favorites', () => {
        it('lists favorites by type with paging', async () => {
            service.listFavorites.mockResolvedValue(page);
            const res = await request(app).get('/api/favorites?type=tracks&limit=10&offset=20');
            expect(res.status).toBe(200);
            expect(service.listFavorites).toHaveBeenCalledWith('tracks', { limit: '10', offset: '20' });
        });

        it('defaults to albums', async () => {
            service.listFavorites.mockResolvedValue(page);
            await request(app).get('/api/favorites');
            expect(service.listFavorites).toHaveBeenCalledWith('albums', {});
        });

        it('returns all favorite ids without parameters', async () => {
            service.getFavoriteIds.mockResolvedValue({ albums: ['a1'], tracks: [], artists: [] });
            const res = await request(app).get('/api/favorites/ids');
            expect(res.body).toEqual({ albums: ['a1'], tracks: [], artists: [] });
            expect(service.checkFavorites).not.toHaveBeenCalled();
        });

        it('checks given ids from comma lists and repeated params', async () => {
            service.checkFavorites.mockResolvedValue({ albums: {}, tracks: {}, artists: {} });
            await request(app).get('/api/favorites/ids?trackIds=1,2&trackIds=3&albumIds=abc');
            expect(service.checkFavorites).toHaveBeenCalledWith({ trackIds: ['1', '2', '3'], albumIds: ['abc'] });
        });

        it('adds and removes favorites with the request body', async () => {
            service.addFavorites.mockResolvedValue({ action: 'add', count: 1 });
            service.removeFavorites.mockResolvedValue({ action: 'remove', count: 1 });
            await request(app).post('/api/favorites').send({ trackIds: ['5'] });
            await request(app).delete('/api/favorites').send({ albumIds: ['x'] });
            expect(service.addFavorites).toHaveBeenCalledWith({ trackIds: ['5'] });
            expect(service.removeFavorites).toHaveBeenCalledWith({ albumIds: ['x'] });
        });

        it('maps service validation errors to 400 JSON', async () => {
            service.addFavorites.mockRejectedValue(new ValidationError('Invalid favorite ids'));
            const res = await request(app).post('/api/favorites').send({ trackIds: ['nope'] });
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ error: 'Invalid favorite ids' });
        });

        it('rejects a non-object body', async () => {
            const res = await request(app).post('/api/favorites').send([1, 2]);
            expect(res.status).toBe(400);
            expect(service.addFavorites).not.toHaveBeenCalled();
        });
    });

    describe('own playlists', () => {
        it('lists with filter and paging', async () => {
            service.listUserPlaylists.mockResolvedValue(page);
            await request(app).get('/api/me/playlists?filter=owner&limit=5');
            expect(service.listUserPlaylists).toHaveBeenCalledWith({ limit: '5', filter: 'owner' });
        });

        it('creates a playlist with 201', async () => {
            service.createPlaylist.mockResolvedValue({ playlist: { id: 9 }, added: 0, requested: 0 });
            const res = await request(app).post('/api/me/playlists').send({ name: 'Mix', trackIds: [1] });
            expect(res.status).toBe(201);
            expect(service.createPlaylist).toHaveBeenCalledWith({ name: 'Mix', trackIds: [1] });
        });

        it('gets, updates and deletes by id', async () => {
            service.getPlaylist.mockResolvedValue({});
            service.updatePlaylist.mockResolvedValue({});
            service.deletePlaylist.mockResolvedValue({ deleted: true });
            await request(app).get('/api/me/playlists/42?offset=50');
            await request(app).patch('/api/me/playlists/42').send({ name: 'New' });
            await request(app).delete('/api/me/playlists/42');
            expect(service.getPlaylist).toHaveBeenCalledWith('42', { offset: '50' });
            expect(service.updatePlaylist).toHaveBeenCalledWith('42', { name: 'New' });
            expect(service.deletePlaylist).toHaveBeenCalledWith('42');
        });

        it('adds and removes tracks', async () => {
            service.addTracks.mockResolvedValue({});
            service.removeTracks.mockResolvedValue({});
            await request(app).post('/api/me/playlists/42/tracks').send({ albumId: 'abc' });
            await request(app).delete('/api/me/playlists/42/tracks').send({ trackIds: [1] });
            expect(service.addTracks).toHaveBeenCalledWith('42', { albumId: 'abc' });
            expect(service.removeTracks).toHaveBeenCalledWith('42', { trackIds: [1] });
        });

        it('follows and unfollows', async () => {
            service.followPlaylist.mockResolvedValue({ following: true });
            service.unfollowPlaylist.mockResolvedValue({ following: false });
            await request(app).post('/api/me/playlists/7/follow');
            await request(app).delete('/api/me/playlists/7/follow');
            expect(service.followPlaylist).toHaveBeenCalledWith('7');
            expect(service.unfollowPlaylist).toHaveBeenCalledWith('7');
        });

        it('passes ownership errors through as 403', async () => {
            service.deletePlaylist.mockRejectedValue(new ForbiddenError('Not your playlist'));
            const res = await request(app).delete('/api/me/playlists/7');
            expect(res.status).toBe(403);
        });

        it('hides unexpected errors behind a generic 500', async () => {
            service.listUserPlaylists.mockRejectedValue(new Error('secret token abc'));
            const res = await request(app).get('/api/me/playlists');
            expect(res.status).toBe(500);
            expect(JSON.stringify(res.body)).not.toContain('secret');
        });
    });

    describe('purchases, discovery, artists, account', () => {
        it('lists purchases and purchase ids', async () => {
            service.listPurchases.mockResolvedValue(page);
            service.getPurchaseIds.mockResolvedValue({ albums: [], tracks: [] });
            await request(app).get('/api/purchases?type=tracks');
            await request(app).get('/api/purchases/ids');
            expect(service.listPurchases).toHaveBeenCalledWith('tracks', {});
            expect(service.getPurchaseIds).toHaveBeenCalled();
        });

        it('passes discovery type and genre', async () => {
            service.getFeaturedAlbums.mockResolvedValue(page);
            service.getFeaturedPlaylists.mockResolvedValue(page);
            await request(app).get('/api/discover/albums?type=press-awards&genre_id=112');
            await request(app).get('/api/discover/playlists');
            expect(service.getFeaturedAlbums).toHaveBeenCalledWith('press-awards', { genreId: '112' });
            expect(service.getFeaturedPlaylists).toHaveBeenCalledWith('editor-picks', {});
        });

        it('passes label, similar artists and releases options', async () => {
            service.getLabel.mockResolvedValue({});
            service.getSimilarArtists.mockResolvedValue(page);
            service.getArtistReleases.mockResolvedValue(page);
            await request(app).get('/api/label/3');
            await request(app).get('/api/artist/5/similar?limit=10');
            await request(app).get('/api/artist/5/releases?release_type=album,live&sort=release_date&order=desc');
            expect(service.getLabel).toHaveBeenCalledWith('3', {});
            expect(service.getSimilarArtists).toHaveBeenCalledWith('5', { limit: '10' });
            expect(service.getArtistReleases).toHaveBeenCalledWith('5', {
                releaseType: ['album', 'live'],
                sort: 'release_date',
                order: 'desc'
            });
        });

        it('returns account info and resolves URLs', async () => {
            service.getAccountInfo.mockResolvedValue({ id: '1' });
            service.resolveUrl.mockResolvedValue({ type: 'album', id: 'x' });
            await request(app).get('/api/account');
            const res = await request(app).get('/api/resolve?url=https://play.qobuz.com/album/x&details=1');
            expect(res.status).toBe(200);
            expect(service.resolveUrl).toHaveBeenCalledWith('https://play.qobuz.com/album/x', { details: true });
        });

        it('requires a url to resolve', async () => {
            const res = await request(app).get('/api/resolve');
            expect(res.status).toBe(400);
        });
    });
});
