/**
 * Live test of every MCP tool against a real Productboard workspace.
 *
 * Runs the exact tool code from src/tools.ts through a real MCP client (in-memory transport,
 * so no OAuth needed) and checks each result against a direct Productboard API call.
 * Read-only: only GET requests are made.
 *
 *   PB_TOKEN=… [PB_REGION=eu] npm run test:live
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, pbApiBase } from '../src/tools.ts';

const token = process.env.PB_TOKEN;
const region = process.env.PB_REGION === 'eu' || process.env.PB_EU === 'true' ? 'eu' : 'us';
if (!token) { console.error('Set PB_TOKEN'); process.exit(2); }

// ── Harness ───────────────────────────────────────────────────────────────────

type Json = any;
const results: { name: string; ok: boolean; detail: string }[] = [];

async function connect(tok: string) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ region }, tok).connect(serverT);
  const client = new Client({ name: 'live-test', version: '1.0.0' });
  await client.connect(clientT);
  return client;
}

async function direct(path: string): Promise<Json> {
  const res = await fetch(`${pbApiBase(region)}/v2${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`direct ${path} → ${res.status}`);
  return res.json();
}

/** Every item of a paginated GET or search, for use as the expected answer. */
async function directAll(path: string): Promise<Json[]> {
  const out: Json[] = []; let cur: string | undefined;
  do {
    const d = await direct(`${path}${cur ? `${path.includes('?') ? '&' : '?'}pageCursor=${encodeURIComponent(cur)}` : ''}`);
    out.push(...d.data); cur = cursorOf(d);
  } while (cur);
  return out;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r: Json = await client.callTool({ name, arguments: args });
  const text: string = r.content?.[0]?.text ?? '';
  let json: Json; try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!r.isError, text, json };
}

async function test(name: string, fn: () => Promise<string | void>) {
  try { results.push({ name, ok: true, detail: (await fn()) ?? '' }); }
  catch (e) { results.push({ name, ok: false, detail: (e as Error).message }); }
}

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const ids = (d: Json) => (d?.data ?? d?.items ?? []).map((x: Json) => x.id).join(',');
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
const DAY = 86_400_000;
const cursorOf = (d: Json) => { const n = d?.links?.next; return n ? new URL(n).searchParams.get('pageCursor') ?? undefined : undefined; };

// ── Tests ─────────────────────────────────────────────────────────────────────

const c = await connect(token);

await test('tools/list exposes 13 read-only tools', async () => {
  const { tools } = await c.listTools();
  assert(tools.length === 13, `expected 13 tools, got ${tools.length}`);
  const notRo = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);
  assert(notRo.length === 0, `missing readOnlyHint: ${notRo}`);
  return tools.map((t) => t.name).join(', ');
});

// Entities
const featDirect = await direct('/entities?type[]=feature');
const feat = featDirect.data[0];

await test('pb_list_entities(feature) matches API page 1', async () => {
  const r = await call(c, 'pb_list_entities', { type: 'feature' });
  assert(!r.isError, r.text);
  assert(ids(r.json) === ids(featDirect), 'ids differ from direct API');
  assert(r.json.nextPageCursor === cursorOf(featDirect), 'nextPageCursor differs');
  assert(r.text.length < 60_000, `response too large: ${r.text.length}`);
  return `${r.json.count} features, ${Math.round(r.text.length / 1024)} KB (raw API page: ${Math.round(JSON.stringify(featDirect).length / 1024)} KB), next page: ${!!r.json.nextPageCursor}`;
});

await test('pb_list_entities pagination (page 2 via pageCursor)', async () => {
  const cur = cursorOf(featDirect);
  if (!cur) return 'only one page — skipped';
  const r = await call(c, 'pb_list_entities', { type: 'feature', pageCursor: cur });
  assert(!r.isError, r.text);
  const p2 = await direct(`/entities?type[]=feature&pageCursor=${encodeURIComponent(cur)}`);
  assert(ids(r.json) === ids(p2), 'page 2 ids differ');
  assert(ids(r.json) !== ids(featDirect), 'page 2 equals page 1');
  return `${r.json.count} on page 2`;
});

