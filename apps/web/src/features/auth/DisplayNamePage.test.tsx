import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, useLocation } from 'react-router';
import { apiError, bodyOf, callsTo, makeAuth, makeMe, mockApi, renderPage } from '@/test/render';
import DisplayNamePage from './DisplayNamePage';

function Where() { return <p>at:{useLocation().pathname}</p>; }
const routes = <><Route path="/watch" element={<Where />} /><Route path="/send/mic" element={<Where />} /></>;
const open = (ctx = makeAuth()) => {
  renderPage(<DisplayNamePage />, { auth: ctx, path: '/display-name', route: '/display-name', extraRoutes: routes });
  return ctx;
};
const input = () => screen.getByLabelText('表示名');
const submit = () => fireEvent.click(screen.getByRole('button', { name: '決定' }));

afterEach(() => vi.unstubAllGlobals());

describe('DisplayNamePage (C-03)', () => {
  it('prefills the previous display name', () => {
    open(makeAuth({ me: makeMe({ displayName: '前回の名前' }) }));
    expect(input()).toHaveValue('前回の名前');
    expect(screen.getByText(/5 \/ 20 文字/)).toBeInTheDocument();
  });

  it('starts empty when no name was set', () => {
    open(makeAuth({ me: makeMe({ displayName: null }) }));
    expect(input()).toHaveValue('');
  });

  it('rejects 0 and 21 characters', async () => {
    const fetchMock = mockApi({});
    open();
    fireEvent.change(input(), { target: { value: '' } });
    submit();
    expect(await screen.findByText('入力してください')).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: 'あ'.repeat(21) } });
    submit();
    expect(await screen.findByText('20文字以内で入力してください')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([['あ'], ['あ'.repeat(20)]])('accepts %s and moves to the role page', async (name) => {
    const fetchMock = mockApi({ 'PUT /api/me/display-name': { displayName: name } });
    const ctx = open(makeAuth({ refresh: vi.fn(async () => makeMe({ role: 'audio', displayName: name })) }));
    fireEvent.change(input(), { target: { value: name } });
    submit();
    expect(await screen.findByText('at:/send/mic')).toBeInTheDocument();
    expect(bodyOf(callsTo(fetchMock, 'PUT /api/me/display-name')[0])).toEqual({ displayName: name });
    expect(ctx.refresh).toHaveBeenCalled();
  });

  it('trims the name before saving', async () => {
    const fetchMock = mockApi({ 'PUT /api/me/display-name': {} });
    open();
    fireEvent.change(input(), { target: { value: '  たなか  ' } });
    submit();
    await screen.findByText('at:/watch');
    expect(bodyOf(callsTo(fetchMock, 'PUT /api/me/display-name')[0])).toEqual({ displayName: 'たなか' });
  });

  it('shows server-side NG word errors', async () => {
    mockApi({ 'PUT /api/me/display-name': apiError(400, 'NG_WORD', 'NGワードを含む表示名は使えません') });
    open();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('NGワードを含む表示名は使えません');
  });

  it('stays when the profile refresh fails', async () => {
    mockApi({ 'PUT /api/me/display-name': {} });
    const ctx = open(makeAuth({ refresh: vi.fn(async () => null) }));
    submit();
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
    expect(screen.queryByText(/at:/)).not.toBeInTheDocument();
  });
});
