# Setup guide: Productboard read-only MCP on Cloudflare

You need about 30 minutes and no software installed. Everything is done in a web browser.

**What you need**
- A Cloudflare account. The free plan is fine to start with.
- A Productboard account that is allowed to register OAuth apps for your workspace (usually an admin).
- The file `dist/worker.js` from this folder.

**The values you'll collect along the way**

| Value | Example | You get it in |
|---|---|---|
| Worker URL | `https://pb-mcp-readonly.yourteam.workers.dev` | Step 1 |
| Productboard Client ID | `abc123…` | Step 4 |
| Productboard Client Secret | `s3cr3t…` | Step 4 |

---

## Step 1: Create the Worker

1. Sign in at **https://dash.cloudflare.com**.
2. In the left menu, open **Compute (Workers) → Workers & Pages**.
3. Click **Create** → **Create Worker** (the "Hello World" starter).
4. Set the name to `pb-mcp-readonly`. You can choose another name, but use the same one throughout this guide.
5. Click **Deploy**.
6. **Copy the URL shown**, for example `https://pb-mcp-readonly.yourteam.workers.dev`. This is your **Worker URL**. Note it without a trailing `/`.

## Step 2: Upload the code

1. On the Worker page, click **Edit code**.
2. Open the file `worker.js` in the editor. Select all of its contents and delete them.
3. Open `dist/worker.js` from this folder in Notepad. Select all, copy, and paste it into the Cloudflare editor.
4. Click **Deploy**, then go back to the Worker page.

## Step 3: Add storage and settings

### 3a. Create the storage (KV)
1. In the left menu, open **Storage & Databases → KV**.
2. Click **Create** and name it `OAUTH_KV`.

### 3b. Connect the storage to the Worker
1. Go back to your Worker and open **Settings → Bindings → Add → KV namespace**.
2. Set **Variable name** to `OAUTH_KV`. It must be exactly this.
3. Set **KV namespace** to `OAUTH_KV`, then click **Save**.

### 3c. Compatibility settings
In **Settings → Runtime** (sometimes labelled "Compatibility"):
- Set **Compatibility date** to `2026-09-01`.
- Under **Compatibility flags**, add `nodejs_compat` and `global_fetch_strictly_public`.

### 3d. Variables
In **Settings → Variables and Secrets**, add these three as type **Text**:

| Name | Value |
|---|---|
| `PUBLIC_URL` | Your **Worker URL** from Step 1, with no trailing `/` |
| `PB_REGION` | `us`, or `eu` if you sign in at `app.eu.productboard.com` |
| `PB_SCOPES` | `entities:read notes:read members:read teams:read` |

Click **Deploy** (or **Save**). Then open your Worker URL in the browser. You should see **"Almost there"** and a **redirect URI** that ends in `/callback`. Copy that redirect URI for Step 4.

## Step 4: Register the Productboard OAuth app

1. In Productboard, open the OAuth app registration page. This is under the workspace settings for integrations and the API; see Productboard's developer docs at https://developer.productboard.com if you can't find it.
2. Create a new app:
   - **Name**: for example `SAP – AI assistant (read-only)`
   - **Redirect URI**: `<Worker URL>/callback` (the value you copied at the end of Step 3)
   - **Scopes**: select only the **read** scopes: `entities:read`, `notes:read`, `members:read`, `teams:read`
3. Save the app, then copy the **Client ID** and **Client Secret**.

## Step 5: Add the secrets

Back in Cloudflare, open your Worker → **Settings → Variables and Secrets**. Add these two as type **Secret**:

| Name | Value |
|---|---|
| `PB_CLIENT_ID` | the Client ID from Step 4 |
| `PB_CLIENT_SECRET` | the Client Secret from Step 4 |

Click **Deploy**. Then open your Worker URL again. It should now show **"Productboard MCP — read-only"** together with your MCP URL, which is `<Worker URL>/mcp`.

## Step 6: Connect an AI client

Give users the **MCP URL** (`<Worker URL>/mcp`). In their AI client, they add it as a remote MCP server or custom connector. The exact menu depends on the client:

- **Claude (web/desktop)**: Settings → Connectors → *Add custom connector* → paste the URL.
- **Microsoft Copilot Studio**: Tools → Add a tool → *Model Context Protocol* → paste the URL, and choose OAuth with dynamic discovery.
- **VS Code / GitHub Copilot**: *MCP: Add Server* → HTTP → paste the URL.

The first time it's used, a browser window opens with the following screens:
1. **"Allow … to read your Productboard data?"** The user clicks **Continue to Productboard**.
2. The Productboard sign-in and consent screen. The user approves it.
3. The browser returns to the AI client, which is now connected.

Test it by asking the client: *"List 5 features from Productboard."*

---

## Day-to-day operations

| Task | How |
|---|---|
| See errors and usage | Worker → **Observability** (logs). |
| Disconnect one user | The user removes the connector in their AI client, or revokes the app in their Productboard settings. |
| Disconnect everyone immediately | Regenerate the Client Secret in Productboard and update `PB_CLIENT_SECRET`. Existing sessions then fail at their next refresh, within about an hour at most. |
| Use a company domain | Worker → **Settings → Domains & Routes → Add custom domain**. Then update `PUBLIC_URL` and the Productboard redirect URI to the new domain. |
| Update the code | Repeat Step 2 with a new `dist/worker.js`. Settings and secrets are kept. |

## Limits and cost

- **Free plan**: 100,000 requests a day and 1,000 KV writes a day. Each new connection or token refresh uses a few KV writes, so this suits a pilot of a few dozen users.
- **Production**: Workers Paid is $5/month per account and raises the KV write limit to millions.

## Security summary (for IT review)

- **Read-only.** The Productboard app is granted only `:read` scopes, and the code only makes `GET` requests to the Productboard v2 API.
- **No data stored.** Productboard data passes through the Worker in memory only. KV holds only OAuth records: client registrations, hashed tokens, and the encrypted Productboard token for each user.
- **Token isolation.** Each user's Productboard token is encrypted with a key derived from that user's own MCP token. Cloudflare staff or anyone else with access to KV cannot read it without that token.
- **Standards.** OAuth 2.1 with PKCE in both directions, a consent screen that can't be framed or forged, and state bound to the browser through cookies (`@cloudflare/workers-oauth-provider`).
- **Short-lived tokens.** MCP access tokens last at most 1 hour and never outlive the Productboard token behind them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The Worker URL shows "Almost there" | `PB_CLIENT_ID` or `PB_CLIENT_SECRET` is missing (Step 5). |
| Productboard says the redirect URI is invalid | The Productboard app's redirect URI must equal `PUBLIC_URL` + `/callback` exactly, including `https://` and with no trailing slash. |
| "Productboard sign-in failed" | The Client ID or Secret is wrong, or `PB_REGION` doesn't match the workspace (US vs EU). |
| Tools return `403` | The Productboard app is missing a read scope, or the user lacks permission in Productboard. |
| A page error mentions `OAUTH_KV` | Step 3b is missing, or the variable name isn't exactly `OAUTH_KV`. |

---

## Alternative: deploy from a command line

For a developer with Node.js 20 or later:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV     # paste the id into wrangler.jsonc
# edit wrangler.jsonc: set PUBLIC_URL (you can deploy once first to learn the URL), PB_REGION, PB_SCOPES
npx wrangler secret put PB_CLIENT_ID
npx wrangler secret put PB_CLIENT_SECRET
npm run deploy
```

To test locally, put `PB_CLIENT_ID` and `PB_CLIENT_SECRET` in a `.dev.vars` file and run `npm run dev`.
