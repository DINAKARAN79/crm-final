import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeState = vi.hoisted(() => ({ value: '/home' }));
const searchState = vi.hoisted(() => ({ value: '' }));
const authState = vi.hoisted(() => ({
  profileName: 'Superadmin',
  isSuperAdmin: false,
}));
const logoutMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const profileApiMock = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue({ data: [] }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => routeState.value,
  useSearchParams: () => new URLSearchParams(searchState.value),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'user-1', firstName: 'Admin', lastName: 'User', email: 'admin@example.test', phone: '1234567890' },
    profile: authState.isSuperAdmin ? null : { id: 'profile-admin', name: authState.profileName, description: 'Platform administrator' },
    roles: ['Administrator'],
    tenant: { id: 'tenant-1', name: 'Test Company', slug: 'test-company' },
    logout: logoutMock,
    isAdmin: true,
    isSuperAdmin: authState.isSuperAdmin,
  }),
}));

vi.mock('@/lib/api', () => ({
  profileApi: profileApiMock,
}));

vi.mock('@/components/crm/search-dialog', () => ({
  SearchDialog: () => null,
}));

import { Header } from '../components/layout/header';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
if (!window.HTMLElement.prototype.hasPointerCapture) {
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.setPointerCapture = () => undefined;
  window.HTMLElement.prototype.releasePointerCapture = () => undefined;
}

describe('Header admin home refresh', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    routeState.value = '/home';
    searchState.value = '';
    authState.profileName = 'Superadmin';
    authState.isSuperAdmin = false;
    logoutMock.mockClear();
    profileApiMock.list.mockResolvedValue({ data: [] });
  });

  it('loads profiles on mount and refreshes them when the dropdown opens', async () => {
    const { rerender, getByRole } = render(<Header onMenuClick={() => undefined} />);

    await waitFor(() => {
      expect(profileApiMock.list).toHaveBeenCalledWith({ limit: 100 });
    });

    routeState.value = '/admin/customize-home';
    rerender(<Header onMenuClick={() => undefined} />);
    expect(profileApiMock.list).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(getByRole('button', { name: /Admin Home/i }), { key: 'Enter' });

    await waitFor(() => {
      expect(profileApiMock.list).toHaveBeenCalledTimes(2);
    });
  });

  it('shows an inline message for a profile permission denial without logging an error', async () => {
    profileApiMock.list.mockRejectedValue({ response: { status: 403 } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getByRole, findByText } = render(<Header onMenuClick={() => undefined} />);

    await waitFor(() => {
      expect(profileApiMock.list).toHaveBeenCalled();
    });
    const adminHomeTrigger = getByRole('button', { name: /Admin Home/i });
    adminHomeTrigger.focus();
    fireEvent.keyDown(adminHomeTrigger, { key: 'Enter' });

    expect(await findByText('You do not have permission to view profiles')).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not show a custom homepages label for a selected homepage', async () => {
    searchState.value = 'homepage=homepage-1';
    const { getByRole } = render(<Header onMenuClick={() => undefined} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getByRole('button', { name: /Admin Home/i })).toBeTruthy();
  });

  it.each([
    ['Superadmin', true],
    ['Admin', false],
    ['System Admin', false],
  ])('shows the user name beside the avatar and in the user menu for %s', async (name, isSuperAdmin) => {
    authState.profileName = name;
    authState.isSuperAdmin = isSuperAdmin;
    const { getByRole, getAllByText, findByRole, getAllByRole, queryByText, queryByRole } = render(
      <Header onMenuClick={() => undefined} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(getAllByText('Admin User').length).toBeGreaterThan(0);
    expect(queryByText('user-1')).toBeNull();
    expect(queryByText(name)).toBeNull();
    expect(queryByText('admin@example.test')).toBeNull();
    const userMenuTrigger = getByRole('button', { name: 'Open user menu' });
    userMenuTrigger.focus();
    fireEvent.keyDown(userMenuTrigger, { key: 'Enter' });
    const profileMenuItem = await findByRole('menuitem', { name: 'Admin User' });
    expect(getAllByRole('menuitem')).toHaveLength(3);
    expect(queryByRole('menuitem', { name: 'Sessions' })).toBeTruthy();
    expect(queryByRole('menuitem', { name: 'Account details' })).toBeNull();
    fireEvent.click(profileMenuItem);

    expect(getByRole('dialog')).toBeTruthy();
    expect(getByRole('heading', { name: 'Name' })).toBeTruthy();
    expect(getAllByText('Admin User').length).toBeGreaterThan(0);
    expect(queryByText('user-1')).toBeNull();
    expect(queryByText('admin@example.test')).toBeNull();
    expect(queryByText('1234567890')).toBeNull();
    expect(queryByText('Platform administrator')).toBeNull();
    expect(queryByText(name)).toBeNull();
    expect(queryByText('Test Company')).toBeNull();
    expect(queryByText('Administrator')).toBeNull();
  });

  it('keeps logout available in the profile menu', async () => {
    const { getByRole, findByRole } = render(
      <Header onMenuClick={() => undefined} />,
    );
    const userMenuTrigger = getByRole('button', { name: 'Open user menu' });
    userMenuTrigger.focus();
    fireEvent.keyDown(userMenuTrigger, { key: 'Enter' });
    fireEvent.click(await findByRole('menuitem', { name: 'Log out' }));

    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1));
  });
});