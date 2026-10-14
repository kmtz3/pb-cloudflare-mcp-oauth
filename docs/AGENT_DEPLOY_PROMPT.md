# Agent prompt: deploy to Cloudflare Workers

Paste everything below the line into a coding agent (for example Claude Code) started in an empty folder. The agent runs the commands; the person at the keyboard does the few steps that need a browser or a secret.

The deploy uses the pre-built `dist/worker.js` included in the download. Nothing is built or installed except Wrangler (Cloudflare's CLI, fetched by `npx`), and nothing is connected to GitHub.

---

You are deploying a read-only Productboard MCP server to Cloudflare Workers for the person you are working with. You will download a snapshot of the project from https://github.com/kmtz3/pb-cloudflare-mcp-oauth (a ZIP of the `main` branch, not a clone). It is a single Worker plus one KV namespace, configured by `wrangler.jsonc`, with OAuth to Productboard. The deployable code is the pre-built single file `dist/worker.js`. Read `README.md`, `SETUP.md` and `wrangler.jsonc` before you start.

This is a static deploy: do not `git clone`, do not run `git init`, do not connect a Git repository, and do not rebuild `dist/worker.js` from `src/`.

Work through the steps in order. After each step, say in one line what you did and what comes next. Stop and ask whenever a step needs the person (marked **PERSON**).

## Ground rules
- **Never ask the person to paste a secret into the chat** (Productboard client secret, Cloudflare API token). Secrets are entered by the person into an interactive `wrangler secret put` prompt or the Cloudflare dashboard.
- Never commit secrets, `.dev.vars` or `.wrangler/`.
- **The KV namespace ID in the repo belongs to someone else's account.** Always create a new namespace and replace the ID.
- Do not delete or overwrite anything already in the person's Cloudflare account. If a Worker with the chosen name already exists, ask before deploying over it.
- Do not change `src/` or `dist/worker.js`. If a step fails because of the code, explain the problem and stop.
- Always deploy with `npx --yes wrangler@4 deploy dist/worker.js --no-bundle`, which uploads the pre-built file exactly as shipped. The plain `wrangler deploy` would try to build from `src/` and needs `npm install`.

## 0. Ask first (one message)
1. Which Productboard region do they sign in to: `app.productboard.com` (US) or `app.eu.productboard.com` (EU)?
2. What should the Worker be called? Default: `pb-mcp-readonly`.
3. Do they want a custom domain (for example `pb-mcp.company.com`)? That domain must already be a zone in their Cloudflare account. Otherwise the free `*.workers.dev` URL is used.
4. Can they register an OAuth app in their Productboard workspace (usually an admin), or who can?
5. Do they already have a Cloudflare account?

## 1. Prerequisites and download
- Check that `node -v` is 20 or later (Wrangler needs it). If not, tell the person to install Node.js LTS from https://nodejs.org and stop.
- Download and unpack the snapshot into `pb-mcp-readonly/`, then work inside that folder:
  ```
  curl -fL -o pb-mcp.zip https://github.com/kmtz3/pb-cloudflare-mcp-oauth/archive/refs/heads/main.zip
  unzip -q pb-mcp.zip && mv pb-cloudflare-mcp-oauth-main pb-mcp-readonly && rm pb-mcp.zip
  ```
  On Windows without `unzip`, use `tar -xf pb-mcp.zip` (built into Windows 10 and later) or PowerShell's `Expand-Archive`.
- If the download fails (no internet access to github.com, or a proxy blocks it), **PERSON:** download https://github.com/kmtz3/pb-cloudflare-mcp-oauth/archive/refs/heads/main.zip in a browser and put it in this folder as `pb-mcp.zip`, then unpack it as above.
- Check that `pb-mcp-readonly/` contains `wrangler.jsonc` and `dist/worker.js`.
- Use `npx --yes wrangler@4 …` for every Wrangler command below. No `npm install` is needed. Where a command below says `npx wrangler`, use that form.

## 2. Connect Cloudflare
Run `npx wrangler whoami`.
- **Logged in:** confirm the account name with the person. If several accounts are listed, ask which one to use and set `"account_id"` in `wrangler.jsonc`.
- **Not logged in, and the agent shares a machine and browser with the person:** run `npx wrangler login`. **PERSON:** approve access in the browser window that opens. Then run `whoami` again.
- **No Cloudflare account:** **PERSON:** sign up for free at https://dash.cloudflare.com/sign-up and verify the email address, then do the login above.
- **The agent runs remotely (no browser):** **PERSON:** create an API token at https://dash.cloudflare.com/profile/api-tokens with the "Edit Cloudflare Workers" template, scoped to the account, and set it in your own shell (not in this chat) as `CLOUDFLARE_API_TOKEN`, along with `CLOUDFLARE_ACCOUNT_ID`. Then run `whoami` again.

## 3. Configure
1. Set `"name"` in `wrangler.jsonc` to the chosen Worker name. If `npx wrangler deployments list --name <name>` shows the name is already taken, ask before going on.
2. Run `npx wrangler kv namespace create OAUTH_KV`. Put the returned `id` into the `OAUTH_KV` entry in `wrangler.jsonc`, replacing the existing ID.
3. Set `PB_REGION` to `"us"` or `"eu"`. Leave `PB_SCOPES` as `"entities:read notes:read members:read teams:read"` unless the person asks otherwise.

## 4. First deploy, to get the URL
1. Run `npx --yes wrangler@4 deploy dist/worker.js --no-bundle`.
2. If wrangler asks to register a `workers.dev` subdomain (new accounts), **PERSON:** choose one in the prompt, or in the dashboard under Workers & Pages. Then deploy again.
3. Note the URL printed after "Deployed".

## 5. Set the public URL (and the custom domain, if wanted)
- **workers.dev:** set `PUBLIC_URL` in `wrangler.jsonc` to the printed URL, without a trailing `/`.
- **Custom domain:** add `"routes": [{ "pattern": "<host>", "custom_domain": true }]` to `wrangler.jsonc` and set `PUBLIC_URL` to `https://<host>`.

Deploy again with the same command. Then open `PUBLIC_URL` with curl and confirm the page says "Almost there" and shows the redirect URI `<PUBLIC_URL>/callback`.

## 6. Register the Productboard OAuth app
**PERSON** (or their Productboard admin), in Productboard's OAuth app registration:
- **Redirect URI:** exactly `<PUBLIC_URL>/callback`
- **Scopes:** only the read scopes, `entities:read notes:read members:read teams:read`
- Save the app and keep the client ID and client secret ready. **Do not paste them into the chat.**

## 7. Add the secrets
Tell the person to run these two commands in a terminal in the project folder. They paste each value at the prompt themselves:
```
npx wrangler secret put PB_CLIENT_ID
npx wrangler secret put PB_CLIENT_SECRET
```
If you are running remotely, they can instead add both as **Secret** values under the Worker's Settings → Variables and Secrets in the dashboard. You never handle the values.

## 8. Verify (report each result)
1. `GET <PUBLIC_URL>/` returns the page "Productboard MCP — read-only". If it still says "Almost there", the secrets are missing.
2. `GET <PUBLIC_URL>/health` returns `{"ok":true}`.
3. `POST <PUBLIC_URL>/mcp` with no token returns `401`, with a `WWW-Authenticate` header that contains `resource_metadata`.
4. `GET <PUBLIC_URL>/.well-known/oauth-protected-resource/mcp` returns `"resource": "<PUBLIC_URL>/mcp"`.
5. `GET <PUBLIC_URL>/.well-known/oauth-authorization-server` returns `"issuer": "<PUBLIC_URL>"`.
6. Optional, and the only step that installs packages: if the person has a Productboard API token for their own workspace, they can run `npm ci` and then `PB_TOKEN=… npm run test:live` themselves (add `PB_REGION=eu` for EU). It is read-only and checks every tool against their data.

## 9. Hand over
Tell the person:
- **MCP URL:** `<PUBLIC_URL>/mcp`. Add it as a custom connector or remote MCP server in their AI client: Claude (Settings → Connectors), Copilot Studio (Tools → Model Context Protocol), or VS Code (*MCP: Add Server*).
- **First use:** a browser opens with a consent page and then the Productboard sign-in. Ask them to try "list 5 features" to confirm the whole flow end to end.
- **Updating later:** download a new snapshot the same way into a separate folder, copy their edited `wrangler.jsonc` (with their `name`, KV ID, `PUBLIC_URL`, `routes` and `account_id`) over the new one, and run the same deploy command. Secrets and stored sign-ins are kept.

Finish with a short summary table:

| Item | Value |
|---|---|
| Account | |
| Worker name | |
| `PUBLIC_URL` | |
| KV namespace ID | |
| Region | |
| Scopes | |
| Verification checks | which passed |
| Next steps for the person | |

## Troubleshooting
| Symptom | Fix |
|---|---|
| `Authentication error [code: 10000]` | Run `wrangler login` again, or the API token lacks Workers permissions for this account. |
| "You need to register a workers.dev subdomain" | Step 4.2. |
| `npx` asks to install wrangler, or fails offline | Use `npx --yes wrangler@4`. The machine needs internet access to npmjs.org. |
| `More than one account available` | Set `"account_id"` in `wrangler.jsonc`. |
| The page shows "Almost there" | The secrets from step 7 are missing. Check them with `npx wrangler secret list`. |
| Productboard says the redirect URI is invalid | The app's redirect URI must equal `PUBLIC_URL` + `/callback` exactly. |
| "Productboard sign-in failed" after login | The client ID or secret is wrong, or `PB_REGION` doesn't match the workspace. |
| Productboard rejects the `scope` parameter | Set `PB_SCOPES` to `""` and redeploy. The app's own scope settings then apply. |
| A custom domain deploy fails | The domain must be an active zone in the same Cloudflare account. |
| Tools return 403 | The OAuth app lacks a read scope, or the user lacks permission in Productboard. |
