import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, bodyOf, callsTo, makeAuth, makeMe, mockApi, renderPage } from '@/test/render';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const { default: UsersAdminPage } = await import('./UsersAdminPage');

const user = (userId: string, overrides = {}) => ({ userId, email: `${userId}@example.com`, loginMethod: 'email', role: 'viewer', enabled: true, commentSuspended: false, lastLoginAt: '2026-10-19T00:05:00.000Z', ...overrides });
const admin = makeAuth({ me: makeMe({ userId: 'me', role: 'admin' }) });
const users = [user('me', { role: 'admin' }), user('u1', { loginMethod: 'Okta', lastLoginAt: null }), user('u2', { enabled: false })];
const emails = () => screen.getByLabelText('メールアドレス');
const invite = () => fireEvent.click(screen.getByRole('button', { name: '招待する' }));
const rowOf = (email: string) => screen.getByText(email).closest('tr') as HTMLElement;
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('UsersAdminPage invite (A-05)', () => {
  it('validates email format and shows counts', async () => {
    const fetchMock = mockApi({ 'GET /api/users': [] });
    renderPage(<UsersAdminPage />, { auth: admin });
    invite();
    expect(await screen.findByRole('alert')).toHaveTextContent('メールアドレスを1件以上入力してください');
    fireEvent.change(emails(), { target: { value: 'a@example.com\nnot-an-email' } });
    expect(screen.getByText(/有効 1 件/)).toBeInTheDocument();
    expect(screen.getByText('・形式エラー 1 件')).toBeInTheDocument();
    invite();
    expect(screen.getByRole('alert')).toHaveTextContent('形式が正しくないメールアドレスがあります: not-an-email');
    expect(callsTo(fetchMock, 'POST /api/users/invite')).toHaveLength(0);
  });

  it('invites multiple addresses with the default viewer role', async () => {
    const fetchMock = mockApi({ 'GET /api/users': [], 'POST /api/users/invite': ({ body }: { body?: BodyInit | null }) => ({ invited: JSON.parse(String(body)).emails, failed: [] }) });
    renderPage(<UsersAdminPage />, { auth: admin });
    fireEvent.change(emails(), { target: { value: 'a@example.com, b@example.com' } });
    invite();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 件の招待メールを送信しました'));
    expect(bodyOf(callsTo(fetchMock, 'POST /api/users/invite')[0])).toEqual({ emails: ['a@example.com', 'b@example.com'], role: 'viewer' });
    expect(emails()).toHaveValue('');
  });

  it('splits more than 100 addresses into batches', async () => {
    const fetchMock = mockApi({ 'GET /api/users': [], 'POST /api/users/invite': ({ body }: { body?: BodyInit | null }) => ({ invited: JSON.parse(String(body)).emails, failed: [] }) });
    renderPage(<UsersAdminPage />, { auth: admin });
    fireEvent.change(emails(), { target: { value: Array.from({ length: 101 }, (_, i) => `u${i}@example.com`).join('\n') } });
    invite();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('101 件の招待メールを送信しました'));
    const calls = callsTo(fetchMock, 'POST /api/users/invite');
    expect(calls.map((call) => bodyOf(call).emails.length)).toEqual([100, 1]);
  });

  it('imports addresses from CSV', async () => {
    mockApi({ 'GET /api/users': [] });
    renderPage(<UsersAdminPage />, { auth: admin });
    fireEvent.change(emails(), { target: { value: 'x@example.com' } });
    const file = new File(['名前,メールアドレス\nたなか,a@example.com\nすずき,bad'], 'users.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => '名前,メールアドレス\nたなか,a@example.com\nすずき,bad' });
    fireEvent.change(screen.getByLabelText('CSV から読み込む'), { target: { files: [file] } });
    await waitFor(() => expect(emails()).toHaveValue('x@example.com\na@example.com\nbad'));
    fireEvent.change(screen.getByLabelText('CSV から読み込む'), { target: { files: [] } });
    expect(emails()).toHaveValue('x@example.com\na@example.com\nbad');
  });

  it('chooses a role for the invitation', async () => {
    const fetchMock = mockApi({ 'GET /api/users': [], 'POST /api/users/invite': { invited: ['a@example.com'], failed: [] } });
    renderPage(<UsersAdminPage />, { auth: admin });
    fireEvent.change(emails(), { target: { value: 'a@example.com' } });
    fireEvent.keyDown(screen.getByLabelText('ロール'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'カメラ担当' }));
    invite();
    await waitFor(() => expect(bodyOf(callsTo(fetchMock, 'POST /api/users/invite')[0])).toEqual({ emails: ['a@example.com'], role: 'camera' }));
  });

  it('shows partial success: invited count and each failed address with its reason (R1-11)', async () => {
    mockApi({
      'GET /api/users': [],
      'POST /api/users/invite': { invited: ['a@example.com'], failed: [{ email: 'b@example.com', reason: 'ALREADY_EXISTS' }, { email: 'c@example.com', reason: 'FAILED' }] },
    });
    renderPage(<UsersAdminPage />, { auth: admin });
    fireEvent.change(emails(), { target: { value: 'a@example.com\nb@example.com\nc@example.com' } });
    invite();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 件の招待メールを送信しました'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('2 件は招待できませんでした');
    const list = within(alert).getByRole('list', { name: '招待できなかったアドレス' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['b@example.com：すでに登録されています', 'c@example.com：送信に失敗しました']);
    expect(emails()).toHaveValue('b@example.com\nc@example.com');
  });

  it('keeps earlier batches when a later batch fails (R1-11)', async () => {
    let call = 0;
    mockApi({
      'GET /api/users': [],
      'POST /api/users/invite': ({ body }: { body?: BodyInit | null }) => {
        call += 1;
        return call === 1 ? { invited: JSON.parse(String(body)).emails, failed: [] } : apiError(500, 'X', '失敗');
      },
    });
    renderPage(<UsersAdminPage />, { auth: admin });
    fireEvent.change(emails(), { target: { value: Array.from({ length: 101 }, (_, i) => `u${i}@example.com`).join('\n') } });
    invite();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('100 件の招待メールを送信しました'));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 件は招待できませんでした');
    expect(emails()).toHaveValue('u100@example.com');
  });

  it('shows invite errors', async () => {
    mockApi({ 'GET /api/users': [], 'POST /api/users/invite': apiError(400, 'V', '招待失敗') });
    renderPage(<UsersAdminPage />, { auth: admin });
    fireEvent.change(emails(), { target: { value: 'a@example.com' } });
    invite();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('招待失敗'));
  });
});