await test('pb_list_entities pagination with full links.next URL', async () => {
  const next = featDirect.links?.next;
  if (!next) return 'only one page — skipped';
  const r = await call(c, 'pb_list_entities', { type: 'feature', pageCursor: next });
  assert(!r.isError, r.text);
  assert(ids(r.json) !== ids(featDirect), 'returned page 1 again');
  return 'accepted';
});

await test('pb_list_entities name filter', async () => {
  const r = await call(c, 'pb_list_entities', { type: 'feature', name: feat.fields.name });
  assert(!r.isError, r.text);
  assert(r.json.items.some((e: Json) => e.id === feat.id), `"${feat.fields.name}" not found`);
  return `"${feat.fields.name}" → ${r.json.count} match(es)`;
});

await test('pb_list_entities archived=false filter', async () => {
  const r = await call(c, 'pb_list_entities', { type: 'feature', archived: false });
  assert(!r.isError, r.text);
  assert(r.json.items.every((e: Json) => e.archived !== true), 'archived feature returned');
  return `${r.json.count} unarchived`;
});

const configs = await direct('/entities/configurations');
const types: string[] = configs.data.map((x: Json) => x.type);

await test('pb_list_entity_configurations (all + one type)', async () => {
  const all = await call(c, 'pb_list_entity_configurations');
  assert(!all.isError, all.text);
  assert(all.json.types.length === configs.data.length, 'type count differs');
  const one = await call(c, 'pb_list_entity_configurations', { type: 'feature' });
  assert(!one.isError && one.json.type === 'feature', one.text.slice(0, 120));
  const direct1 = configs.data.find((x: Json) => x.type === 'feature');
  assert(one.json.fields.length === Object.keys(direct1.fields).length, 'field count differs');
  return `types: ${types.join(', ')}; feature has ${one.json.fields.length} fields (${Math.round(one.text.length / 1024)} KB vs ${Math.round(JSON.stringify(configs).length / 1024)} KB raw)`;
});

await test('pb_list_entities works for every entity type', async () => {
  const out: string[] = []; const failed: string[] = [];
  for (const t of types) {
    const r = await call(c, 'pb_list_entities', { type: t });
    if (r.isError) failed.push(`${t}: ${r.text.slice(0, 80)}`);
    else out.push(`${t}=${r.json.count}${r.json.nextPageCursor ? '+' : ''}`);
  }
  assert(failed.length === 0, failed.join(' | '));
  return out.join(' ');
});

await test('pb_get_entity matches API', async () => {
  const r = await call(c, 'pb_get_entity', { id: feat.id });
  assert(!r.isError, r.text);
  assert(r.json.id === feat.id && r.json.fields.Name === feat.fields.name, 'entity differs');
  const keys = Object.keys(r.json.fields);
  const unresolved = keys.filter((k) => UUID_KEY.test(k));
  const rawCustom = Object.keys(feat.fields).filter((k) => UUID_KEY.test(k)).length;
  assert(unresolved.length === 0, `custom fields still keyed by UUID: ${unresolved.length}`);
  const raw = await call(c, 'pb_get_entity', { id: feat.id, raw: true });
  assert(!raw.isError && raw.json.data.id === feat.id, 'raw mode failed');
  return `${feat.fields.name}: ${keys.length} fields, ${rawCustom} custom fields resolved to names (e.g. ${keys.filter((k) => !['Name','Description','Status','Owner'].includes(k)).slice(0, 3).join(', ')})`;
});

await test('pb_list_entity_relationships matches API (and type filter)', async () => {
  const d = await direct(`/entities/${feat.id}/relationships`);
  const r = await call(c, 'pb_list_entity_relationships', { id: feat.id });
  assert(!r.isError, r.text);
  assert(r.json.count === d.data.length, 'count differs');
  const p = await call(c, 'pb_list_entity_relationships', { id: feat.id, type: 'parent' });
  assert(!p.isError, p.text);
  assert(p.json.items.every((x: Json) => x.relationship === 'parent'), 'type filter not applied');
  return `${d.data.length} relationships, ${p.json.count} parent`;
});

