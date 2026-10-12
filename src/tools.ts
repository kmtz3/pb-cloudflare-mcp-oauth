/**
 * Read-only Productboard tools. No Cloudflare-specific imports, so the same code runs
 * in the Worker and in the live test script (test/live-tools.ts).
 *
 * Raw v2 list pages are large (100 features ≈ 700 KB, custom fields keyed by UUID), so
 * list tools return compact rows and get tools return fields under their display names.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { z } from 'zod';

export interface PbConfig {
  region: string;              // "us" | "eu"
}

type Json = any;

export const pbApiBase = (region: string) =>
  region === 'eu' ? 'https://api.eu.productboard.com' : 'https://api.productboard.com';

/** Read-only GET against the Productboard v2 API. */
async function pbGet(cfg: PbConfig, token: string, path: string, query?: Record<string, string | string[] | undefined>): Promise<Json> {
  const url = new URL(`${pbApiBase(cfg.region)}/v2${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === '') continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  // Note: a pageCursor alone drops the filters, so every page re-sends the full query.
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  // Rate limited: wait as told (or 1s, 2s, 4s) and retry up to 3 times.
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
    const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt, 8000);
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  }
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 ? ' (Productboard token expired or revoked — reconnect the MCP server)' :
      res.status === 403 ? ' (missing scope or permission in Productboard)' :
      res.status === 429 ? ' (rate limited — retry shortly)' : '';
    throw new Error(`Productboard API ${res.status}${hint}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

// ── Output shaping ────────────────────────────────────────────────────────────

const MAX_CHARS = 60_000;

function stripHtml(html: string, max: number): string {
  const text = html
    .replace(/<(br|\/p|\/h\d|\/li|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** {id,name} → name, {email} → email, {value} → value, arrays mapped; HTML flattened. */
function simple(v: Json, maxText = 20_000): Json {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => simple(x, maxText));
  if (typeof v === 'string') return /<\/?[a-z][^>]*>/i.test(v) ? stripHtml(v, maxText) : v;
  if (typeof v !== 'object') return v;
  if ('status' in v && 'mode' in v && ('lastUpdatedAt' in v || 'previousStatus' in v)) return healthValue(v);
  if ('name' in v && typeof v.name === 'string') return v.name;
  if ('email' in v && typeof v.email === 'string') return v.email;
  if ('value' in v) return simple(v.value, maxText);
  if ('start' in v || 'end' in v) return { start: v.start ?? null, end: v.end ?? null };
  return v;
}

/** pageCursor from a links.next URL. */
function nextCursor(d: Json): string | null {
  const next = d?.links?.next;
  if (!next) return null;
  try { return new URL(next).searchParams.get('pageCursor'); } catch { return null; }
}

/** Accept either a bare cursor or the full links.next URL. */
function normCursor(c?: string): string | undefined {
  if (!c) return undefined;
  if (!c.startsWith('http')) return c;
  try { return new URL(c).searchParams.get('pageCursor') ?? undefined; } catch { return c; }
}

/** Serialize; if too big, drop list items (never cut mid-JSON) and say so. */
function result(obj: Json) {
  let text = JSON.stringify(obj, null, 1);
  if (text.length > MAX_CHARS && Array.isArray(obj.items)) {
    const total = obj.items.length;
    while (text.length > MAX_CHARS && obj.items.length > 1) {
      obj.items = obj.items.slice(0, Math.floor(obj.items.length * 0.8));
      obj.truncated = `Showing ${obj.items.length} of ${total} items on this page to fit the response size; narrow the filters to see the rest.`;
      text = JSON.stringify(obj, null, 1);
    }
  }
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n…[truncated]`;
  return { content: [{ type: 'text' as const, text }] };
}

/** Scans stop at a page boundary once results reach this size, so nothing is dropped by result(). */
const SCAN_BUDGET = 45_000;
const overBudget = (items: Json[]) => JSON.stringify(items, null, 1).length > SCAN_BUDGET;
const clip = (v: Json) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v);

const page = (d: Json, items: Json[]) => ({ count: items.length, nextPageCursor: nextCursor(d), items });

const entityRow = (e: Json) => ({
  id: e.id, type: e.type, name: e.fields?.name,
  status: simple(e.fields?.status), owner: simple(e.fields?.owner), teams: simple(e.fields?.teams),
  archived: e.fields?.archived, url: e.links?.html,
});

const noteRow = (n: Json) => ({
  id: n.id, type: n.type, title: n.fields?.name,
  preview: typeof n.fields?.content === 'string' ? stripHtml(n.fields.content, 200) : undefined,
  owner: simple(n.fields?.owner), creator: simple(n.fields?.creator),
  processed: n.fields?.processed, archived: n.fields?.archived,
  createdAt: n.createdAt, updatedAt: n.updatedAt, url: n.links?.html,
});

// The public API reports dependency direction the opposite way to the Productboard UI: API "isBlockedBy"
// means "is blocking" in the UI, and vice versa (verified 2026-10-12 against the UI and the official MCP).
// Translate on every read and in relationship-type filters.
const UI_DIRECTION: Record<string, string> = { isBlocking: 'isBlockedBy', isBlockedBy: 'isBlocking' };
const flipDependency = (t?: string) => (t ? UI_DIRECTION[t] ?? t : t);

const relRow = (r: Json) => ({ relationship: flipDependency(r.type), targetType: r.target?.type, targetId: r.target?.id });

/** Health field → readable object. The public API has the current and previous status only, no history. */
function healthValue(h: Json) {
  return {
    status: h.status, mode: h.mode,
    comment: typeof h.comment === 'string' ? htmlToMarkdown(h.comment) || null : null,
    previousStatus: h.previousStatus ?? null,
    updatedAt: h.lastUpdatedAt ?? null, updatedBy: h.createdBy?.email ?? null,
  };
}

/** Rich text → readable markdown (headings, lists, links, emphasis, code, tables as rows). */
function htmlToMarkdown(html: string, max = 50_000): string {
  if (!html) return '';
  let s = html
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `).replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href, text) => `[${text || href}](${href})`)
    .replace(/<img [^>]*src="([^"]*)"[^>]*>/gi, (_, src) => `![image](${src})`)
    .replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**').replace(/<(em|i)>(.*?)<\/\1>/gi, '_$2_')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`').replace(/<pre[^>]*>/gi, '\n```\n').replace(/<\/pre>/gi, '\n```\n')
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' | ').replace(/<tr[^>]*>/gi, '\n| ').replace(/<\/tr>/gi, ' |')
    .replace(/<blockquote[^>]*>/gi, '\n> ')
    .replace(/<(br|hr)[^>]*>/gi, '\n').replace(/<\/(p|div|blockquote)>/gi, '\n\n');
  s = stripHtml(s, Number.MAX_SAFE_INTEGER).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max)}\n\n…[truncated at ${max} characters]` : s;
}

// ── Operator search ───────────────────────────────────────────────────────────
// The public API filters only by exact values joined with AND, so operators such as
// "contains" or "in the last 7 days" are applied here, over pages fetched from the API.

const OPERATORS = ['contains', 'not_contains', 'equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty',
  'gt', 'gte', 'lt', 'lte', 'before', 'after', 'in_last', 'in_next'] as const;
type Operator = typeof OPERATORS[number];

const conditionSchema = z.object({
  field: z.string().describe('Field display name or id, e.g. "name", "Status", "Owner", "createdAt", "updatedAt", "timeframe.startDate", or a custom field name'),
  operator: z.enum(OPERATORS),
  value: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Text, number or ISO date. in/not_in take a list. in_last/in_next take a period like "7 days", "2 weeks", "3 months". Omit for is_empty/is_not_empty.'),
});
type Condition = z.infer<typeof conditionSchema>;

/** "7 days" | "2 weeks" | "3 months" | "1 year" | "7" → milliseconds. */
function periodMs(v: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)?\s*$/i.exec(v);
  if (!m) throw new Error(`Invalid period "${v}" — use e.g. "7 days", "2 weeks", "3 months"`);
  const n = Number(m[1]); const u = (m[2] ?? 'd').toLowerCase()[0];
  return n * 86_400_000 * (u === 'w' ? 7 : u === 'm' ? 30 : u === 'y' ? 365 : 1);
}

function toDate(v: Json): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v); return Number.isNaN(t) ? null : t;
}

const isEmptyVal = (v: Json) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Evaluate one condition against a field value (already simplified). Arrays match if any element matches. */
function matches(value: Json, op: Operator, target: string | string[] | undefined, now: number): boolean {
  if (op === 'is_empty') return isEmptyVal(value);
  if (op === 'is_not_empty') return !isEmptyVal(value);
  if (op === 'not_contains' || op === 'not_equals' || op === 'not_in') {
    return !matches(value, op.replace('not_', '') as Operator, target, now);
  }
  if (Array.isArray(value)) return value.some((v) => matches(v, op, target, now));
  if (isEmptyVal(value)) return false;
  const want = Array.isArray(target) ? target : target === undefined ? [] : [target];
  const str = (typeof value === 'object' ? JSON.stringify(value) : String(value)).toLowerCase();
  switch (op) {
    case 'contains': return want.some((w) => str.includes(w.toLowerCase()));
    case 'equals': case 'in': return want.some((w) => str === w.toLowerCase());
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = Number(value), b = Number(want[0]);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        const da = toDate(value), db = toDate(want[0]);
        if (da === null || db === null) return false;
        return op === 'gt' ? da > db : op === 'gte' ? da >= db : op === 'lt' ? da < db : da <= db;
      }
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'before': case 'after': {
      const d = toDate(value), w = toDate(want[0]);
      if (d === null || w === null) return false;
      return op === 'before' ? d < w : d > w;
    }
    case 'in_last': case 'in_next': {
      const d = toDate(value); if (d === null) return false;
      const span = periodMs(want[0] ?? '7');
      return op === 'in_last' ? d <= now && d >= now - span : d >= now && d <= now + span;
    }
  }
  return false;
}

/** Read a field from an entity by display name, id, or built-in name; supports "field.subkey". */
function fieldValue(e: Json, field: string, names: Record<string, string>): Json {
  const [head, ...rest] = field.split('.');
  const key = head.toLowerCase();
  let raw: Json;
  if (key === 'createdat' || key === 'updatedat') raw = e[key === 'createdat' ? 'createdAt' : 'updatedAt'];
  else if (head in (e.fields ?? {})) raw = e.fields[head];
  else {
    const id = Object.keys(names).find((k) => names[k].toLowerCase() === key || k.toLowerCase() === key);
    raw = id ? e.fields?.[id] : undefined;
  }
  for (const sub of rest) raw = raw?.[sub];
  return typeof raw === 'string' && /<\/?[a-z][^>]*>/i.test(raw) ? stripHtml(raw, 100_000) : simple(raw);
}

/** Validate operators up front so a typo fails fast instead of matching nothing. */
function checkConditions(conds: Condition[]) {
  for (const c of conds) {
    if (!['is_empty', 'is_not_empty'].includes(c.operator) && (c.value === undefined || c.value === '')) {
      throw new Error(`Condition on "${c.field}" with operator ${c.operator} needs a value`);
    }
    if (c.operator === 'in_last' || c.operator === 'in_next') periodMs(String(c.value));
  }
}

// ── MCP server (read-only tools) ──────────────────────────────────────────────

const cursor = z.string().optional().describe('nextPageCursor from the previous response (omit for the first page)');
const uuid = z.string().uuid();
const bool = (b?: boolean) => (b === undefined ? undefined : String(b));
// GET /v2/entities ignores archived=false (returns archived items too), so only "true" is sent
// and "false" is applied here.
const archivedParam = (b?: boolean) => (b === true ? 'true' : undefined);
const archivedOk = (b: boolean | undefined, e: Json) => b !== false || e.fields?.archived !== true;

export function buildMcpServer(cfg: PbConfig, token: string): McpServer {
  const server = new McpServer(
    { name: 'productboard-readonly', version: '1.3.0' },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  const get = (path: string, query?: Record<string, string | string[] | undefined>) => pbGet(cfg, token, path, query);
  const run = <A>(fn: (a: A) => Promise<Json>) => async (a: A) => {
    try { return result(await fn(a)); }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] }; }
  };

  // Field display names per entity type, fetched once per request.
  const fieldNames = new Map<string, Promise<Record<string, string>>>();
  const namesFor = (type: string) => {
    if (!fieldNames.has(type)) {
      fieldNames.set(type, get(`/entities/configurations/${encodeURIComponent(type)}`)
        .then((d) => Object.fromEntries(Object.entries(d.data?.fields ?? {}).map(([id, f]: [string, Json]) => [id, f.name ?? id])))
        .catch(() => ({})));
    }
    return fieldNames.get(type)!;
  };
  const namedFields = async (type: string, fields: Json) => {
    const names = await namesFor(type);
    return Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [names[k] ?? k, simple(v)]));
  };

  // Names of related entities: one GET each (the API has no lookup by many ids), cached per request
  // and capped so a single call stays well inside Cloudflare's subrequest limit.
  const MAX_NAME_LOOKUPS = 40;
  const entityNames = new Map<string, Promise<string | null>>();
  const nameOf = (id: string) => {
    if (!entityNames.has(id)) entityNames.set(id, get(`/entities/${id}`).then((d) => d.data?.fields?.name ?? null).catch(() => null));
    return entityNames.get(id)!;
  };
  const withNames = async (rows: Json[]) => {
    const ids = [...new Set(rows.map((r) => r.targetId).filter(Boolean))] as string[];
    const lookup = new Set(ids.slice(0, MAX_NAME_LOOKUPS));
    const batch = [...lookup];
    for (let i = 0; i < batch.length; i += 6) await Promise.all(batch.slice(i, i + 6).map(nameOf));
    const items = await Promise.all(rows.map(async (r) => ({ ...r, targetName: lookup.has(r.targetId) ? await nameOf(r.targetId) : null })));
    return { items, namesTruncated: ids.length > MAX_NAME_LOOKUPS ? `Names resolved for the first ${MAX_NAME_LOOKUPS} of ${ids.length} related entities; use pb_get_entity for the rest.` : undefined };
  };
  /** Every relationship page of an entity or note (inline relationships are capped at 10). */
  const allRelationships = async (path: string, maxPages = 5) => {
    const out: Json[] = []; let cur: string | undefined; let n = 0;
    do { const d = await get(path, { pageCursor: cur }); out.push(...d.data); cur = nextCursor(d) ?? undefined; n++; } while (cur && n < maxPages);
    return { rows: out.map(relRow), complete: !cur };
  };

  server.registerTool('pb_list_entities', {
    description: 'List Productboard entities of one type (feature, subfeature, component, product, initiative, objective, keyResult, release, releaseGroup, company, user…). Returns compact rows (id, name, status, owner, teams, url); use pb_get_entity for all fields. Paginated: pass nextPageCursor back as pageCursor.',
    inputSchema: {
      type: z.string().describe('Entity type, e.g. "feature". pb_list_entity_configurations lists the types in this workspace.'),
      name: z.string().optional().describe('Filter by name (matches names containing this text)'),
      parentId: uuid.optional().describe('Only children of this entity'),
      statusName: z.string().optional().describe('Filter by status name, e.g. "In progress"'),
      ownerEmail: z.string().optional().describe('Filter by owner email'),
      archived: z.boolean().optional(),
      pageCursor: cursor,
    },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get('/entities', {
      'type[]': a.type, name: a.name, 'parent[id]': a.parentId, 'status[name]': a.statusName,
      'owner[email]': a.ownerEmail, archived: archivedParam(a.archived), pageCursor: normCursor(a.pageCursor),
    });
    return page(d, d.data.filter((e: Json) => archivedOk(a.archived, e)).map(entityRow));
  }));

  server.registerTool('pb_get_entity', {
    description: 'Get one Productboard entity by ID with all its fields under their display names (custom fields included), plus all its relationships with the related entities\' names. Health shows the current status, comment, previous status and who set it (the public API has no full health history). Set raw=true for the unmodified API response.',
    inputSchema: { id: uuid, raw: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get(`/entities/${a.id}`);
    if (a.raw) return d;
    const e = d.data;
    const [fields, rels] = await Promise.all([namedFields(e.type, e.fields), allRelationships(`/entities/${e.id}/relationships`)]);
    const named = await withNames(rels.rows);
    return {
      id: e.id, type: e.type, url: e.links?.html, fields,
      relationships: named.items,
      ...(named.namesTruncated ? { relationshipNamesNote: named.namesTruncated } : {}),
      ...(rels.complete ? {} : { relationshipsNote: 'More relationships exist; use pb_list_entity_relationships to page through them.' }),
    };
  }));

  server.registerTool('pb_list_entity_relationships', {
    description: 'List relationships of an entity with the related entities\' names: parent, child, link, isBlocking (this entity blocks the target), isBlockedBy (the target blocks this entity).',
    inputSchema: { id: uuid, type: z.string().optional().describe('parent | child | link | isBlockedBy | isBlocking'), pageCursor: cursor },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get(`/entities/${a.id}/relationships`, { type: flipDependency(a.type), pageCursor: normCursor(a.pageCursor) });
    const named = await withNames(d.data.map(relRow));
    return { ...page(d, named.items), ...(named.namesTruncated ? { note: named.namesTruncated } : {}) };
  }));

  server.registerTool('pb_list_entity_configurations', {
    description: 'Without a type: list the entity types in this workspace. With a type: list that type\'s fields (id, display name, data type), including custom fields.',
    inputSchema: { type: z.string().optional().describe('Entity type, e.g. "feature"') },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    if (!a.type) {
      const d = await get('/entities/configurations');
      return { types: d.data.map((c: Json) => ({ type: c.type, fieldCount: Object.keys(c.fields ?? {}).length })) };
    }
    const d = await get(`/entities/configurations/${encodeURIComponent(a.type)}`);
    return {
      type: d.data.type,
      fields: Object.entries(d.data.fields ?? {}).map(([id, f]: [string, Json]) => ({ id, name: f.name, dataType: f.schema?.type ?? f.schema?.$ref?.split('/').pop() ?? 'object' })),
    };
  }));

  server.registerTool('pb_list_notes', {
    description: 'List customer feedback notes, newest first. Returns compact rows with a 200-character preview; use pb_get_note for the full content. Dates are ISO 8601 (e.g. 2026-01-01T00:00:00Z). Paginated via pageCursor.',
    inputSchema: {
      createdFrom: z.string().optional(), createdTo: z.string().optional(),
      updatedFrom: z.string().optional(), updatedTo: z.string().optional(),
      ownerEmail: z.string().optional(),
      archived: z.boolean().optional(), processed: z.boolean().optional(),
      pageCursor: cursor,
    },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get('/notes', {
      createdFrom: a.createdFrom, createdTo: a.createdTo, updatedFrom: a.updatedFrom, updatedTo: a.updatedTo,
      'owner[email]': a.ownerEmail, archived: bool(a.archived), processed: bool(a.processed), pageCursor: normCursor(a.pageCursor),
    });
    return page(d, d.data.map(noteRow));
  }));

  server.registerTool('pb_get_note', {
    description: 'Get one feedback note by ID: full text content, fields, customer and linked entities. Set raw=true for the unmodified API response.',
    inputSchema: { id: uuid, raw: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get(`/notes/${a.id}`);
    if (a.raw) return d;
    const n = d.data;
    const { name, content, ...rest } = n.fields ?? {};
    return {
      id: n.id, type: n.type, url: n.links?.html, title: name,
      content: typeof content === 'string' ? htmlToMarkdown(content) : simple(content),
      fields: Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, simple(v)])),
      createdAt: n.createdAt, updatedAt: n.updatedAt, source: n.metadata?.source,
      relationships: (await withNames((await allRelationships(`/notes/${n.id}/relationships`)).rows)).items,
    };
  }));

  server.registerTool('pb_list_note_relationships', {
    description: 'List what a note is linked to, with names: its customer (user/company) and the features or other entities it is evidence for.',
    inputSchema: { id: uuid, pageCursor: cursor },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get(`/notes/${a.id}/relationships`, { pageCursor: normCursor(a.pageCursor) });
    const named = await withNames(d.data.map(relRow));
    return { ...page(d, named.items), ...(named.namesTruncated ? { note: named.namesTruncated } : {}) };
  }));

  server.registerTool('pb_list_members', {
    description: 'List workspace members (id, name, email, role).',
    inputSchema: { query: z.string().optional().describe('Search by name or email'), pageCursor: cursor },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get('/members', { query: a.query, pageCursor: normCursor(a.pageCursor) });
    return page(d, d.data.map((m: Json) => ({ id: m.id, ...m.fields })));
  }));

  server.registerTool('pb_list_teams', {
    description: 'List teams in the workspace (id, name, handle, description).',
    inputSchema: { query: z.string().optional(), pageCursor: cursor },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get('/teams', { query: a.query, pageCursor: normCursor(a.pageCursor) });
    return page(d, d.data.map((t: Json) => ({ id: t.id, ...Object.fromEntries(Object.entries(t.fields ?? {}).map(([k, v]) => [k, simple(v)])) })));
  }));

  // ── Search with operators ──────────────────────────────────────────────────

  const scanLimits = {
    limit: z.number().int().min(1).max(200).optional().describe('Stop scanning once this many matches are found (default 50). Scans also pause when the response gets large; continue with resumeCursor.'),
    maxPages: z.number().int().min(1).max(40).optional().describe('Max API pages to scan, 100 items each (default 10)'),
    pageCursor: z.string().optional().describe('resumeCursor from a previous search, to continue scanning'),
  };

  server.registerTool('pb_search_entities', {
    description: `Search entities of one type with operators, e.g. name contains "checkout", status in ["Planned","In progress"], updatedAt in_last "7 days", Owner is_empty, a custom number field gt 50.
