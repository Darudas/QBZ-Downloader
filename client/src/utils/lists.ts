type Key = string | number;

const defaultKey = (item: unknown): Key => (item as { id: Key }).id;

/**
 * Removes later entries whose key was already seen. Paged Qobuz lists can
 * overlap (the list changed between two pages), and duplicate React keys
 * break rendering.
 */
export function uniqueBy<T>(items: T[], keyOf: (item: T) => Key = defaultKey): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = String(keyOf(item));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Appends a page to a list, skipping entries that are already in it. */
export function appendPage<T>(prev: T[], page: T[], keyOf: (item: T) => Key = defaultKey): T[] {
    return uniqueBy([...prev, ...page], keyOf);
}