await test('pb_list_entities parentId filter returns children', async () => {
  const parentRel = (await direct(`/entities/${feat.id}/relationships?type=parent`)).data[0];
  if (!parentRel) return 'feature has no parent — skipped';
  const parentId = parentRel.target.id;
  const r = await call(c, 'pb_list_entities', { type: 'feature', parentId });
  assert(!r.isError, r.text);
  assert(r.json.items.some((e: Json) => e.id === feat.id), 'child not in parent filter results');
  return `${r.json.count} features under parent`;
});

await test('pb_list_entities statusName + ownerEmail filters', async () => {
  const status = feat.fields.status?.name; const owner = feat.fields.owner?.email;
  const r = await call(c, 'pb_list_entities', { type: 'feature', statusName: status });
  assert(!r.isError, r.text);
  assert(r.json.items.length > 0 && r.json.items.every((e: Json) => e.status === status), `status filter "${status}" not applied`);
  if (!owner) return `status "${status}" → ${r.json.count}`;
  const o = await call(c, 'pb_list_entities', { type: 'feature', ownerEmail: owner });
  assert(!o.isError, o.text);
  assert(o.json.items.length > 0 && o.json.items.every((e: Json) => e.owner === owner), 'owner filter not applied');
  return `status "${status}" → ${r.json.count}; owner ${owner} → ${o.json.count}`;
});

// Notes
const notesDirect = await direct('/notes');
const note = notesDirect.data[0];

await test('pb_list_notes matches API page 1', async () => {
  const r = await call(c, 'pb_list_notes');
  assert(!r.isError, r.text);
  assert(ids(r.json) === ids(notesDirect), 'ids differ');
  return `${r.json.count} notes, ${Math.round(r.text.length / 1024)} KB (raw ${Math.round(JSON.stringify(notesDirect).length / 1024)} KB), next page: ${!!r.json.nextPageCursor}`;
});

await test('pb_list_notes date + processed filters', async () => {
  const r = await call(c, 'pb_list_notes', { createdFrom: '2020-01-01T00:00:00Z', processed: false });
  assert(!r.isError, r.text);
  assert(r.json.items.every((n: Json) => n.processed === false), 'processed note returned');
  const recent = await call(c, 'pb_list_notes', { createdFrom: new Date(Date.now() - 2 * DAY).toISOString() });
  assert(!recent.isError && recent.json.items.every((n: Json) => Date.parse(n.createdAt) >= Date.now() - 2 * DAY - 60_000), 'createdFrom not applied');
  return `${r.json.count} unprocessed since 2020`;
});

await test('pb_get_note matches API', async () => {
  if (!note) return 'no notes — skipped';
  const r = await call(c, 'pb_get_note', { id: note.id });
  assert(!r.isError, r.text);
  assert(r.json.id === note.id && r.json.title === note.fields?.name, 'note differs');
  assert(typeof r.json.content === 'string' && !/<p>/.test(r.json.content), 'content not plain text');
  return `${note.fields?.name}: ${r.json.content.length} chars of plain text`;
});

await test('pb_list_note_relationships matches API', async () => {
  if (!note) return 'no notes — skipped';
  const d = await direct(`/notes/${note.id}/relationships`);
  const r = await call(c, 'pb_list_note_relationships', { id: note.id });
  assert(!r.isError, r.text);
  assert(r.json.count === d.data.length, 'count differs');
  return `${d.data.length} relationships`;
});

// Members & teams
const membersDirect = await direct('/members');

await test('pb_list_members matches API + query', async () => {
  const r = await call(c, 'pb_list_members');
  assert(!r.isError, r.text);
  assert(ids(r.json) === ids(membersDirect), 'ids differ');
  const name = membersDirect.data[0]?.fields?.name?.split(' ')[0];
  const q = await call(c, 'pb_list_members', { query: name });
  assert(!q.isError, q.text);
  assert(q.json.count >= 1, `query "${name}" found nothing`);
  assert(r.json.items[0].email, 'member email missing');
  return `${r.json.count} members; query "${name}" → ${q.json.count}`;
});

await test('pb_list_teams matches API', async () => {
  const d = await direct('/teams');
  const r = await call(c, 'pb_list_teams');
  assert(!r.isError, r.text);
  assert(ids(r.json) === ids(d), 'ids differ');
  return `${r.json.count} teams`;
});


