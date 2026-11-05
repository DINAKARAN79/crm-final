import { prisma } from '@dct-crm/db';
import type { AuthRequest } from '../middleware/auth';
import {
  compileListFilters,
  defaultViewKey,
  emptyFilters,
  isListModule,
  publicFields,
  systemViewByKey,
  systemViewsFor,
  validateFilterSet,
  type FilterSet,
  type ListModule,
} from './listViewCatalog';

export { listOrderBy } from './listViewCatalog';

type Actor = { id: string; tenantId: string; isAdmin?: boolean; isSuperAdmin?: boolean };

const canManage = (actor: Actor, createdById: string) =>
  actor.isSuperAdmin || actor.isAdmin || actor.id === createdById;

export async function listViewCatalog(actor: Actor, module: ListModule) {
  const [saved, preference, pins, recents, users] = await Promise.all([
    prisma.savedListView.findMany({
      where: {
        tenantId: actor.tenantId,
        module,
        OR: [
          { visibility: 'ALL_USERS' },
          { createdById: actor.id },
          { shares: { some: { userId: actor.id } } },
          ...(actor.isAdmin || actor.isSuperAdmin ? [{ visibility: 'ONLY_ME' }, { visibility: 'SELECTED_USERS' }] : []),
        ],
      },
      include: { shares: { select: { userId: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.listViewPreference.findUnique({ where: { tenantId_userId_module: { tenantId: actor.tenantId, userId: actor.id, module } } }),
    prisma.listViewPin.findMany({ where: { tenantId: actor.tenantId, userId: actor.id, module }, select: { viewKey: true } }),
    prisma.listViewRecent.findMany({ where: { tenantId: actor.tenantId, userId: actor.id, module }, orderBy: { usedAt: 'desc' }, take: 8 }),
    prisma.user.findMany({
      where: { tenantId: actor.tenantId, isActive: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 200,
    }),
  ]);

  const views = [
    ...systemViewsFor(module).map((item) => ({
      key: item.key,
      name: item.name,
      apiName: item.apiName,
      module,
      system: true,
      visibility: 'ALL_USERS' as const,
      filters: item.filters,
      sharedUserIds: [] as string[],
      canEdit: false,
      canDelete: false,
      canDuplicate: true,
      presetLabel: item.presetLabel || null,
    })),
    ...saved.map((item) => {
      const stored = validateFilterSet(module, item.filters);
      return {
      key: item.id,
      name: item.name,
      apiName: item.apiName,
      module,
      system: false,
      visibility: item.visibility,
      filters: stored.ok ? stored.filters : emptyFilters(),
      sharedUserIds: item.shares.map((share) => share.userId),
      canEdit: canManage(actor, item.createdById),
      canDelete: canManage(actor, item.createdById),
      canDuplicate: true,
      presetLabel: null,
    };
    }),
  ];
  const fields = publicFields(module);
  if (module === 'LEAD') {
    const leadInterest = await prisma.fieldDefinition.findFirst({
      where: {
        tenantId: actor.tenantId,
        name: 'leadInterest',
        fieldType: 'picklist',
        isActive: true,
        object: {
          is: {
            tenantId: actor.tenantId,
            name: { equals: 'Lead', mode: 'insensitive' },
          },
        },
      },
      select: {
        picklistValues: {
          where: { isActive: true },
          select: { value: true, label: true },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });
    const interestField = fields.find((field) => field.key === 'leadInterest');
    if (interestField) {
      interestField.options = leadInterest?.picklistValues || [];
    }
  }
  const keys = new Set(views.map((item) => item.key));
  const selectedKey = preference && keys.has(preference.viewKey) ? preference.viewKey : defaultViewKey(module);
  return {
    module,
    views,
    fields,
    users: users.map((user) => ({ id: user.id, name: `${user.firstName} ${user.lastName}`.trim() })),
    selectedKey,
    pinnedKeys: pins.map((pin) => pin.viewKey).filter((key) => keys.has(key)),
    recentKeys: recents.map((recent) => recent.viewKey).filter((key) => keys.has(key)),
  };
}

async function visibleSaved(actor: Actor, module: ListModule, id: string) {
  const view = await prisma.savedListView.findFirst({
    where: { id, tenantId: actor.tenantId, module },
    include: { shares: { select: { userId: true } } },
  });
  if (!view) return null;
  const shared = view.shares.some((share) => share.userId === actor.id);
  const visible = actor.isAdmin || actor.isSuperAdmin || view.createdById === actor.id || view.visibility === 'ALL_USERS' || shared;
  return visible ? view : null;
}

export async function listViewConstraint(req: AuthRequest, module: ListModule) {
  const viewKey = typeof req.query.view === 'string' ? req.query.view.trim() : '';
  const filtersRaw = typeof req.query.filters === 'string' ? req.query.filters : '';
  if (!viewKey && !filtersRaw) return { ok: true as const, where: null };
  if (!viewKey) return { ok: false as const, status: 400, error: 'Choose a list view' };
  const actor = { id: req.user!.id, tenantId: req.tenantId!, isAdmin: req.user!.isAdmin, isSuperAdmin: req.user!.isSuperAdmin };
  const system = systemViewByKey(module, viewKey);
  let filters = system?.filters ?? emptyFilters();
  let presets = system?.preset ? [system.preset] : [];
  if (!system) {
    if (viewKey.startsWith('system:')) return { ok: false as const, status: 404, error: 'That list view is not available for this module' };
    const saved = await visibleSaved(actor, module, viewKey);
    if (!saved) return { ok: false as const, status: 403, error: 'You do not have access to this list view' };
    const stored = validateFilterSet(module, saved.filters);
    filters = stored.ok ? stored.filters : emptyFilters();
    presets = [];
  }
  if (filtersRaw) {
    if (filtersRaw.length > 8000) return { ok: false as const, status: 400, error: 'Filters are too large' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(filtersRaw);
    } catch {
      return { ok: false as const, status: 400, error: 'Filters are invalid' };
    }
    const validated = validateFilterSet(module, parsed);
    if (!validated.ok) return { ok: false as const, status: 400, error: validated.error };
    filters = validated.filters;
  }
  const recentIds = presets.includes('recent')
    ? (await prisma.crmRecordView.findMany({
        where: { tenantId: actor.tenantId, userId: actor.id, module },
        orderBy: { viewedAt: 'desc' },
        take: 50,
        select: { recordId: true },
      })).map((row) => row.recordId)
    : [];
  return { ok: true as const, where: compileListFilters(module, filters, { userId: actor.id, recentIds, presets }) };
}

export function mergeListWhere(where: object, extra: Record<string, unknown> | null) {
  if (!extra || Object.keys(extra).length === 0) return where;
  const target = where as { AND?: unknown };
  const current = Array.isArray(target.AND) ? target.AND : target.AND ? [target.AND] : [];
  target.AND = [...current, extra];
  return where;
}

export function parseModule(value: unknown): ListModule | null {
  return typeof value === 'string' && isListModule(value) ? value : null;
}

const apiNamePattern = /^[a-z][a-z0-9_]{0,60}$/;

export function normalizeApiName(name: string, explicit?: string) {
  const source = (explicit?.trim() || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const prefixed = /^[a-z]/.test(source) ? source : `view_${source || 'list'}`;
  return prefixed.slice(0, 61);
}

export function assertApiName(value: string) {
  return apiNamePattern.test(value);
}

export async function rememberView(actor: Actor, module: ListModule, viewKey: string) {
  await prisma.$transaction([
    prisma.listViewPreference.upsert({
      where: { tenantId_userId_module: { tenantId: actor.tenantId, userId: actor.id, module } },
      create: { tenantId: actor.tenantId, userId: actor.id, module, viewKey },
      update: { viewKey },
    }),
    prisma.listViewRecent.upsert({
      where: { tenantId_userId_module_viewKey: { tenantId: actor.tenantId, userId: actor.id, module, viewKey } },
      create: { tenantId: actor.tenantId, userId: actor.id, module, viewKey, usedAt: new Date() },
      update: { usedAt: new Date() },
    }),
  ]);
}

export type { FilterSet };
