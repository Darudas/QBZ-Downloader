import React, { createContext, useContext, useEffect, useState } from 'react';
import { useSettings } from './SettingsContext';
import { apiJson } from '../utils/api';

export interface Theme {
    id: string;
    name: string;
    is_dark: boolean;
    colors: Record<string, string>;
    created_at?: string;
}

interface ThemeContextType {
    currentTheme: Theme;
    themes: Theme[];
    setCurrentTheme: (theme: Theme) => void;
    saveTheme: (name: string, isDark: boolean, colors: Record<string, string>) => Promise<void>;
    deleteTheme: (id: string) => Promise<void>;
    applyTheme: (theme: Theme) => void;
    resetTheme: () => void;
}

const defaultTheme: Theme = {
    id: 'default',
    name: 'Default Dark',
    is_dark: true,
    colors: {
        '--bg-dark': '#000000',
        '--bg-card': '#0c0c0c',
        '--bg-hover': '#161616',
        '--bg-elevated': '#101010',
        '--text-primary': '#ffffff',
        '--text-secondary': '#aaaaaa',
        '--accent-rgb': '99, 102, 241',
        '--border': '#222222',
        '--border-light': '#333333'
    }
};



const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { settings, updateSetting, loading: settingsLoading } = useSettings();
    const [currentTheme, setCurrentTheme] = useState<Theme>(defaultTheme);
    const [themes, setThemes] = useState<Theme[]>([]);

    useEffect(() => {
        if (!settingsLoading) {
            fetchThemes();
        }
    }, [settingsLoading, settings.UI_ACTIVE_THEME_ID]);

    const fetchThemes = async () => {
        try {
            const data = await apiJson<Theme[]>('/api/themes');
            if (Array.isArray(data)) {
                setThemes(data);
                const savedThemeId = settings.UI_ACTIVE_THEME_ID;
                if (savedThemeId) {
                    const found = data.find((t: Theme) => t.id === savedThemeId);
                    if (found) {
                        applyTheme(found);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load themes', error);
        }
    };

    const applyTheme = (theme: Theme) => {
        const root = document.documentElement;

        Object.entries(theme.colors).forEach(([key, value]) => {
            root.style.setProperty(key, value);
        });

        if (theme.colors['--accent-rgb']) {
            root.style.setProperty('--accent-rgb', theme.colors['--accent-rgb']);
            root.style.setProperty('--accent', `rgb(${theme.colors['--accent-rgb']})`);
            root.style.setProperty('--accent-hover', `rgba(${theme.colors['--accent-rgb']}, 0.8)`);
            root.style.setProperty('--accent-glow', `rgba(${theme.colors['--accent-rgb']}, 0.3)`);
        }

        if (theme.is_dark) {
            document.body.classList.remove('light-theme');
        } else {
            document.body.classList.add('light-theme');
        }

        setCurrentTheme(theme);
        if (theme.id !== 'default') {
            updateSetting('ui_active_theme_id', theme.id);
        } else {
            updateSetting('ui_active_theme_id', '');
        }
    };

    /** Throws (ApiError) when the server refuses, so callers can report it. */
    const saveTheme = async (name: string, isDark: boolean, colors: Record<string, string>) => {
        const newTheme = await apiJson<Theme>('/api/themes', {
            method: 'POST',
            body: { name, isDark, colors }
        });
        setThemes(prev => [...prev, newTheme]);
        applyTheme(newTheme);
    };

    /** Throws (ApiError) when the server refuses, so callers can report it. */
    const deleteTheme = async (id: string) => {
        const result = await apiJson<{ success?: boolean } | null>(`/api/themes/${encodeURIComponent(id)}`, { method: 'DELETE' });
        // The server answers 200 { success: false } for an unknown theme.
        if (result?.success === false) throw new Error('Theme not found');
        setThemes(prev => prev.filter(t => t.id !== id));
        if (currentTheme.id === id) {
            resetTheme();
        }
    };

    const resetTheme = () => {
        applyTheme(defaultTheme);
    };

    return (
        <ThemeContext.Provider value={{
            currentTheme,
            themes,
            setCurrentTheme,
            saveTheme,
            deleteTheme,
            applyTheme,
            resetTheme
        }}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