// ── Operator search, feedback, documents ─────────────────────────────────────

const allFeatures = await directAll('/entities?type[]=feature');
const activeFeatures = allFeatures.filter((e) => e.fields.archived !== true);  // search excludes archived by default
const sortIds = (xs: Json[]) => xs.map((x) => x.id).sort().join(',');

await test('pb_search_entities: name contains (vs full scan)', async () => {
  const word = feat.fields.name.split(' ')[0].slice(0, 4).toLowerCase();
  const expected = activeFeatures.filter((e) => e.fields.name.toLowerCase().includes(word));
  const r = await call(c, 'pb_search_entities', { type: 'feature', conditions: [{ field: 'name', operator: 'contains', value: word }], limit: 200, maxPages: 40 });
  assert(!r.isError, r.text);
  assert(r.json.complete, 'scan not complete');
  assert(sortIds(r.json.items) === sortIds(expected), `got ${r.json.count}, expected ${expected.length}`);
  return `"${word}" → ${r.json.count} of ${activeFeatures.length} active features (scanned ${r.json.scanned})`;
});

await test('pb_search_entities: updatedAt in_last "90 days" (vs full scan)', async () => {
  const expected = activeFeatures.filter((e) => Date.parse(e.updatedAt) >= Date.now() - 90 * DAY);
  const r = await call(c, 'pb_search_entities', { type: 'feature', conditions: [{ field: 'updatedAt', operator: 'in_last', value: '90 days' }], limit: 200, maxPages: 40 });
  assert(!r.isError, r.text);
  assert(sortIds(r.json.items) === sortIds(expected), `got ${r.json.count}, expected ${expected.length}`);
  return `${r.json.count} features updated in the last 90 days`;
});

await test('pb_search_entities: status in [..] AND Effort gt 10 (custom-ish field by display name)', async () => {
  const statuses = [...new Set(activeFeatures.map((e) => e.fields.status?.name).filter(Boolean))].slice(0, 2) as string[];
  const expected = activeFeatures.filter((e) => statuses.includes(e.fields.status?.name) && Number(e.fields.effort) > 10);
  const r = await call(c, 'pb_search_entities', { type: 'feature', conditions: [
    { field: 'Status', operator: 'in', value: statuses }, { field: 'Effort', operator: 'gt', value: '10' }], limit: 200, maxPages: 40 });
  assert(!r.isError, r.text);
  assert(sortIds(r.json.items) === sortIds(expected), `got ${r.json.count}, expected ${expected.length}`);
  return `status in [${statuses.join(', ')}] and effort > 10 → ${r.json.count}`;
});

await test('pb_search_entities: Owner is_empty (vs full scan)', async () => {
  const expected = activeFeatures.filter((e) => !e.fields.owner);
  const r = await call(c, 'pb_search_entities', { type: 'feature', conditions: [{ field: 'Owner', operator: 'is_empty' }], limit: 200, maxPages: 40 });
  assert(!r.isError, r.text);
  assert(sortIds(r.json.items) === sortIds(expected), `got ${r.json.count}, expected ${expected.length}`);
  return `${r.json.count} unowned features`;
});

await test('pb_search_entities: custom field by display name (select/number)', async () => {
  const cfg = (await direct('/entities/configurations/feature')).data.fields;
  const custom = Object.entries(cfg).find(([id, f]: [string, Json]) => UUID_KEY.test(id) && activeFeatures.some((e) => e.fields[id] !== undefined && e.fields[id] !== null)) as [string, Json];
  if (!custom) return 'no populated custom field — skipped';
  const [id, f] = custom;
  const r = await call(c, 'pb_search_entities', { type: 'feature', conditions: [{ field: f.name, operator: 'is_not_empty' }], limit: 200, maxPages: 40 });
  assert(!r.isError, r.text);
  const expected = activeFeatures.filter((e) => e.fields[id] !== undefined && e.fields[id] !== null && !(Array.isArray(e.fields[id]) && !e.fields[id].length));
  assert(sortIds(r.json.items) === sortIds(expected), `got ${r.json.count}, expected ${expected.length}`);
  return `"${f.name}" is_not_empty → ${r.json.count}`;
});