describe('UsersAdminPage list (A-05)', () => {
  it('lists users with login method, role, last login and status', async () => {
    mockApi({ 'GET /api/users': users });
    renderPage(<UsersAdminPage />, { auth: admin });
    await screen.findByText('u1@example.com');
    expect(within(rowOf('u1@example.com')).getByText('Okta')).toBeInTheDocument();
    expect(within(rowOf('u1@example.com')).getByText('—')).toBeInTheDocument();
    expect(within(rowOf('u2@example.com')).getByText('メール')).toBeInTheDocument();
    expect(within(rowOf('u2@example.com')).getByText('無効')).toBeInTheDocument();
    expect(within(rowOf('me@example.com')).getByText('（自分）')).toBeInTheDocument();
    expect(within(rowOf('me@example.com')).getByRole('button', { name: '無効化' })).toBeDisabled();
    expect(within(rowOf('me@example.com')).getByRole('button', { name: 'me@example.com を削除' })).toBeDisabled();
    expect(within(rowOf('me@example.com')).getByRole('combobox')).toBeDisabled();
  });

  it('changes roles', async () => {
    const fetchMock = mockApi({ 'GET /api/users': users, 'PUT /api/users/u1/role': { userId: 'u1', role: 'presenter', enabled: true } });
    renderPage(<UsersAdminPage />, { auth: admin });
    await screen.findByText('u1@example.com');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'u1@example.com のロール' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: '登壇者' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ロールを変更しました'));
    expect(bodyOf(callsTo(fetchMock, 'PUT /api/users/u1/role')[0])).toEqual({ role: 'presenter' });
  });

  it('disables (with confirmation), enables and deletes users', async () => {
    const fetchMock = mockApi({
      'GET /api/users': users, 'POST /api/users/u1/disable': { success: true }, 'POST /api/users/u2/enable': { success: true }, 'DELETE /api/users/u1': { success: true },
    });
    renderPage(<UsersAdminPage />, { auth: admin });
    await screen.findByText('u1@example.com');
    fireEvent.click(within(rowOf('u1@example.com')).getByRole('button', { name: '無効化' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '無効化' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/users/u1/disable')).toHaveLength(1));
    fireEvent.click(within(rowOf('u2@example.com')).getByRole('button', { name: '有効化' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/users/u2/enable')).toHaveLength(1));
    fireEvent.click(within(rowOf('u1@example.com')).getByRole('button', { name: 'u1@example.com を削除' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ユーザーを削除しました'));
  });

  it('shows list and mutation errors', async () => {
    mockApi({ 'GET /api/users': apiError(500, 'X', '一覧失敗') });
    const { unmount } = renderPage(<UsersAdminPage />, { auth: admin });
    expect(await screen.findByText('一覧失敗')).toBeInTheDocument();
    unmount();
    mockApi({ 'GET /api/users': users, 'POST /api/users/u2/enable': apiError(500, 'X', '有効化失敗') });
    renderPage(<UsersAdminPage />, { auth: admin });
    await screen.findByText('u2@example.com');
    fireEvent.click(within(rowOf('u2@example.com')).getByRole('button', { name: '有効化' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('有効化失敗'));
  });
});
