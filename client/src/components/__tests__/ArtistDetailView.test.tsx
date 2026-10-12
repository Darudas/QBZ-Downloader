import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtistDetailView } from '../ArtistDetailView';

const mocks = vi.hoisted(() => ({
  smartFetch: vi.fn(),
  showToast: vi.fn(),
  navigate: vi.fn(),
  goBack: vi.fn(),
  setActiveTab: vi.fn(),
  addToStaging: vi.fn(),
  settings: {} as Record<string, unknown>,
  navData: null as { id: string } | null,
}));

vi.mock('../../utils/api', async () => {
  const { apiJsonVia } = await import('../../test-utils/apiMock');
  return { smartFetch: mocks.smartFetch, apiJson: apiJsonVia(mocks.smartFetch) };
});

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navData: mocks.navData,
    setActiveTab: mocks.setActiveTab,
    navigate: mocks.navigate,
    goBack: mocks.goBack,
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    addToStaging: mocks.addToStaging,
    settings: mocks.settings,
  }),
}));

function mockResponse(data: unknown, ok = true) {
  return { ok, json: vi.fn().mockResolvedValue(data) };
}

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items, total: items.length, offset: 0, limit: 50, has_more: false, ...extra,
});

const artistData = {
  id: '123',
  name: 'Test Artist',
  image: { large: 'https://example.com/cover.jpg' },
  biography: { en: 'A long biography. '.repeat(30) },
  tracks: {
    items: [
      { id: 't1', title: 'Track One', duration: 240, track_number: 1, performer: { name: 'Test Artist' } },
      { id: 't2', title: 'Track Two', duration: 180, track_number: 2, performer: { name: 'Test Artist' } },
    ],
  },
  albums: {
    items: [
      { id: 'a1', title: 'Album One', image: { small: '' }, release_date_original: '2024-01-15',
        maximum_bit_depth: 24, maximum_sampling_rate: 96 },
    ],
  },
  similar_artists: {
    items: [{ id: 'sa1', name: 'Similar Artist', image: { small: '' } }],
  },
};

const releases = [
  { id: 'r1', title: 'Live at Home', release_type: 'live', dates: { original: '2020-05-01' },
    artist: { name: { display: 'Test Artist' } }, audio_info: { maximum_bit_depth: 24 } },
];

/** Answers the artist, similar and releases routes; `fail` makes the given extra route fail. */
function routeFetch(options: { fail?: 'similar' | 'releases' } = {}) {
  mocks.smartFetch.mockImplementation(async (url: string) => {
    if (url.includes('/similar')) {
      return options.fail === 'similar'
        ? mockResponse({ error: 'nope' }, false)
        : mockResponse(page([{ id: 'sa2', name: 'Endpoint Similar', image: { small: '' } }]));
    }
    if (url.includes('/releases')) {
      return options.fail === 'releases'
        ? mockResponse({ error: 'Releases unavailable' }, false)
        : mockResponse(page(releases, { has_more: true, total: null }));
    }
    if (url.startsWith('/api/favorites')) return mockResponse({ albums: [], tracks: [], artists: [] });
    return mockResponse(artistData);
  });
}

describe('ArtistDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.navData = { id: '123' };
  });

  it('shows no artist selected when no navData.id', () => {
    mocks.navData = null;
    render(<ArtistDetailView />);
    expect(screen.getByText('No artist selected')).toBeInTheDocument();
    expect(screen.getByText('Back to Search')).toBeInTheDocument();
  });

  it('shows loading skeleton while fetching', () => {
    mocks.smartFetch.mockReturnValue(new Promise(() => {}));
    render(<ArtistDetailView />);
    expect(document.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('shows error when fetch fails', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(null, false));
    render(<ArtistDetailView />);
    await waitFor(() => {
      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });

  it('renders artist details with tracks and albums', async () => {
    routeFetch();
    render(<ArtistDetailView />);
    await waitFor(() => {
      expect(screen.getByText('Test Artist')).toBeInTheDocument();
      expect(screen.getByText('Track One')).toBeInTheDocument();
      expect(screen.getByText('Track Two')).toBeInTheDocument();
      expect(screen.getByText('Album One')).toBeInTheDocument();
    });
  });

  it('shows similar artists from the dedicated endpoint and opens one', async () => {
    routeFetch();
    render(<ArtistDetailView />);
    fireEvent.click(await screen.findByText('Endpoint Similar'));
    expect(mocks.navigate).toHaveBeenCalledWith('artist', { id: 'sa2' });
    expect(screen.queryByText('Similar Artist')).not.toBeInTheDocument();
  });

  it('falls back to the similar artists of the artist payload', async () => {
    routeFetch({ fail: 'similar' });
    render(<ArtistDetailView />);
    expect(await screen.findByText('Similar Artist')).toBeInTheDocument();
  });

  it('shows the discography and refetches with the chosen release type', async () => {
    routeFetch();
    render(<ArtistDetailView />);
    expect(await screen.findByText('Live at Home')).toBeInTheDocument();
    // The test translator returns keys, so the type label falls back to the raw Qobuz value.
    expect(screen.getByText('2020 • live')).toBeInTheDocument();
    expect(mocks.smartFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/artist/123/releases?release_type=all'),
      expect.anything()
    );

    fireEvent.change(screen.getByLabelText('label_release_type'), { target: { value: 'live' } });
    await waitFor(() =>
      expect(mocks.smartFetch).toHaveBeenCalledWith(
        expect.stringContaining('release_type=live'),
        expect.anything()
      )
    );

    fireEvent.click(screen.getByText('action_load_more'));
    await waitFor(() =>
      expect(mocks.smartFetch).toHaveBeenCalledWith(expect.stringContaining('offset=1'), expect.anything())
    );
  });

  it('reports a failing discography without hiding the artist', async () => {
    routeFetch({ fail: 'releases' });
    render(<ArtistDetailView />);
    expect(await screen.findByText(/Releases unavailable/)).toBeInTheDocument();
    expect(screen.getByText('Track One')).toBeInTheDocument();
  });

  it('goes back in history instead of always opening search', async () => {
    routeFetch();
    render(<ArtistDetailView />);
    fireEvent.click(await screen.findByText('action_back'));
    expect(mocks.goBack).toHaveBeenCalledWith('search');
  });

  it('reports a lyrics download failure instead of success', async () => {
    routeFetch();
    const base = mocks.smartFetch.getMockImplementation()!;
    mocks.smartFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/lyrics/download' ? mockResponse({ error: 'Lyrics not found' }, false) : base(url, init)
    );
    render(<ArtistDetailView />);
    await screen.findByText('Track One');
    fireEvent.click(screen.getAllByTitle('Download Lyrics')[0]);
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Lyrics not found', 'error'));
    expect(mocks.showToast).not.toHaveBeenCalledWith('Lyrics download queued', 'success');
  });

  it('shows read more / read less for long biography', async () => {
    routeFetch();
    render(<ArtistDetailView />);
    await waitFor(() => expect(screen.getByText(/Read more/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Read more/));
    expect(screen.getByText(/Read less/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Read less/));
    expect(screen.getByText(/Read more/)).toBeInTheDocument();
  });

  it('fetches artist data on mount with navData.id', async () => {
    routeFetch();
    render(<ArtistDetailView />);
    await waitFor(() => {
      expect(mocks.smartFetch).toHaveBeenCalledWith('/api/artist/123?limit=20');
    });
  });
});