Conditions are combined with AND. Operators: ${OPERATORS.join(', ')}.
Archived entities are excluded unless archived=true (or pass archived explicitly). statusName/ownerEmail/parentId are applied by Productboard before scanning, so use them to narrow large types. Returns compact rows plus the values of the fields you filtered on. If complete=false, pass resumeCursor as pageCursor to keep scanning.`,
    inputSchema: {
      type: z.string().describe('Entity type, e.g. "feature"'),
      conditions: z.array(conditionSchema).optional(),
      statusName: z.string().optional(), ownerEmail: z.string().optional(), parentId: uuid.optional(), archived: z.boolean().optional(),
      ...scanLimits,
    },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const conds = a.conditions ?? [];
    checkConditions(conds);
    const names = await namesFor(a.type);
    const known = new Set(['createdat', 'updatedat', ...Object.keys(names).map((k) => k.toLowerCase()), ...Object.values(names).map((n) => n.toLowerCase())]);
    const unknown = conds.map((c) => c.field).filter((f) => !known.has(f.split('.')[0].toLowerCase()));
    if (unknown.length) throw new Error(`Unknown field(s) for ${a.type}: ${unknown.join(', ')}. Use pb_list_entity_configurations with type="${a.type}" to see field names.`);

    const limit = a.limit ?? 50, maxPages = a.maxPages ?? 10, now = Date.now();
    const archived = a.archived ?? false;  // same default as Productboard's own search
    const items: Json[] = [];
    let cursor = normCursor(a.pageCursor), pages = 0, scanned = 0;
    do {
      const d = await get('/entities', {
        'type[]': a.type, 'status[name]': a.statusName, 'owner[email]': a.ownerEmail, 'parent[id]': a.parentId,
        archived: archivedParam(archived), pageCursor: cursor,
      });
      const hits = d.data
        .filter((e: Json) => archivedOk(archived, e) && conds.every((c) => matches(fieldValue(e, c.field, names), c.operator, c.value, now)))
        .map((e: Json) => ({ ...entityRow(e), matched: Object.fromEntries(conds.map((c) => [c.field, clip(fieldValue(e, c.field, names))])) }));
      // Too big to add? Leave this page unconsumed so the next call resumes from it.
      if (items.length && overBudget([...items, ...hits])) break;
      items.push(...hits); pages++; scanned += d.data.length;
      cursor = nextCursor(d) ?? undefined;
    } while (cursor && pages < maxPages && items.length < limit);
    return { count: items.length, scanned, pagesScanned: pages, complete: !cursor, resumeCursor: cursor ?? null, items };
  }));

  // GET /v2/notes filters (the POST /notes/search body doesn't match its published schema and
  // silently ignores unknown keys, so it isn't used).
  const noteQuery = (a: Json) => {
    const since = (p?: string) => (p ? new Date(Date.now() - periodMs(p)).toISOString() : undefined);
    return {
      createdFrom: since(a.createdInLast) ?? a.createdFrom, createdTo: a.createdTo,
      updatedFrom: since(a.updatedInLast) ?? a.updatedFrom, updatedTo: a.updatedTo,
      'owner[email]': a.ownerEmail, processed: bool(a.processed), archived: bool(a.archived),
      'relationships[link][ids][]': a.linkedEntityIds, 'relationships[customer][ids][]': a.customerIds,
    };
  };

  server.registerTool('pb_search_notes', {
    description: `Search feedback notes. Date and relationship filters run in Productboard; text and conditions are applied to each page.
