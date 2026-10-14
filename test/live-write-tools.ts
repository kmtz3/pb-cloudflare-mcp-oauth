/**
 * Live test of the write tools (src/write-tools.ts) against a real Productboard workspace.
 * Every write is checked by reading the record back with a direct API call. Use a test workspace.
 *
 * Default: changes one existing test note and restores it (tags, owner, customer, links).
 *   PB_TOKEN=… NOTE_ID=<note> LINK_ENTITY_ID=<feature> COMPANY_ID=<company> OWNER_EMAIL=<member> TAG=<existing tag> npm run test:live:write
 *
 * --full: also creates a temporary tag, note, feature and team, runs every write tool on them,
 * then deletes what it created (and only that). Needs PARENT_ID (a product or component) and MEMBER_ID.
 *   … PARENT_ID=<component> MEMBER_ID=<member> npm run test:live:write -- --full
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, pbApiBase } from '../src/tools.ts';

type Json = any;
const env = process.env;
const region = env.PB_REGION === 'eu' ? 'eu' : 'us';
const full = process.argv.includes('--full');
const need = ['PB_TOKEN', 'NOTE_ID', 'LINK_ENTITY_ID', 'COMPANY_ID', 'OWNER_EMAIL', 'TAG', ...(full ? ['PARENT_ID', 'MEMBER_ID'] : [])];
const missing = need.filter((k) => !env[k]);
if (missing.length) { console.error(`Set ${missing.join(', ')}`); process.exit(2); }
const E = env as Record<string, string>;

const results: { name: string; ok: boolean; detail: string }[] = [];
const test = async (name: string, fn: () => Promise<string | void>) => {
  try { results.push({ name, ok: true, detail: (await fn()) ?? '' }); }
  catch (e) { results.push({ name, ok: false, detail: (e as Error).message }); }
};
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

async function direct(path: string): Promise<Json> {
  const res = await fetch(`${pbApiBase(region)}/v2${path}`, { headers: { Authorization: `Bearer ${E.PB_TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`direct ${path} → ${res.status}`);
  return res.json();
}
async function tagValues(): Promise<Json[]> {
  const out: Json[] = []; let cur: string | null = null;
  do {
    const d = await direct(`/entities/fields/tags/values${cur ? `?pageCursor=${encodeURIComponent(cur)}` : ''}`);
    out.push(...d.data); cur = d.links?.next ? new URL(d.links.next).searchParams.get('pageCursor') : null;
  } while (cur);
  return out;
}
const note = async (id: string) => (await direct(`/notes/${id}`)).data;
const noteRels = async (id: string) => (await direct(`/notes/${id}/relationships`)).data as Json[];
const customerOf = async (id: string) => (await noteRels(id)).find((r) => r.type === 'customer')?.target;
const linksOf = async (id: string) => (await noteRels(id)).filter((r) => r.type === 'link').map((r) => r.target.id);
const tagsOf = (n: Json) => (n.fields?.tags ?? []).map((t: Json) => t.name).sort();

const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await buildMcpServer({ region, writes: true }, E.PB_TOKEN).connect(serverT);
const client = new Client({ name: 'live-write-test', version: '1.0.0' });
await client.connect(clientT);

async function call(name: string, args: Record<string, unknown>): Promise<Json> {
  const r: Json = await client.callTool({ name, arguments: args });
  const text: string = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ── Default: one existing note, restored at the end ───────────────────────────

const id = E.NOTE_ID;
const before = await note(id);
const beforeCustomer = await customerOf(id);
const beforeLinks = await linksOf(id);
const beforeTags: string[] = tagsOf(before);
const beforeOwner: string | undefined = before.fields?.owner?.email;

await test('pb_update_note adds a tag', async () => {
  await call('pb_update_note', { id, tags: [...beforeTags, E.TAG] });
  assert(tagsOf(await note(id)).includes(E.TAG), 'tag not on the note');
});
await test('pb_update_note removes the tag', async () => {
  await call('pb_update_note', { id, tags: beforeTags });
  assert(!tagsOf(await note(id)).includes(E.TAG), 'tag still on the note');
});
await test('pb_update_note changes the owner', async () => {
  await call('pb_update_note', { id, ownerEmail: E.OWNER_EMAIL });
  assert((await note(id)).fields?.owner?.email === E.OWNER_EMAIL, 'owner not changed');
});
await test('pb_set_note_customer replaces an existing customer in one call', async () => {
  await call('pb_set_note_customer', { noteId: id, customerType: 'company', customerId: E.COMPANY_ID });
  const c = await customerOf(id);
  assert(c?.id === E.COMPANY_ID, `customer is ${JSON.stringify(c)}`);
  return beforeCustomer ? `replaced ${beforeCustomer.type} ${beforeCustomer.id}` : 'note had no customer before';
});
await test('pb_link_note_entity links', async () => {
  await call('pb_link_note_entity', { noteId: id, entityId: E.LINK_ENTITY_ID });
  assert((await linksOf(id)).includes(E.LINK_ENTITY_ID), 'link missing');
});
if (!beforeLinks.includes(E.LINK_ENTITY_ID)) {
  await test('pb_delete_note_relationship unlinks', async () => {
    await call('pb_delete_note_relationship', { noteId: id, targetType: 'link', targetId: E.LINK_ENTITY_ID });
    assert(!(await linksOf(id)).includes(E.LINK_ENTITY_ID), 'link still there');
  });
}

await test('note restored to its starting state', async () => {
  if (beforeOwner && beforeOwner !== E.OWNER_EMAIL) await call('pb_update_note', { id, ownerEmail: beforeOwner });
  if (beforeCustomer) await call('pb_set_note_customer', { noteId: id, customerType: beforeCustomer.type, customerId: beforeCustomer.id });
  else await call('pb_delete_note_relationship', { noteId: id, targetType: 'customer', targetId: E.COMPANY_ID });
  const after = await note(id);
  assert(JSON.stringify(tagsOf(after)) === JSON.stringify(beforeTags), 'tags differ');
  assert((await customerOf(id))?.id === beforeCustomer?.id, 'customer differs');
  assert(JSON.stringify((await linksOf(id)).sort()) === JSON.stringify([...beforeLinks].sort()), 'links differ');
  if (beforeOwner) assert(after.fields?.owner?.email === beforeOwner, 'owner differs');
  else return 'note had no owner before; the public API cannot clear an owner, so it stays set';
});

// ── --full: temporary records, deleted at the end ─────────────────────────────

if (full) {
  const stamp = `mcp-write-test-${Date.now()}`;
  const made: { tag?: string; note?: string; feature?: string; team?: string } = {};

  await test('pb_create_field_value creates a tag', async () => {
    made.tag = (await call('pb_create_field_value', { fieldId: 'tags', name: stamp })).id;
    assert(made.tag, 'no id returned');
  });
  await test('pb_update_field_value recolors it', async () => {
    await call('pb_update_field_value', { fieldId: 'tags', valueId: made.tag, color: 'blue' });
    const v = (await tagValues()).find((x: Json) => x.id === made.tag);
    assert(v?.fields?.color === 'blue', `color is ${v?.fields?.color}`);
  });
  await test('pb_create_note with tag and customer', async () => {
    made.note = (await call('pb_create_note', { title: `[TEST] ${stamp}`, content: '<p>Temporary note from test/live-write-tools.ts</p>', tags: [stamp], customerType: 'company', customerId: E.COMPANY_ID })).id;
    assert(tagsOf(await note(made.note!)).includes(stamp), 'tag missing');
    assert((await customerOf(made.note!))?.id === E.COMPANY_ID, 'customer missing');
  });
  await test('pb_create_entity creates a feature', async () => {
    made.feature = (await call('pb_create_entity', { type: 'feature', name: `[TEST] ${stamp}`, parentId: E.PARENT_ID, fields: { description: '<p>Temporary</p>' } })).id;
    assert((await direct(`/entities/${made.feature}`)).data.fields.name === `[TEST] ${stamp}`, 'name mismatch');
  });
  await test('pb_update_entity renames it', async () => {
    await call('pb_update_entity', { id: made.feature, fields: { name: `[TEST] ${stamp} renamed` } });
    assert((await direct(`/entities/${made.feature}`)).data.fields.name.endsWith('renamed'), 'not renamed');
  });
  await test('pb_create_entity_relationship links it', async () => {
    await call('pb_create_entity_relationship', { id: made.feature, type: 'link', targetId: E.LINK_ENTITY_ID });
    const rels = (await direct(`/entities/${made.feature}/relationships?type=link`)).data;
    assert(rels.some((r: Json) => r.target.id === E.LINK_ENTITY_ID), 'link missing');
  });
  await test('pb_delete_entity_relationship unlinks it', async () => {
    await call('pb_delete_entity_relationship', { id: made.feature, type: 'link', targetId: E.LINK_ENTITY_ID });
    const rels = (await direct(`/entities/${made.feature}/relationships?type=link`)).data;
    assert(!rels.some((r: Json) => r.target.id === E.LINK_ENTITY_ID), 'link still there');
  });
  await test('pb_set_entity_parent keeps it under PARENT_ID', async () => {
    await call('pb_set_entity_parent', { id: made.feature, parentId: E.PARENT_ID });
    const parent = (await direct(`/entities/${made.feature}/relationships?type=parent`)).data[0];
    assert(parent?.target?.id === E.PARENT_ID, 'parent mismatch');
  });
  await test('pb_create_team / pb_update_team', async () => {
    made.team = (await call('pb_create_team', { name: `[TEST] ${stamp}` })).id;
    await call('pb_update_team', { id: made.team, description: 'Temporary' });
    assert((await direct(`/teams/${made.team}`)).data.fields.description === 'Temporary', 'description not set');
  });
  await test('pb_add_team_member / pb_remove_team_member', async () => {
    await call('pb_add_team_member', { teamId: made.team, memberId: E.MEMBER_ID });
    await call('pb_remove_team_member', { teamId: made.team, memberId: E.MEMBER_ID });
    return 'calls accepted';
  });

  for (const [tool, args, check] of [
    ['pb_delete_note', { id: made.note }, `/notes/${made.note}`],
    ['pb_delete_entity', { id: made.feature }, `/entities/${made.feature}`],
    ['pb_delete_team', { id: made.team }, `/teams/${made.team}`],
  ] as const) {
    if (!args.id) continue;
    await test(`${tool} cleans up`, async () => {
      await call(tool, args);
      await direct(check).then(() => { throw new Error('still exists'); }, (e: Error) => assert(/→ 404/.test(e.message), e.message));
    });
  }
  if (made.tag) {
    await test('pb_delete_field_value cleans up the tag', async () => {
      await call('pb_delete_field_value', { fieldId: 'tags', valueId: made.tag, force: true });
      assert(!(await tagValues()).some((x: Json) => x.id === made.tag), 'tag still exists');
    });
  }
}

for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
