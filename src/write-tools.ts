/**
 * Productboard write tools: create, update and delete notes, entities, teams and field values.
 * Registered only when PB_ENABLE_WRITES is "true" (see wrangler.jsonc), and they need the write/delete
 * scopes on the Productboard OAuth app.
 *
 * Request shapes are copied from the Cloud Run server (../productboard-mcp-server/src/tools/*.ts),
 * which were verified against the live API.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { result, type Json, type Query } from './tools.ts';

type Send = (method: string, path: string, body?: Json, query?: Query) => Promise<Json>;

const ENTITY_TYPES = ['product', 'component', 'feature', 'subfeature', 'initiative', 'objective',
  'keyResult', 'release', 'releaseGroup', 'company', 'user'] as const;
const NEEDS_PARENT = new Set(['feature', 'subfeature', 'component', 'keyResult', 'release']);
const HAS_TIMEFRAME = new Set(['objective', 'keyResult', 'initiative', 'feature', 'subfeature', 'release']);
const HAS_HEALTH = new Set(['objective', 'keyResult', 'initiative', 'feature', 'subfeature']);
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'gray', 'lime', 'pink'] as const;
const RELATIONSHIP_TYPES = ['link', 'isBlockedBy', 'isBlocking', 'child', 'parent'] as const;

const uuid = z.string().uuid();
// Some MCP gateways stringify nested arguments, so objects and arrays may also arrive as JSON text.
const fromJson = (v: unknown) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const jsonObject = z.preprocess(fromJson, z.record(z.string(), z.unknown()));
const patchOps = z.preprocess(fromJson, z.array(z.object({
  op: z.enum(['set', 'clear', 'addItems', 'removeItems']),
  path: z.string().describe('Field path, e.g. "name" or "tags"'),
  value: z.unknown().optional().describe('New value (required for set/addItems/removeItems)'),
})));

const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const source = (system?: string, recordId?: string, url?: string) =>
  system && recordId ? { metadata: { source: { system, recordId, ...(url ? { url } : {}) } } } : {};

export function registerWriteTools(server: McpServer, send: Send): void {
  const run = <A>(fn: (a: A) => Promise<Json>) => async (a: A) => {
    try { return result(await fn(a)); }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] }; }
  };
  const done = (message: string, extra: Json = {}) => ({ ok: true, message, ...extra });

  // ── Notes ────────────────────────────────────────────────────────────────

  server.registerTool('pb_create_note', {
    description: `Create a customer feedback note (textNote). Content is HTML: plain text is rejected, so wrap it in <p> tags.
Tags must already exist (pb_list_field_values with fieldId="tags"). creatorEmail can only be set here, not changed later.
To link features afterwards use pb_link_note_entity. If the customer was created seconds ago the API may answer 404; create the note without it and use pb_set_note_customer shortly after.`,
    inputSchema: {
      title: z.string().min(1),
      content: z.string().optional().describe('HTML body, e.g. "<p>Customer asked for dark mode.</p>"'),
      ownerEmail: z.string().email().optional(), creatorEmail: z.string().email().optional(),
      archived: z.boolean().optional(), processed: z.boolean().optional(),
      tags: z.array(z.string()).optional().describe('Existing tag names'),
      customerType: z.enum(['company', 'user']).optional(), customerId: uuid.optional(),
      sourceSystem: z.string().optional(), sourceRecordId: z.string().optional(), sourceUrl: z.string().url().optional(),
    },
    annotations: write,
  }, run(async (a) => {
    if (!a.customerType !== !a.customerId) throw new Error('customerType and customerId must be given together');
    const fields: Json = { name: a.title };
    if (a.content) fields.content = a.content;
    if (a.ownerEmail) fields.owner = { email: a.ownerEmail };
    if (a.creatorEmail) fields.creator = { email: a.creatorEmail };
    if (a.archived !== undefined) fields.archived = a.archived;
    if (a.processed !== undefined) fields.processed = a.processed;
    if (a.tags?.length) fields.tags = a.tags.map((name) => ({ name }));
    const d = await send('POST', '/notes', { data: {
      type: 'textNote', fields, ...source(a.sourceSystem, a.sourceRecordId, a.sourceUrl),
      ...(a.customerType && a.customerId ? { relationships: [{ type: 'customer', target: { type: a.customerType, id: a.customerId } }] } : {}),
    } });
    return done('Note created', { id: d?.data?.id, url: d?.data?.links?.html });
  }));

  server.registerTool('pb_update_note', {
    description: 'Update a note\'s title, content (HTML), owner, tags, archived or processed state. tags replaces the whole list, so include every tag to keep. Relationships are changed with pb_set_note_customer, pb_link_note_entity and pb_delete_note_relationship.',
    inputSchema: {
      id: uuid, title: z.string().optional(), content: z.string().optional(), ownerEmail: z.string().email().optional(),
      tags: z.array(z.string()).optional().describe('Full replacement list of existing tag names'),
      archived: z.boolean().optional(), processed: z.boolean().optional(),
    },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    const fields: Json = {};
    if (a.title !== undefined) fields.name = a.title;
    if (a.content !== undefined) fields.content = a.content;
    if (a.ownerEmail !== undefined) fields.owner = { email: a.ownerEmail };
    if (a.tags !== undefined) fields.tags = a.tags.map((name) => ({ name }));
    if (a.archived !== undefined) fields.archived = a.archived;
    if (a.processed !== undefined) fields.processed = a.processed;
    if (!Object.keys(fields).length) throw new Error('Provide at least one field to update');
    await send('PATCH', `/notes/${a.id}`, { data: { fields } });
    return done(`Note ${a.id} updated`);
  }));

  server.registerTool('pb_delete_note', {
    description: 'Permanently delete a note and its relationships. Irreversible; consider pb_update_note with archived=true instead.',
    inputSchema: { id: uuid },
    annotations: { ...destructive, idempotentHint: true },
  }, run(async (a) => {
    await send('DELETE', `/notes/${a.id}`);
    return done(`Note ${a.id} deleted`);
  }));

  server.registerTool('pb_set_note_customer', {
    description: 'Set or replace the customer of a note: one company or one user. Replaces any existing customer in a single call.',
    inputSchema: { noteId: uuid, customerType: z.enum(['company', 'user']), customerId: uuid },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    // PUT replaces; POST /relationships answers 422 when the note already has a customer.
    await send('PUT', `/notes/${a.noteId}/relationships/customer`, { data: { target: { type: a.customerType, id: a.customerId } } });
    return done(`Note ${a.noteId} customer set to ${a.customerType} ${a.customerId}`);
  }));

  server.registerTool('pb_link_note_entity', {
    description: 'Link a note to a feature or other hierarchy entity (component, product, initiative…) as evidence. A note can have many links; each call adds one.',
    inputSchema: { noteId: uuid, entityId: uuid },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    await send('POST', `/notes/${a.noteId}/relationships`, { data: { type: 'link', target: { id: a.entityId, type: 'link' } } });
    return done(`Note ${a.noteId} linked to ${a.entityId}`);
  }));

  server.registerTool('pb_delete_note_relationship', {
    description: 'Remove a relationship from a note: targetType "customer" to remove its company/user, "link" to unlink a feature or other entity.',
    inputSchema: { noteId: uuid, targetType: z.enum(['customer', 'link']), targetId: uuid },
    annotations: { ...destructive, idempotentHint: true },
  }, run(async (a) => {
    await send('DELETE', `/notes/${a.noteId}/relationships/${a.targetType}/${a.targetId}`);
    return done(`Removed ${a.targetType} ${a.targetId} from note ${a.noteId}`);
  }));

  // ── Entities ─────────────────────────────────────────────────────────────

  server.registerTool('pb_create_entity', {
    description: `Create an entity (feature, component, initiative, company, user…).
parentId is required for feature, subfeature, component, keyResult and release. Timeframe applies to objective, keyResult, initiative, feature, subfeature, release; health to objective, keyResult, initiative, feature, subfeature; phase to initiative.
Other standard or custom fields go in fields, keyed by field id (pb_list_entity_configurations). Rich text must be HTML, e.g. fields={"description":"<p>…</p>"}; companies take fields={"domain":"acme.com"}.`,
    inputSchema: {
      type: z.enum(ENTITY_TYPES), name: z.string().min(1), parentId: uuid.optional(),
      email: z.string().email().optional().describe('Only for type="user"'),
      ownerEmail: z.string().email().optional(), status: z.string().optional().describe('Existing status name'),
      teams: z.array(z.string()).optional().describe('Existing team names'),
      timeframeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timeframeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      timeframeGranularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
      healthStatus: z.enum(['onTrack', 'atRisk', 'offTrack']).optional(), healthComment: z.string().optional(),
      phase: z.string().optional(),
      fields: jsonObject.optional(),
      sourceSystem: z.string().optional(), sourceRecordId: z.string().optional(), sourceUrl: z.string().url().optional(),
    },
    annotations: write,
  }, run(async (a) => {
    if (NEEDS_PARENT.has(a.type) && !a.parentId) throw new Error(`parentId is required when creating a ${a.type}`);
    const fields: Json = { name: a.name, ...(a.fields ?? {}) };
    if (a.email && a.type === 'user') fields.email = a.email;
    if (a.ownerEmail) fields.owner = { email: a.ownerEmail };
    if (a.status) fields.status = { name: a.status };
    if (a.teams?.length) fields.teams = a.teams.map((name) => ({ name }));
    if ((a.timeframeStart || a.timeframeEnd) && HAS_TIMEFRAME.has(a.type)) {
      fields.timeframe = { startDate: a.timeframeStart ?? a.timeframeEnd, endDate: a.timeframeEnd ?? a.timeframeStart, granularity: a.timeframeGranularity ?? 'day' };
    }
    if (a.healthStatus && HAS_HEALTH.has(a.type)) fields.health = { mode: 'manual', status: a.healthStatus, ...(a.healthComment ? { comment: a.healthComment } : {}) };
    if (a.phase && a.type === 'initiative') fields.phase = { name: a.phase };
    const d = await send('POST', '/entities', { data: {
      type: a.type, fields, ...source(a.sourceSystem, a.sourceRecordId, a.sourceUrl),
      ...(a.parentId ? { relationships: [{ type: 'parent', target: { id: a.parentId } }] } : {}),
    } });
    return done(`${a.type} created`, { id: d?.data?.id, url: d?.data?.links?.html });
  }));

  server.registerTool('pb_update_entity', {
    description: `Update an entity. Two modes, usable together:
- fields: replace the listed fields, e.g. {"name":"New name"}, {"status":{"name":"Done"}}, {"owner":{"email":"a@b.com"}}, {"teams":[{"name":"Team A"}]}, {"timeframe":{"startDate":"2026-01-01","endDate":"2026-03-31","granularity":"quarter"}}, {"health":{"mode":"manual","status":"onTrack","comment":"…"}}
- patch: granular ops [{op, path, value}] with op set | clear | addItems | removeItems, e.g. [{"op":"addItems","path":"tags","value":[{"name":"priority"}]}] or [{"op":"clear","path":"description"}]
Custom fields are keyed by field id (pb_list_entity_configurations). Never set a field to null to clear it; use the clear op.`,
    inputSchema: { id: uuid, fields: jsonObject.optional(), patch: patchOps.optional() },
    annotations: write,
  }, run(async (a) => {
    if (!a.fields && !a.patch?.length) throw new Error('Provide fields or at least one patch op');
    await send('PATCH', `/entities/${a.id}`, { data: { ...(a.fields ? { fields: a.fields } : {}), ...(a.patch?.length ? { patch: a.patch } : {}) } });
    return done(`Entity ${a.id} updated`);
  }));

  server.registerTool('pb_delete_entity', {
    description: 'Permanently delete an entity. Irreversible and cascades to descendants: a product takes its components, features and subfeatures; a component its features; a feature its subfeatures; an objective its key results; a release group its releases. Confirm with the user first.',
    inputSchema: { id: uuid },
    annotations: { ...destructive, idempotentHint: true },
  }, run(async (a) => {
    await send('DELETE', `/entities/${a.id}`);
    return done(`Entity ${a.id} deleted`);
  }));

  server.registerTool('pb_create_entity_relationship', {
    description: 'Create a relationship between two entities: link, isBlocking (this entity blocks the target), isBlockedBy (the target blocks this entity), child, or parent (to replace a parent use pb_set_entity_parent). Directions match the Productboard UI.',
    inputSchema: { id: uuid.describe('Source entity'), type: z.enum(RELATIONSHIP_TYPES), targetId: uuid },
    annotations: write,
  }, run(async (a) => {
    // Writes use the UI direction as-is; only reads come back inverted (translated in tools.ts).
    await send('POST', `/entities/${a.id}/relationships`, { data: { type: a.type, target: { id: a.targetId } } });
    return done(`Created ${a.type} relationship from ${a.id} to ${a.targetId}`);
  }));

  server.registerTool('pb_set_entity_parent', {
    description: 'Set or replace the parent of an entity, e.g. move a feature to another component or a key result to another objective.',
    inputSchema: { id: uuid, parentId: uuid },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    await send('PUT', `/entities/${a.id}/relationships/parent`, { data: { target: { id: a.parentId } } });
    return done(`Parent of ${a.id} set to ${a.parentId}`);
  }));

  server.registerTool('pb_delete_entity_relationship', {
    description: 'Delete a relationship between two entities. For dependencies use the direction pb_list_entity_relationships shows: isBlocking if this entity blocks the target, isBlockedBy if the target blocks it.',
    inputSchema: { id: uuid.describe('Source entity'), type: z.enum(RELATIONSHIP_TYPES), targetId: uuid },
    annotations: { ...destructive, idempotentHint: true },
  }, run(async (a) => {
    await send('DELETE', `/entities/${a.id}/relationships/${a.type}/${a.targetId}`);
    return done(`Deleted ${a.type} relationship from ${a.id} to ${a.targetId}`);
  }));

  // ── Field values and tags ────────────────────────────────────────────────

  server.registerTool('pb_create_field_value', {
    description: 'Create a new option on a select/multiselect custom field, or a new workspace tag with fieldId="tags". Check pb_list_field_values first to avoid duplicates.',
    inputSchema: { fieldId: z.string().min(1).describe('Field id, or "tags"'), name: z.string().min(1), color: z.enum(COLORS).optional() },
    annotations: write,
  }, run(async (a) => {
    const d = await send('POST', `/entities/fields/${encodeURIComponent(a.fieldId)}/values`, { data: { fields: { name: a.name, ...(a.color ? { color: a.color } : {}) } } });
    return done(`Value "${a.name}" created on field ${a.fieldId}`, { id: d?.data?.id });
  }));

  server.registerTool('pb_update_field_value', {
    description: 'Rename or recolor an option of a select/multiselect field or a workspace tag (fieldId="tags").',
    inputSchema: { fieldId: z.string().min(1), valueId: uuid, name: z.string().optional(), color: z.enum(COLORS).optional() },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    if (a.name === undefined && a.color === undefined) throw new Error('Provide name or color');
    await send('PATCH', `/entities/fields/${encodeURIComponent(a.fieldId)}/values/${a.valueId}`, { data: { fields: {
      ...(a.name !== undefined ? { name: a.name } : {}), ...(a.color !== undefined ? { color: a.color } : {}),
    } } });
    return done(`Value ${a.valueId} updated`);
  }));

  server.registerTool('pb_delete_field_value', {
    description: 'Delete an option of a select/multiselect field or a workspace tag. Status values cannot be deleted. If the value is in use the API refuses unless force=true (unsets it everywhere) or replaceWithId is given (moves assignments to that value first).',
    inputSchema: { fieldId: z.string().min(1), valueId: uuid, force: z.boolean().optional(), replaceWithId: uuid.optional() },
    annotations: destructive,
  }, run(async (a) => {
    if (a.force && a.replaceWithId) throw new Error('Use either force or replaceWithId, not both');
    // The API rejects a DELETE body; force and replaceWith are query parameters.
    await send('DELETE', `/entities/fields/${encodeURIComponent(a.fieldId)}/values/${a.valueId}`, undefined,
      { force: a.force ? 'true' : undefined, replaceWith: a.replaceWithId });
    return done(`Value ${a.valueId} deleted from field ${a.fieldId}`);
  }));

  // ── Teams ────────────────────────────────────────────────────────────────

  const handle = z.string().regex(/^[a-z0-9]+$/, 'Handle must be lowercase letters and digits only').optional()
    .describe('Short unique handle, lowercase letters and digits only, e.g. "eng"');

  server.registerTool('pb_create_team', {
    description: 'Create a team.',
    inputSchema: { name: z.string().min(1), handle, description: z.string().optional() },
    annotations: write,
  }, run(async (a) => {
    const d = await send('POST', '/teams', { data: { type: 'team', fields: {
      name: a.name, ...(a.handle ? { handle: a.handle } : {}), ...(a.description ? { description: a.description } : {}),
    } } });
    return done(`Team "${a.name}" created`, { id: d?.data?.id });
  }));

  server.registerTool('pb_update_team', {
    description: 'Update a team\'s name, handle or description.',
    inputSchema: { id: uuid, name: z.string().optional(), handle, description: z.string().optional() },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    const fields: Json = {};
    if (a.name !== undefined) fields.name = a.name;
    if (a.handle !== undefined) fields.handle = a.handle;
    if (a.description !== undefined) fields.description = a.description;
    if (!Object.keys(fields).length) throw new Error('Provide at least one field to update');
    await send('PATCH', `/teams/${a.id}`, { data: { fields } });
    return done(`Team ${a.id} updated`);
  }));

  server.registerTool('pb_delete_team', {
    description: 'Permanently delete a team. Irreversible; its members stay in the workspace.',
    inputSchema: { id: uuid },
    annotations: { ...destructive, idempotentHint: true },
  }, run(async (a) => {
    await send('DELETE', `/teams/${a.id}`);
    return done(`Team ${a.id} deleted`);
  }));

  server.registerTool('pb_add_team_member', {
    description: 'Add a workspace member to a team (member ids from pb_list_members).',
    inputSchema: { teamId: uuid, memberId: uuid },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    await send('PATCH', `/teams/${a.teamId}`, { data: { patch: [{ op: 'addItems', path: 'members', value: [{ id: a.memberId }] }] } });
    return done(`Member ${a.memberId} added to team ${a.teamId}`);
  }));

  server.registerTool('pb_remove_team_member', {
    description: 'Remove a member from a team. They stay in the workspace.',
    inputSchema: { teamId: uuid, memberId: uuid },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    await send('PATCH', `/teams/${a.teamId}`, { data: { patch: [{ op: 'removeItems', path: 'members', value: [{ id: a.memberId }] }] } });
    return done(`Member ${a.memberId} removed from team ${a.teamId}`);
  }));
}
