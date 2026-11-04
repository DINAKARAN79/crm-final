import { beforeEach, describe, expect, it, vi } from 'vitest';

const permissionFindMany = vi.hoisted(() => vi.fn());

vi.mock('@dct-crm/db', () => ({
  prisma: {
    permission: {
      findMany: permissionFindMany,
    },
  },
}));

import {
  getMissingRequiredPermissionNames,
  REQUIRED_PERMISSION_NAMES,
  warnForMissingRequiredPermissions,
} from './requiredPermissionCatalog';

describe('required permission catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies required permission names absent from the active catalog', () => {
    expect(getMissingRequiredPermissionNames(['TELEPHONY_CALL', 'ENQUIRY_READ'])).toEqual(
      REQUIRED_PERMISSION_NAMES.filter((name) => !['TELEPHONY_CALL', 'ENQUIRY_READ'].includes(name)),
    );
  });

  it('logs one warning listing missing permission names', async () => {
    permissionFindMany.mockResolvedValue([{ name: 'TELEPHONY_CALL' }]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await warnForMissingRequiredPermissions();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain('Required permissions are missing');
    expect(warning.mock.calls[0]?.[0]).toContain('ENQUIRY_READ');
    warning.mockRestore();
  });

  it('reports the missing catalog table as one warning and lists required keys', async () => {
    permissionFindMany.mockRejectedValue({
      code: 'P2021',
      meta: { table: 'public.Permission' },
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await warnForMissingRequiredPermissions();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain('public."Permission" table is missing');
    expect(warning.mock.calls[0]?.[0]).toContain('TELEPHONY_CALL');
    warning.mockRestore();
  });
});
