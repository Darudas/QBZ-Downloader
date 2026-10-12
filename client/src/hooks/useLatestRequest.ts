import { useCallback, useRef } from 'react';

/**
 * Guards async loads against out-of-order responses. Each call of the
 * returned `begin()` starts a new request generation and hands back an
 * `isLatest()` check; a response should only be applied while it is still
 * the latest, so a slow older request cannot overwrite newer data.
 */
export function useLatestRequest(): () => () => boolean {
    const generation = useRef(0);
    return useCallback(() => {
        const mine = ++generation.current;
        return () => generation.current === mine;
    }, []);
}