await test('pb_search_entities: resume scanning with resumeCursor', async () => {
  if (allFeatures.length <= 100) return 'one page only — skipped';
  const cond = [{ field: 'name', operator: 'is_not_empty' }];
  const p1 = await call(c, 'pb_search_entities', { type: 'feature', conditions: cond, maxPages: 1, limit: 200 });
  assert(!p1.isError && !p1.json.complete && p1.json.resumeCursor, 'expected an incomplete first scan');
  const p2 = await call(c, 'pb_search_entities', { type: 'feature', conditions: cond, maxPages: 1, limit: 200, pageCursor: p1.json.resumeCursor });
  assert(!p2.isError, p2.text);
  const overlap = p2.json.items.filter((x: Json) => p1.json.items.some((y: Json) => y.id === x.id));
  assert(overlap.length === 0, 'resumed scan repeated items');
  return `page 1: ${p1.json.count}, resumed page: ${p2.json.count}`;
});

await test('pb_search_entities / pb_list_entities: archived=false excludes archived (API ignores it)', async () => {
  const expected = allFeatures.filter((e) => e.fields.archived !== true);
  const r = await call(c, 'pb_search_entities', { type: 'feature', archived: false, limit: 200, maxPages: 40 });
  const got: Json[] = [...r.json.items]; let cur = r.json.resumeCursor;
  while (cur) { const n = await call(c, 'pb_search_entities', { type: 'feature', archived: false, limit: 200, maxPages: 40, pageCursor: cur }); got.push(...n.json.items); cur = n.json.resumeCursor; }
  assert(sortIds(got) === sortIds(expected), `got ${got.length}, expected ${expected.length}`);
  const archivedTotal = allFeatures.length - expected.length;
  const t = await call(c, 'pb_search_entities', { type: 'feature', archived: true, limit: 200, maxPages: 40 });
  assert(t.json.items.length === archivedTotal && t.json.items.every((e: Json) => e.archived === true), 'archived=true wrong');
  let listed = 0, archivedListed = 0; let lc: string | undefined;
  do { const l = await call(c, 'pb_list_entities', { type: 'feature', archived: false, pageCursor: lc }); listed += l.json.count; archivedListed += l.json.items.filter((e: Json) => e.archived).length; lc = l.json.nextPageCursor ?? undefined; } while (lc);
  assert(archivedListed === 0 && listed === expected.length, `list: ${listed} rows, ${archivedListed} archived`);
  return `${expected.length} active, ${archivedTotal} archived (search and list both correct)`;
});

await test('pb_search_entities: rejects unknown field and bad period', async () => {
  const u = await call(c, 'pb_search_entities', { type: 'feature', conditions: [{ field: 'Nonexistent Field', operator: 'contains', value: 'x' }] });
  assert(u.isError && u.text.includes('Unknown field'), u.text.slice(0, 100));
  const p = await call(c, 'pb_search_entities', { type: 'feature', conditions: [{ field: 'updatedAt', operator: 'in_last', value: 'soon' }] });
  assert(p.isError && p.text.includes('Invalid period'), p.text.slice(0, 100));
  return 'both rejected with a clear message';
});

const allNotes = await directAll('/notes');

await test('pb_search_notes: createdInLast "30 days" (vs full scan)', async () => {
  const expected = allNotes.filter((n) => Date.parse(n.createdAt) >= Date.now() - 30 * DAY);
  const got: Json[] = []; let cur: string | undefined; let calls = 0;
  do {  // limit is a soft stop: follow resumeCursor until the scan is complete
    const r = await call(c, 'pb_search_notes', { createdInLast: '30 days', limit: 200, maxPages: 40, pageCursor: cur });
    assert(!r.isError, r.text); assert(!r.json.truncated, 'scan response was truncated'); got.push(...r.json.items); cur = r.json.resumeCursor ?? undefined; calls++;
  } while (cur);
  // allow 1 boundary item difference from the seconds between the two calls
  assert(Math.abs(got.length - expected.length) <= 1 && got.every((n: Json) => Date.parse(n.createdAt) >= Date.now() - 30 * DAY - 60_000), `got ${got.length}, expected ${expected.length}`);
  return `${got.length} of ${allNotes.length} notes created in the last 30 days (${calls} calls via resumeCursor)`;
});

