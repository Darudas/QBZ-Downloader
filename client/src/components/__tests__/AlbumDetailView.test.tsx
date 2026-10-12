import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumDetailView } from '../AlbumDetailView';

const mocks = vi.hoisted(() => ({
  smartFetch: vi.fn(),
  showToast: vi.fn(),
  setActiveTab: vi.fn(),
  navigate: vi.fn(),
  goBack: vi.fn(),
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

const albumData = {
  id: 'a1',
  title: 'Test Album Title',
  artist: { name: 'Test Artist' },
  image: {
    large: 'https://example.com/large.jpg',
    medium: 'https://example.com/med.jpg',
    small: 'https://example.com/small.jpg',
  },
  tracks: {
    items: [
      { id: 't1', title: 'Track One', duration: 240, track_number: 1, performer: { name: 'Test Artist' } },
      { id: 't2', title: 'Track Two', duration: 300, track_number: 2, performer: { name: 'Test Artist' } },
    ],
  },
  duration: 540,
  track_count: 2,
  genre: { name: 'Rock' },
  release_date_original: '2024-01-15',
  label: { name: 'Test Label' },
  maximum_bit_depth: 24,
  maximum_sampling_rate: 96,
  hires: true,
};

describe('AlbumDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.navData = { id: 'a1' };
  });

  it('shows no album selected when no navData.id', () => {
    mocks.navData = null;
    render(<AlbumDetailView />);
    expect(screen.getByText('No Album Selected')).toBeInTheDocument();
    expect(screen.getByText('Back to Search')).toBeInTheDocument();
  });

  it('shows loading skeleton while fetching', () => {
    mocks.smartFetch.mockReturnValue(new Promise(() => {}));
    render(<AlbumDetailView />);
    expect(document.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('shows error when fetch fails', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(null, false));
    render(<AlbumDetailView />);
    await waitFor(() => {
      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });

  it('renders album details with tracks', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(albumData));
    render(<AlbumDetailView />);
    await waitFor(() => {
      expect(screen.getByText('Test Album Title')).toBeInTheDocument();
      expect(screen.getByText('Test Artist')).toBeInTheDocument();
      expect(screen.getByText('HI-RES 24/96')).toBeInTheDocument();
      expect(screen.getByText('Track One')).toBeInTheDocument();
      expect(screen.getByText('Track Two')).toBeInTheDocument();
    });
  });

  it('shows download album button', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(albumData));
    render(<AlbumDetailView />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /album/i })).toBeInTheDocument();
    });
  });

  it('opens download modal with ZIP and separate options', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(albumData));
    render(<AlbumDetailView />);
    await waitFor(() => {
      const btns = screen.getAllByRole('button');
      const dlBtn = btns.find(b => b.textContent?.toLowerCase().includes('download') && b.textContent?.toLowerCase().includes('album'));
      expect(dlBtn).toBeDefined();
      fireEvent.click(dlBtn!);
    });
    expect(screen.getByText('Download as ZIP')).toBeInTheDocument();
    expect(screen.getByText('Separate Files')).toBeInTheDocument();
  });

  it('cancels modal', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(albumData));
    render(<AlbumDetailView />);
    await waitFor(() => {
      const btns = screen.getAllByRole('button');
      const dlBtn = btns.find(b => b.textContent?.toLowerCase().includes('download') && b.textContent?.toLowerCase().includes('album'));
      fireEvent.click(dlBtn!);
    });
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Download as ZIP')).not.toBeInTheDocument();
  });

  it('queues album download via separate files', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(albumData));
    render(<AlbumDetailView />);
    await waitFor(() => {
      const btns = screen.getAllByRole('button');
      const dlBtn = btns.find(b => b.textContent?.toLowerCase().includes('download') && b.textContent?.toLowerCase().includes('album'));
      fireEvent.click(dlBtn!);
    });
    mocks.smartFetch.mockResolvedValue(mockResponse({ success: true }));
    fireEvent.click(screen.getByText('Separate Files'));
    await waitFor(() => {
      expect(mocks.smartFetch).toHaveBeenCalledWith('/api/queue/add', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ type: 'album', id: 'a1' }),
      }));
    });
  });

  it('opens the label page from the label name', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse({ ...albumData, label: { id: 42, name: 'Test Label' } }));
    render(<AlbumDetailView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test Label' }));
    expect(mocks.navigate).toHaveBeenCalledWith('label', { id: '42' });
  });

  it('shows a label without id as plain text', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(albumData));
    render(<AlbumDetailView />);
    expect(await screen.findByText(/Test Label/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test Label' })).not.toBeInTheDocument();
  });

  it('goes back to the previous view', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(albumData));
    render(<AlbumDetailView />);
    fireEvent.click(await screen.findByText('action_back'));
    expect(mocks.goBack).toHaveBeenCalledWith('search');
  });

  const openAlbumModal = async () => {
    render(<AlbumDetailView />);
    await screen.findByText('Track One');
    const dlBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('action_download') && b.textContent?.includes('Album'));
    fireEvent.click(dlBtn!);
  };

  it('reports a failed ZIP download instead of success', async () => {
    mocks.smartFetch.mockImplementation(async (url: string) =>
      url === '/api/batch/import/direct'
        ? mockResponse({ error: 'Missing credentials' }, false)
        : mockResponse(albumData)
    );
    await openAlbumModal();
    fireEvent.click(screen.getByText('Download as ZIP'));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Missing credentials', 'error'));
    expect(mocks.showToast).not.toHaveBeenCalledWith('Album download started (ZIP)', 'success');
  });

  it('reports a ZIP import that queued nothing as an error', async () => {
    mocks.smartFetch.mockImplementation(async (url: string) =>
      url === '/api/batch/import/direct'
        ? mockResponse({ success: false, imported: 0, failed: 2, errors: ['Track 1 unavailable'] })
        : mockResponse(albumData)
    );
    await openAlbumModal();
    fireEvent.click(screen.getByText('Download as ZIP'));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Track 1 unavailable', 'error'));
  });

  it('starts a ZIP download when tracks were queued', async () => {
    mocks.smartFetch.mockImplementation(async (url: string) =>
      url === '/api/batch/import/direct'
        ? mockResponse({ success: true, imported: 2, failed: 0, errors: [] })
        : mockResponse(albumData)
    );
    await openAlbumModal();
    fireEvent.click(screen.getByText('Download as ZIP'));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Album download started (ZIP)', 'success'));
  });

  it('counts only lyrics that were actually found', async () => {
    mocks.smartFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/lyrics/download') {
        const { trackId } = JSON.parse(String(init?.body));
        return trackId === 't1' ? mockResponse({ success: true }) : mockResponse({ error: 'Lyrics not found' }, false);
      }
      return mockResponse(albumData);
    });
    render(<AlbumDetailView />);
    fireEvent.click(await screen.findByText(/All Lyrics/));
    fireEvent.click(screen.getByText('Separate Files'));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Lyrics found for 1/2 tracks', 'info'));
  });

  it('fetches album on mount with navData.id', async () => {
    mocks.smartFetch.mockResolvedValue(mockResponse(albumData));
    render(<AlbumDetailView />);
    await waitFor(() => {
      expect(mocks.smartFetch).toHaveBeenCalledWith('/api/album/a1');
    });
  });
});
