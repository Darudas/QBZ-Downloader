import type React from 'react';

/**
 * Props that make a clickable row or card usable from the keyboard: it is
 * focusable, announced as a button, and Enter or Space activates it. Key
 * presses on inner controls (download, heart, ...) are ignored so they only
 * trigger their own action.
 */
export function activationProps(onActivate: () => void, label?: string) {
    return {
        role: 'button' as const,
        tabIndex: 0,
        ...(label ? { 'aria-label': label } : {}),
        onClick: onActivate,
        onKeyDown: (event: React.KeyboardEvent) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate();
            }
        }
    };
}
