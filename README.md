# Productboard MCP server on Cloudflare

A minimal remote MCP server for Productboard, **read-only by default** with opt-in write tools. It runs as a single Cloudflare Worker and signs each user in to Productboard with OAuth.

- **Nothing to install on user machines.** Users paste one URL into their AI client and sign in to Productboard in the browser.
- **Almost no infrastructure.** One Cloudflare Worker plus one KV namespace. There are no servers, containers, databases or VMs.
- **Read-only by default, enforced twice.** Productboard only grants `:read` scopes, and the write tools are not even registered unless `PB_ENABLE_WRITES` is `"true"` (see [Write tools](#write-tools)).
- **Per-user identity.** Each person sees only what their own Productboard account can see.

Step-by-step setup: **[SETUP.md](SETUP.md)** · How the OAuth works, with a diagram: **[docs/OAUTH.md](docs/OAUTH.md)**

## How it works

```
AI client (Claude, Copilot Studio, VS Code…)
   │  1. POST /mcp → 401 + discovery metadata
   │  2. registers itself (/register), opens browser → /authorize
   ▼
Cloudflare Worker  ──consent page──▶  user clicks "Continue"
   │  3. redirect (PKCE) → Productboard /oauth2/authorize → user signs in
   │  4. Productboard → /callback?code=…  → Worker exchanges code for PB token
   │  5. Worker issues its own MCP token to the client; PB token kept encrypted in KV
   ▼
AI client calls /mcp tools  →  Worker  →  GET api.productboard.com/v2/…
```

- The Productboard token never reaches the AI client. The client holds a separate MCP token, and the Productboard token stays in the grant inside KV, encrypted with a key that only that user's MCP token can unlock.
- When the client refreshes its MCP token, the Worker refreshes the Productboard token as well (`tokenExchangeCallback`).
- If a user revokes access in Productboard, the next refresh fails cleanly and the client asks them to reconnect.

## Tools

| Tool | Productboard endpoint |
|---|---|
| `pb_list_entities` | `GET /v2/entities?type[]=…` |
| `pb_get_entity` | `GET /v2/entities/{id}` |
| `pb_list_entity_relationships` | `GET /v2/entities/{id}/relationships` |
| `pb_list_entity_configurations` | `GET /v2/entities/configurations` |
| `pb_list_notes` | `GET /v2/notes` |
| `pb_get_note` | `GET /v2/notes/{id}` |
| `pb_list_note_relationships` | `GET /v2/notes/{id}/relationships` |
| `pb_list_members` | `GET /v2/members` |
| `pb_list_teams` | `GET /v2/teams` |
| `pb_search_entities` | `GET /v2/entities` pages, filtered with operators (see below) |
| `pb_search_notes` | `GET /v2/notes` with date, owner, linked-feature and customer filters, plus text and operators |
| `pb_list_entity_feedback` | `GET /v2/notes?relationships[link][ids][]={id}` (notes linked to a feature) |
| `pb_read_entity_document` | `GET /v2/entities/{id}`: Description, Specification and other rich-text fields as markdown |
| `pb_list_field_values` | `GET /v2/entities/fields/{id}/values` (status options, select options, or all tags with `tags`) |

**Operator search.** The public API only filters by exact values joined with AND. `pb_search_entities` and `pb_search_notes` therefore apply the operators themselves, over pages fetched with Productboard's own filters already applied. Supported operators: `contains`, `not_contains`, `equals`, `not_equals`, `in`, `not_in`, `is_empty`, `is_not_empty`, `gt`, `gte`, `lt`, `lte`, `before`, `after`, `in_last`, `in_next`. Periods are written like `"7 days"`, `"2 weeks"` or `"3 months"`. Fields can be named by display name (custom fields included), by ID, or as `createdAt` / `updatedAt`. A scan stops at a page boundary when it reaches `limit` or the response size budget, and returns a `resumeCursor` to continue, so no matches are dropped.

**Documents.** The public API has no endpoint for standalone Productboard documents. `pb_read_entity_document` reads the rich-text documents stored on an entity.

List tools return compact rows (id, name, status, owner, link) and a `nextPageCursor`, because a raw page of 100 features is about 700 KB. The get tools return every field under its display name, with custom fields resolved from their UUIDs; pass `raw: true` for the unmodified API response.

To add a tool, copy one `server.registerTool(...)` block in `src/tools.ts` (or `src/write-tools.ts` for writes).

## Write tools

Off by default. To turn them on, set `PB_ENABLE_WRITES` to `"true"` in `wrangler.jsonc`, add `entities:write entities:delete notes:write notes:delete teams:write teams:delete` to `PB_SCOPES` and to the Productboard OAuth app, and redeploy. Users then reconnect to get a token with the new scopes, and the consent page says the connector can change data. Request shapes are copied from the Cloud Run server (`../productboard-mcp-server`).

| Tool | Productboard endpoint |
|---|---|
| `pb_create_note` | `POST /v2/notes` (tags, owner, creator, customer, source metadata) |
| `pb_update_note` | `PATCH /v2/notes/{id}` (title, content, owner, tags as a full list, archived, processed) |
| `pb_delete_note` | `DELETE /v2/notes/{id}` |
| `pb_set_note_customer` | `PUT /v2/notes/{id}/relationships/customer` (replaces any existing customer) |
| `pb_link_note_entity` | `POST /v2/notes/{id}/relationships` (`link`) |
| `pb_delete_note_relationship` | `DELETE /v2/notes/{id}/relationships/{customer\|link}/{targetId}` |
| `pb_create_entity` | `POST /v2/entities` (parent, owner, status, teams, timeframe, health, phase, custom fields) |
| `pb_update_entity` | `PATCH /v2/entities/{id}` (`fields` replace and/or `patch` ops) |
| `pb_delete_entity` | `DELETE /v2/entities/{id}` (cascades to descendants) |
| `pb_create_entity_relationship` | `POST /v2/entities/{id}/relationships` |
| `pb_set_entity_parent` | `PUT /v2/entities/{id}/relationships/parent` |
| `pb_delete_entity_relationship` | `DELETE /v2/entities/{id}/relationships/{type}/{targetId}` |
| `pb_create_field_value` | `POST /v2/entities/fields/{id}/values` (new select option, or a tag with `tags`) |
| `pb_update_field_value` | `PATCH /v2/entities/fields/{id}/values/{valueId}` |
| `pb_delete_field_value` | `DELETE /v2/entities/fields/{id}/values/{valueId}` (`force` / `replaceWith`) |
| `pb_create_team` | `POST /v2/teams` |
| `pb_update_team` | `PATCH /v2/teams/{id}` |
| `pb_delete_team` | `DELETE /v2/teams/{id}` |
| `pb_add_team_member` | `PATCH /v2/teams/{id}` (`addItems` members) |
| `pb_remove_team_member` | `PATCH /v2/teams/{id}` (`removeItems` members) |

## Live test

`test/live-tools.ts` runs every tool through a real MCP client against a Productboard workspace and checks each result against a direct API call. It makes `GET` requests only.

```bash
PB_TOKEN=your_api_token npm run test:live     # add PB_REGION=eu for EU workspaces
```

`test/live-write-tools.ts` tests the write tools, checking every write with a direct read-back. Use a test workspace. By default it changes one note you name and restores it; `--full` also creates a temporary tag, note, feature and team, runs every write tool on them and deletes them. The variables it needs are listed at the top of the file.

```bash
PB_TOKEN=… NOTE_ID=… LINK_ENTITY_ID=… COMPANY_ID=… OWNER_EMAIL=… TAG=… npm run test:live:write
```

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | OAuth flow and consent page |
| `src/tools.ts` | The read tools |
| `src/write-tools.ts` | The opt-in write tools |
| `test/live-tools.ts` | Live test of the read tools against a real workspace |
| `test/live-write-tools.ts` | Live test of the write tools |
| `wrangler.jsonc` | Worker name, KV binding and public settings |
| `dist/worker.js` | Pre-built single file for dashboard-only deployment (run `npm run bundle` to rebuild) |
| `SETUP.md` | Deployment manual |

## Built on

- [`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider): the OAuth 2.1 server for MCP clients, including consent, PKCE, dynamic client registration and token storage.
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk): stateless Streamable HTTP transport, so no Durable Objects are needed.
