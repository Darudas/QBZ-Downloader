import React, { useEffect } from 'react';
import { useFavoritesStore, type FavoriteKind } from '../stores/favoritesStore';
import { useToast } from '../contexts/ToastContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Icons } from './Icons';

interface FavoriteButtonProps {
    kind: FavoriteKind;
    id: string | number;
    /** Button class of the surrounding row: `btn-track-dl`, `grid-action-btn` or `btn secondary`. */
    className?: string;
    size?: number;
    style?: React.CSSProperties;
}

/** Heart toggle for a Qobuz album, track or artist favorite. */
export const FavoriteButton: React.FC<FavoriteButtonProps> = ({
    kind,
    id,
    className = 'btn-track-dl',
    size = 14,
    style
}) => {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const load = useFavoritesStore((state) => state.load);
    const toggle = useFavoritesStore((state) => state.toggle);
    const favorite = useFavoritesStore((state) => state.isFavorite(kind, id));
    const busy = useFavoritesStore((state) => state.pending.has(`${kind}:${id}`));

    useEffect(() => {
        void load();
    }, [load]);

    const handleClick = async (event: React.MouseEvent) => {
        event.stopPropagation();
        try {
            const now = await toggle(kind, id);
            showToast(now ? t('msg_favorite_added') : t('msg_favorite_removed'), 'success');
        } catch (err) {
            showToast(err instanceof Error ? err.message : t('msg_favorite_failed'), 'error');
        }
    };

    const label = favorite ? t('action_unfavorite') : t('action_favorite');
    return (
        <button
            type="button"
            className={className}
            onClick={handleClick}
            disabled={busy}
            title={label}
            aria-label={label}
            aria-pressed={favorite}
            style={{ ...(favorite ? { color: 'var(--danger)' } : {}), ...style }}
        >
            <Icons.Heart width={size} height={size} filled={favorite} />
        </button>
    );
};
