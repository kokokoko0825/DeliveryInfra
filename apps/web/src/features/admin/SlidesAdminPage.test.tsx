import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SLIDE_MAX_BYTES } from '@delivery/shared';
import { apiError, bodyOf, callsTo, mockApi, renderPage } from '@/test/render';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const { default: SlidesAdminPage } = await import('./SlidesAdminPage');

const slide = (id: string, order: number) => ({ id, title: `資料${id}`, fileName: `${id}.pdf`, size: 1024, order });
const makeFile = (name: string, type: string, size: number) => {
  const file = new File(['%PDF-1.7'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};
const choose = (file: File) => fireEvent.change(screen.getByLabelText('ファイル'), { target: { files: [file] } });
const upload = () => fireEvent.click(screen.getByRole('button', { name: 'アップロード' }));
const S3 = 'https://bucket.s3.ap-northeast-1.amazonaws.com/';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('SlidesAdminPage upload (A-02)', () => {
  it.each([
    ['50MB + 1 byte', makeFile('big.pdf', 'application/pdf', SLIDE_MAX_BYTES + 1), 'ファイルサイズは 50MB 以下にしてください'],
    ['extension mismatch', makeFile('deck.pptx', 'application/pdf', 10), '拡張子が .pdf のファイルを選択してください'],
    ['MIME mismatch', makeFile('deck.pdf', 'application/x-msdownload', 10), 'PDF ファイル（application/pdf）を選択してください'],
  ])('rejects %s before calling the API', async (_label, file, message) => {
    const fetchMock = mockApi({ 'GET /api/slides': [] });
    renderPage(<SlidesAdminPage />);
    choose(file);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    upload();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(callsTo(fetchMock, 'POST /api/slides/upload-url')).toHaveLength(0);
  });

  it('requires a file and a title', async () => {
    mockApi({ 'GET /api/slides': [] });
    renderPage(<SlidesAdminPage />);
    upload();
    expect(await screen.findByRole('alert')).toHaveTextContent('タイトルは1〜100文字で入力してください');
    fireEvent.change(screen.getByLabelText('タイトル'), { target: { value: '資料' } });
    upload();
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF ファイルを選択してください');
  });

  it('uploads exactly 50MB via presigned POST and completes', async () => {
    const fetchMock = mockApi({
      'GET /api/slides': [],
      'POST /api/slides/upload-url': { slideId: 's1', url: S3, fields: { key: 'slides/s1.pdf', Policy: 'p' } },
      [`POST ${S3}`]: new Response(null, { status: 204 }),
      'POST /api/slides/s1/complete': slide('s1', 0),
    });
    renderPage(<SlidesAdminPage />);
    choose(makeFile('Deck Final.PDF', 'application/pdf', SLIDE_MAX_BYTES));
    expect(screen.getByLabelText('タイトル')).toHaveValue('Deck Final');
    expect(screen.getByText('Deck Final.PDF（50.0 MB）')).toBeInTheDocument();
    upload();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('スライドを公開しました'));
    expect(bodyOf(callsTo(fetchMock, 'POST /api/slides/upload-url')[0])).toEqual({ title: 'Deck Final', fileName: 'Deck Final.PDF', size: SLIDE_MAX_BYTES, contentType: 'application/pdf' });
    const form = (callsTo(fetchMock, `POST ${S3}`)[0]?.[1] as RequestInit).body as FormData;
    expect([...form.keys()]).toEqual(['key', 'Policy', 'file']);
    expect(new Headers((callsTo(fetchMock, `POST ${S3}`)[0]?.[1] as RequestInit).headers).get('X-Auth-Token')).toBeNull();
    expect(callsTo(fetchMock, 'POST /api/slides/s1/complete')).toHaveLength(1);
    expect(screen.getByLabelText('タイトル')).toHaveValue('');
  });

  it('reports S3 and API failures', async () => {
    mockApi({
      'GET /api/slides': [],
      'POST /api/slides/upload-url': { slideId: 's1', url: S3, fields: {} },
      [`POST ${S3}`]: new Response('denied', { status: 403 }),
    });
    renderPage(<SlidesAdminPage />);
    choose(makeFile('a.pdf', 'application/pdf', 10));
    upload();
    expect(await screen.findByRole('alert')).toHaveTextContent('ファイルのアップロードに失敗しました');
    mockApi({ 'GET /api/slides': [], 'POST /api/slides/upload-url': apiError(400, 'VALIDATION_ERROR', 'PDF のみ') });
    upload();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('PDF のみ'));
  });

  it('keeps a typed title when choosing a file', () => {
    mockApi({ 'GET /api/slides': [] });
    renderPage(<SlidesAdminPage />);
    fireEvent.change(screen.getByLabelText('タイトル'), { target: { value: '手入力' } });
    choose(makeFile('a.pdf', 'application/pdf', 10));
    expect(screen.getByLabelText('タイトル')).toHaveValue('手入力');
    fireEvent.change(screen.getByLabelText('ファイル'), { target: { files: [] } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('SlidesAdminPage list (A-02)', () => {
  it('reorders with keyboard-accessible up/down buttons', async () => {
    const fetchMock = mockApi({ 'GET /api/slides': [slide('a', 0), slide('b', 1), slide('c', 2)], 'PUT /api/slides/order': { success: true } });
    renderPage(<SlidesAdminPage />);
    expect(await screen.findByRole('button', { name: '資料a を上へ移動' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '資料c を下へ移動' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '資料b を上へ移動' }));
    await waitFor(() => expect(callsTo(fetchMock, 'PUT /api/slides/order')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, 'PUT /api/slides/order')[0])).toEqual({ ids: ['b', 'a', 'c'] });
    fireEvent.click(screen.getByRole('button', { name: '資料a を下へ移動' }));
    await waitFor(() => expect(callsTo(fetchMock, 'PUT /api/slides/order')).toHaveLength(2));
  });

  it('rolls back the order on failure', async () => {
    mockApi({ 'GET /api/slides': [slide('a', 0), slide('b', 1)], 'PUT /api/slides/order': apiError(500, 'X', '並べ替え失敗') });
    renderPage(<SlidesAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '資料b を上へ移動' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('並べ替え失敗'));
    const items = within(screen.getByRole('list', { name: 'スライドの表示順' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('資料a');
  });

  it('renames and deletes with confirmation', async () => {
    const fetchMock = mockApi({ 'GET /api/slides': [slide('a', 0)], 'PATCH /api/slides/a': slide('a', 0), 'DELETE /api/slides/a': { success: true } });
    renderPage(<SlidesAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '資料a のタイトルを変更' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('タイトル'), { target: { value: '改題' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(bodyOf(callsTo(fetchMock, 'PATCH /api/slides/a')[0])).toEqual({ title: '改題' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '資料a を削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('スライドを削除しました'));
    expect(callsTo(fetchMock, 'DELETE /api/slides/a')).toHaveLength(1);
  });

  it('shows rename and delete errors', async () => {
    mockApi({ 'GET /api/slides': [slide('a', 0)], 'PATCH /api/slides/a': apiError(400, 'V', '改題失敗'), 'DELETE /api/slides/a': apiError(500, 'X', '削除失敗') });
    renderPage(<SlidesAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '資料a のタイトルを変更' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('改題失敗'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '資料a を削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('削除失敗'));
  });

  it('shows empty and error states', async () => {
    mockApi({ 'GET /api/slides': [] });
    const { unmount } = renderPage(<SlidesAdminPage />);
    expect(await screen.findByText('スライドはまだありません')).toBeInTheDocument();
    unmount();
    mockApi({ 'GET /api/slides': apiError(500, 'X', '取得失敗') });
    renderPage(<SlidesAdminPage />);
    expect(await screen.findByText('取得失敗')).toBeInTheDocument();
  });
});
