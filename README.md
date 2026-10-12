# Productboard read-only MCP server on Cloudflare

A minimal, **read-only** remote MCP server for Productboard. It runs as a single Cloudflare Worker and signs each user in to Productboard with OAuth.

- **Nothing to install on user machines.** Users paste one URL into their AI client and sign in to Productboard in the browser.
- **Almost no infrastructure.** One Cloudflare Worker plus one KV namespace. There are no servers, containers, databases or VMs.
- **Read-only by design, enforced twice.** Productboard only grants `:read` scopes, and the code only makes `GET` calls.
- **Per-user identity.** Each person sees only what their own Productboard account can see.

Step-by-step setup: **[SETUP.md](SETUP.md)**

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

**Operator search.** The public API only filters by exact values joined with AND. `pb_search_entities` and `pb_search_notes` therefore apply the operators themselves, over pages fetched with Productboard's own filters already applied. Supported operators: `contains`, `not_contains`, `equals`, `not_equals`, `in`, `not_in`, `is_empty`, `is_not_empty`, `gt`, `gte`, `lt`, `lte`, `before`, `after`, `in_last`, `in_next`. Periods are written like `"7 days"`, `"2 weeks"` or `"3 months"`. Fields can be named by display name (custom fields included), by ID, or as `createdAt` / `updatedAt`. A scan stops at a page boundary when it reaches `limit` or the response size budget, and returns a `resumeCursor` to continue, so no matches are dropped.

**Documents.** The public API has no endpoint for standalone Productboard documents. `pb_read_entity_document` reads the rich-text documents stored on an entity.

List tools return compact rows (id, name, status, owner, link) and a `nextPageCursor`, because a raw page of 100 features is about 700 KB. The get tools return every field under its display name, with custom fields resolved from their UUIDs; pass `raw: true` for the unmodified API response.

To add a tool, copy one `server.registerTool(...)` block in `src/tools.ts`.

## Live test

`test/live-tools.ts` runs every tool through a real MCP client against a Productboard workspace and checks each result against a direct API call. It makes `GET` requests only.

```bash
PB_TOKEN=your_api_token npm run test:live     # add PB_REGION=eu for EU workspaces
```

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | OAuth flow and consent page |
| `src/tools.ts` | The read-only MCP tools |
| `test/live-tools.ts` | Live test against a real workspace |
| `wrangler.jsonc` | Worker name, KV binding and public settings |
| `dist/worker.js` | Pre-built single file for dashboard-only deployment (run `npm run bundle` to rebuild) |
| `SETUP.md` | Deployment manual |

## Built on

- [`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider): the OAuth 2.1 server for MCP clients, including consent, PKCE, dynamic client registration and token storage.
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk): stateless Streamable HTTP transport, so no Durable Objects are needed.