- createdInLast / updatedInLast: "7 days", "2 weeks", "3 months"
- text: case-insensitive match in title or content
- linkedEntityIds: notes linked to these features/entities (OR); customerIds: notes from these users/companies (OR)
- conditions: extra operator filters on note fields (title, content, owner, creator, processed, tags…). Operators: ${OPERATORS.join(', ')}.
If complete=false, pass resumeCursor as pageCursor to keep scanning.`,
    inputSchema: {
      text: z.string().optional(),
      createdInLast: z.string().optional(), updatedInLast: z.string().optional(),
      createdFrom: z.string().optional(), createdTo: z.string().optional(),
      updatedFrom: z.string().optional(), updatedTo: z.string().optional(),
      ownerEmail: z.string().optional(), processed: z.boolean().optional(), archived: z.boolean().optional(),
      linkedEntityIds: z.array(uuid).optional(), customerIds: z.array(uuid).optional(),
      conditions: z.array(conditionSchema).optional(),
      ...scanLimits,
    },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const conds: Condition[] = (a.conditions ?? []).map((c) => (c.field.toLowerCase() === 'title' ? { ...c, field: 'name' } : c));
    checkConditions(conds);
    const query = noteQuery(a);
    const limit = a.limit ?? 50, maxPages = a.maxPages ?? 10, now = Date.now();
    const text = a.text?.toLowerCase();
    const items: Json[] = [];
    let cursor = normCursor(a.pageCursor), pages = 0, scanned = 0;
    do {
      const d = await get('/notes', { ...query, pageCursor: cursor });
      const hits = d.data.filter((n: Json) => {
        const body = typeof n.fields?.content === 'string' ? stripHtml(n.fields.content, 1e9) : JSON.stringify(n.fields?.content ?? '');
        if (text && !`${n.fields?.name ?? ''} ${body}`.toLowerCase().includes(text)) return false;
        return conds.every((c) => matches(fieldValue(n, c.field, {}), c.operator, c.value, now));
      }).map(noteRow);
      if (items.length && overBudget([...items, ...hits])) break;
      items.push(...hits); pages++; scanned += d.data.length;
      cursor = nextCursor(d) ?? undefined;
    } while (cursor && pages < maxPages && items.length < limit);
    return { count: items.length, scanned, pagesScanned: pages, complete: !cursor, resumeCursor: cursor ?? null,
      filtersSentToProductboard: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)), items };
  }));

  server.registerTool('pb_list_entity_feedback', {
    description: 'List the feedback notes linked to a feature (or other entity): the customer evidence behind it. Compact rows; use pb_get_note for full text. Paginated via pageCursor.',
    inputSchema: { id: uuid.describe('Feature or entity ID'), pageCursor: cursor },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const d = await get('/notes', { 'relationships[link][ids][]': a.id, pageCursor: normCursor(a.pageCursor) });
    return page(d, d.data.map(noteRow));
  }));

  server.registerTool('pb_read_entity_document', {
    description: 'Read the rich-text documents on an entity (its Description and Specification) as markdown. Standalone Productboard documents are not available in the public API.',
    inputSchema: { id: uuid },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const e = (await get(`/entities/${a.id}`)).data;
    const names = await namesFor(e.type);
    const docs = Object.entries(e.fields ?? {})
      .filter(([k, v]) => typeof v === 'string' && (k === 'description' || k === 'specification' || /<\/?[a-z][^>]*>/i.test(v as string)))
      .map(([k, v]) => ({ field: names[k] ?? k, markdown: htmlToMarkdown(v as string) }))
      .filter((d) => d.markdown);
    return { id: e.id, type: e.type, name: e.fields?.name, url: e.links?.html, documents: docs, empty: docs.length === 0 };
  }));

  return server;
}
