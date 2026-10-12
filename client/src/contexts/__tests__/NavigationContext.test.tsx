import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider, useNavigation } from '../NavigationContext';

const mocks = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    updateSetting: vi.fn()
}));

vi.mock('../SettingsContext', () => ({
    useSettings: () => ({ settings: mocks.settings, updateSetting: mocks.updateSetting, loading: false })
}));

const Probe = () => {
    const { activeTab, navData, navigate, setActiveTab, goBack } = useNavigation();
    return (
        <div>
            <span data-testid="tab">{activeTab}</span>
            <span data-testid="id">{navData?.id ?? ''}</span>
            <button onClick={() => setActiveTab('favorites')}>favorites</button>
            <button onClick={() => navigate('album', { id: 'a1' })}>album</button>
            <button onClick={() => navigate('label', { id: '42' })}>label</button>
            <button onClick={() => goBack('search')}>back</button>
        </div>
    );
};

const start = (path: string) => {
    window.history.replaceState(null, '', path);
    return render(
        <NavigationProvider>
            <Probe />
        </NavigationProvider>
    );
};

const tab = () => screen.getByTestId('tab').textContent;
const id = () => screen.getByTestId('id').textContent;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = {};
});

describe('NavigationContext routing', () => {
    it('opens a label from /label/:id', () => {
        start('/label/42');
        expect(tab()).toBe('label');
        expect(id()).toBe('42');
    });

    it('routes the new top-level views', () => {
        start('/discover');
        expect(tab()).toBe('discover');
    });

    it('no longer routes the blank metadata tab', () => {
        start('/metadata');
        expect(tab()).toBe('queue');
    });

    it('ignores a stale metadata last tab', () => {
        mocks.settings = { UI_LAST_TAB: 'metadata' };
        start('/');
        expect(tab()).toBe('queue');
    });

    it('restores the last tab on /', () => {
        mocks.settings = { UI_LAST_TAB: 'purchases' };
        start('/');
        expect(tab()).toBe('purchases');
    });

    it('writes /label/:id to the URL', () => {
        start('/');
        fireEvent.click(screen.getByText('label'));
        expect(window.location.pathname).toBe('/label/42');
        expect(tab()).toBe('label');
    });
});

describe('NavigationContext goBack', () => {
    it('returns to the view the user came from', async () => {
        start('/');
        fireEvent.click(screen.getByText('favorites'));
        fireEvent.click(screen.getByText('album'));
        expect(tab()).toBe('album');
        expect(window.location.pathname).toBe('/album/a1');

        act(() => {
            fireEvent.click(screen.getByText('back'));
        });
        await waitFor(() => expect(tab()).toBe('favorites'));
        expect(window.location.pathname).toBe('/favorites');
        expect(id()).toBe('');
    });

    it('restores an album when going back from its label', async () => {
        start('/');
        fireEvent.click(screen.getByText('album'));
        fireEvent.click(screen.getByText('label'));
        fireEvent.click(screen.getByText('back'));
        await waitFor(() => expect(tab()).toBe('album'));
        expect(id()).toBe('a1');
    });

    it('falls back when the view was opened directly', () => {
        start('/album/zz');
        expect(tab()).toBe('album');
        fireEvent.click(screen.getByText('back'));
        expect(tab()).toBe('search');
        expect(window.location.pathname).toBe('/search');
    });
});