await test('pb_search_notes: text contains (title or content)', async () => {
  const word = (note.fields.name as string).split(' ').find((w: string) => w.length > 5)!.toLowerCase();
  const expected = allNotes.filter((n) => `${n.fields.name} ${n.fields.content ?? ''}`.toLowerCase().includes(word));
  const got: Json[] = []; let cur: string | undefined;
  do {  // follow resumeCursor until the scan is complete
    const r = await call(c, 'pb_search_notes', { text: word, limit: 200, maxPages: 40, pageCursor: cur });
    assert(!r.isError, r.text); assert(!r.json.truncated, 'scan response was truncated');
    got.push(...r.json.items); cur = r.json.resumeCursor ?? undefined;
  } while (cur);
  assert(got.some((n: Json) => n.id === note.id), 'source note not found');
  assert(new Set(got.map((n) => n.id)).size === got.length, 'duplicates across resumed calls');
  // the raw-HTML scan also matches inside tags/entities, so allow a small difference
  assert(Math.abs(got.length - expected.length) <= Math.ceil(expected.length * 0.05), `got ${got.length}, expected ~${expected.length}`);
  return `"${word}" → ${got.length} notes (raw-HTML scan: ${expected.length})`;
});

const linkedNote = allNotes.find((n) => (n.relationships?.data ?? []).some((r: Json) => r.type === 'link'));
const linkedFeatureId = linkedNote?.relationships.data.find((r: Json) => r.type === 'link').target.id;

await test('pb_list_entity_feedback: notes linked to a feature (vs full scan)', async () => {
  if (!linkedFeatureId) return 'no linked notes in workspace — skipped';
  const expected = allNotes.filter((n) => (n.relationships?.data ?? []).some((r: Json) => r.type === 'link' && r.target.id === linkedFeatureId));
  const all: Json[] = []; let cur: string | undefined;
  do {
    const r = await call(c, 'pb_list_entity_feedback', { id: linkedFeatureId, pageCursor: cur });
    assert(!r.isError, r.text); all.push(...r.json.items); cur = r.json.nextPageCursor ?? undefined;
  } while (cur);
  assert(sortIds(all) === sortIds(expected), `got ${all.length}, expected ${expected.length}`);
  return `feature ${linkedFeatureId.slice(0, 8)}… has ${all.length} linked notes`;
});

await test('pb_search_notes: linkedEntityIds + createdInLast combined', async () => {
  if (!linkedFeatureId) return 'skipped';
  const r = await call(c, 'pb_search_notes', { linkedEntityIds: [linkedFeatureId], createdInLast: '5 years', limit: 200, maxPages: 40 });
  assert(!r.isError, r.text);
  assert(r.json.items.some((n: Json) => n.id === linkedNote.id), 'linked note missing');
  return `${r.json.count} notes; filters sent: ${JSON.stringify(r.json.filtersSentToProductboard)}`;
});

await test('pb_read_entity_document returns markdown, no HTML', async () => {
  const withSpec = allFeatures.find((e) => (e.fields.specification ?? '').length > 50) ?? allFeatures.find((e) => (e.fields.description ?? '').length > 50);
  if (!withSpec) return 'no feature has a description/spec — skipped';
  const r = await call(c, 'pb_read_entity_document', { id: withSpec.id });
  assert(!r.isError, r.text);
  assert(r.json.documents.length > 0, 'no documents returned');
  assert(r.json.documents.every((d: Json) => !/<\/?(p|div|span|h\d)[ >]/i.test(d.markdown)), 'HTML left in markdown');
  return `${withSpec.fields.name}: ${r.json.documents.map((d: Json) => `${d.field} (${d.markdown.length} chars)`).join(', ')}`;
});

// ── Dependency direction, related names, health (expected values checked in the Productboard UI / official MCP) ──

