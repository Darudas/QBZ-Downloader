import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useSettings } from './SettingsContext';

export type Tab =
    | 'queue'
    | 'search'
    | 'batch'
    | 'statistics'
    | 'library'
    | 'playlists'
    | 'favorites'
    | 'my_playlists'
    | 'discover'
    | 'purchases'
    | 'history'
    | 'settings'
    | 'logs'
    | 'album'
    | 'artist'
    | 'label'
    | 'artist_albums'
    | 'artist_tracks';

/** Top-level views: routed as `/<tab>` and restorable as the last opened tab. */
const ALLOWED_TABS: Tab[] = [
    'queue', 'search', 'batch', 'statistics', 'library', 'favorites', 'my_playlists', 'discover', 'purchases',
    'playlists', 'history', 'settings', 'logs'
];

const ALLOWED_ROUTES: string[] = ALLOWED_TABS;

/** Views addressed by an id, routed as `/<tab>/<id>`. */
const DETAIL_TABS: Tab[] = ['artist', 'album', 'label'];

/** Views that keep `navData` when selected through `setActiveTab`. */
const DATA_TABS: Tab[] = [...DETAIL_TABS, 'artist_albums', 'artist_tracks'];

export interface SearchState {
    query: string;
    type: 'albums' | 'tracks' | 'artists';
    results: any[];
    total: number;
    page: number;
}

export interface NavigationData {
    id?: string;
    [key: string]: any;
}

/** What the app keeps in `history.state` for every entry it pushes. */
interface HistoryEntry {
    qbzTab: Tab;
    qbzData: NavigationData | null;
    /** In-app entries before this one; above 0 means "back" stays inside the app. */
    qbzDepth: number;
}

const currentEntry = (): Partial<HistoryEntry> => {
    const state = window.history.state as Partial<HistoryEntry> | null;
    return state && typeof state === 'object' ? state : {};
};

/** Parses `/album/123`, `/label/9` or `/discover` into a tab and its data. */
const parseLocation = (path: string): { tab: Tab; data: NavigationData | null } | null => {
    const [, first = '', second] = path.split('/');
    if (DETAIL_TABS.includes(first as Tab)) {
        return second ? { tab: first as Tab, data: { id: decodeURIComponent(second) } } : null;
    }
    if (first === '') return { tab: 'queue', data: null };
    return ALLOWED_ROUTES.includes(first) ? { tab: first as Tab, data: null } : null;
};

const pathOf = (tab: Tab, data?: NavigationData | null): string => {
    if (DETAIL_TABS.includes(tab) && data?.id) return `/${tab}/${encodeURIComponent(String(data.id))}`;
    if (tab !== 'queue' && ALLOWED_ROUTES.includes(tab)) return `/${tab}`;
    return '/';
};

interface NavigationContextType {
    activeTab: Tab;
    setActiveTab: (tab: Tab) => void;
    navData: NavigationData | null;
    setNavData: (data: NavigationData | null) => void;
    navigate: (tab: Tab, data?: NavigationData) => void;
    /**
     * Returns to the previous in-app view (browser history), or opens
     * `fallback` when the current view was the entry point (deep link, reload).
     */
    goBack: (fallback?: Tab, fallbackData?: NavigationData) => void;
    searchState: SearchState;
    setSearchState: (state: SearchState | ((prev: SearchState) => SearchState)) => void;
}

const NavigationContext = createContext<NavigationContextType>({
    activeTab: 'queue',
    setActiveTab: () => { },
    navData: null,
    setNavData: () => { },
    navigate: () => { },
    goBack: () => { },
    searchState: { query: '', type: 'albums', results: [], total: 0, page: 0 },
    setSearchState: () => { }
});

export const NavigationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { settings, updateSetting, loading: settingsLoading } = useSettings();
    const [activeTab, setActiveTabState] = useState<Tab>('queue');
    const [navData, setNavData] = useState<NavigationData | null>(null);
    const [searchState, setSearchState] = useState<SearchState>({
        query: '',
        type: 'albums',
        results: [],
        total: 0,
        page: 0
    });

    const initialized = useRef(false);
    useEffect(() => {
        // Resolves the entry point once; later moves are pushed by navigate() and restored on popstate.
        if (initialized.current) return;
        const stored = currentEntry();
        if (stored.qbzTab) {
            // A reload keeps history.state, so restore exactly what was shown.
            initialized.current = true;
            setActiveTabState(stored.qbzTab);
            setNavData(stored.qbzData ?? null);
            return;
        }
        const path = window.location.pathname;
        let initial: { tab: Tab; data: NavigationData | null } | null = null;
        if (path === '/') {
            if (settingsLoading) return;
            const last = settings.UI_LAST_TAB as Tab;
            initial = { tab: last && ALLOWED_TABS.includes(last) ? last : 'queue', data: null };
        } else {
            initial = parseLocation(path);
        }
        initialized.current = true;
        if (!initial) return;

        setActiveTabState(initial.tab);
        if (initial.data) setNavData(initial.data);
        const entry: HistoryEntry = { qbzTab: initial.tab, qbzData: initial.data, qbzDepth: 0 };
        window.history.replaceState(entry, '', window.location.pathname + window.location.search);
    }, [settingsLoading, settings.UI_LAST_TAB]);

    /** Pushes a history entry unless it would duplicate the current one. */
    const pushEntry = (tab: Tab, data?: NavigationData | null) => {
        const path = pathOf(tab, data);
        const current = currentEntry();
        const currentTab = current.qbzTab ?? parseLocation(window.location.pathname)?.tab;
        const sameView =
            window.location.pathname === path &&
            currentTab === tab &&
            String(current.qbzData?.id ?? '') === String(data?.id ?? '');
        if (sameView) return;

        const entry: HistoryEntry = {
            qbzTab: tab,
            qbzData: data ?? null,
            qbzDepth: (current.qbzDepth ?? 0) + 1
        };
        window.history.pushState(entry, '', path);
    };

    const setActiveTabStateUnchecked = (tab: Tab) => {
        setActiveTabState(tab);
        updateSetting('ui_last_tab', tab);
    };

    const setActiveTab = (tab: Tab) => {
        setActiveTabStateUnchecked(tab);
        if (!DATA_TABS.includes(tab)) {
            setNavData(null);
            pushEntry(tab, null);
        }
    };

    const navigate = (tab: Tab, data?: NavigationData) => {
        if (data) setNavData(data);
        setActiveTabStateUnchecked(tab);
        pushEntry(tab, data ?? null);
    };

    const goBack = (fallback: Tab = 'search', fallbackData?: NavigationData) => {
        if ((currentEntry().qbzDepth ?? 0) > 0) {
            window.history.back();
            return;
        }
        if (fallbackData) navigate(fallback, fallbackData);
        else setActiveTab(fallback);
    };

    useEffect(() => {
        const handlePop = (event: PopStateEvent) => {
            const state = event.state as Partial<HistoryEntry> | null;
            if (state?.qbzTab) {
                setActiveTabState(state.qbzTab);
                setNavData(state.qbzData ?? null);
                return;
            }
            const parsed = parseLocation(window.location.pathname);
            if (parsed) {
                setActiveTabState(parsed.tab);
                setNavData(parsed.data);
            }
        };
        window.addEventListener('popstate', handlePop);
        return () => window.removeEventListener('popstate', handlePop);
    }, []);

    return (
        <NavigationContext.Provider value={{
            activeTab, setActiveTab,
            navData, setNavData, navigate, goBack,
            searchState, setSearchState
        }}>
            {children}
        </NavigationContext.Provider>
    );
};

export const useNavigation = () => useContext(NavigationContext);