const PLAYBACK = '228c2850-9432-47f5-9c11-4c7a4359f524';
const ACCESSIBLE_PLAYER = 'f270e559-2b1f-4f9e-bc9c-70af2d9333bc';
const QUIZZES = '8b9dd9d7-db46-4942-a61e-203d5bd74b1b';

await test('dependency direction matches the Productboard UI (API reports it inverted)', async () => {
  const r = await call(c, 'pb_list_entity_relationships', { id: PLAYBACK });
  const dep = r.json.items.find((x: Json) => x.targetId === ACCESSIBLE_PLAYER);
  assert(dep?.relationship === 'isBlockedBy', `Playback → accessible player is ${dep?.relationship}, UI says isBlockedBy`);
  const back = await call(c, 'pb_list_entity_relationships', { id: ACCESSIBLE_PLAYER, type: 'isBlocking' });
  assert(back.json.items.some((x: Json) => x.targetId === PLAYBACK), 'reverse side: accessible player should be blocking Playback');
  const filtered = await call(c, 'pb_list_entity_relationships', { id: PLAYBACK, type: 'isBlockedBy' });
  assert(filtered.json.count === 1 && filtered.json.items[0].targetId === ACCESSIBLE_PLAYER, 'type=isBlockedBy filter wrong');
  const q = await call(c, 'pb_list_entity_relationships', { id: QUIZZES, type: 'isBlocking' });
  assert(q.json.items.some((x: Json) => x.targetName === 'In-video quizzes'), 'Quizzes should be blocking In-video quizzes');
  const ent = await call(c, 'pb_get_entity', { id: PLAYBACK });
  assert(ent.json.relationships.find((x: Json) => x.targetId === ACCESSIBLE_PLAYER)?.relationship === 'isBlockedBy', 'pb_get_entity direction wrong');
  return 'Playback is blocked by "Accessible player"; Quizzes is blocking "In-video quizzes"';
});

await test('relationships include related entity names (all pages, not capped at 10)', async () => {
  const ent = await call(c, 'pb_get_entity', { id: PLAYBACK });
  assert(!ent.isError, ent.text);
  const rels = ent.json.relationships;
  assert(rels.length === 28, `expected 28 relationships, got ${rels.length}`);
  const unnamed = rels.filter((x: Json) => !x.targetName);
  assert(unnamed.length === 0, `${unnamed.length} without a name`);
  const parent = rels.find((x: Json) => x.relationship === 'parent');
  assert(parent.targetName === 'Video Lessons', `parent name ${parent.targetName}`);
  if (linkedNote) {
    const n = await call(c, 'pb_get_note', { id: linkedNote.id });
    assert(n.json.relationships.every((x: Json) => x.targetName), 'note relationship missing a name');
  }
  return `28 named, parent "${parent.targetName}", e.g. ${rels.slice(1, 4).map((x: Json) => `${x.relationship} ${x.targetName}`).join('; ')}`;
});

await test('health shows status, comment, previous status, who and when', async () => {
  const ent = await call(c, 'pb_get_entity', { id: PLAYBACK });
  const h = ent.json.fields.Health;
  assert(h && h.status === 'atRisk' && h.previousStatus === 'onTrack' && h.comment === '2' && h.updatedBy && h.updatedAt, JSON.stringify(h));
  return JSON.stringify(h);
});

// Error handling
await test('invalid UUID is rejected before calling the API', async () => {
  const r = await call(c, 'pb_get_entity', { id: 'not-a-uuid' });
  assert(r.isError, 'expected an error');
  return r.text.slice(0, 90);
});

await test('unknown entity returns a clear 404 error', async () => {
  const r = await call(c, 'pb_get_entity', { id: '00000000-0000-4000-8000-000000000000' });
  assert(r.isError && r.text.includes('404'), `expected 404, got: ${r.text.slice(0, 120)}`);
  return r.text.slice(0, 90);
});

await test('revoked/invalid token gives a reconnect hint', async () => {
  const bad = await connect('invalid-token');
  const r = await call(bad, 'pb_list_teams');
  assert(r.isError && r.text.includes('401') && r.text.includes('reconnect'), r.text.slice(0, 120));
  return r.text.slice(0, 90);
});

// ── Report ────────────────────────────────────────────────────────────────────

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
