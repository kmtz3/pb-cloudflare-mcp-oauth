/**
 * Productboard read-only MCP server on Cloudflare Workers.
 *
 * Two OAuth legs:
 *   1. MCP client (Claude, Copilot, …)  ⇄  this Worker   — handled by workers-oauth-provider
 *   2. this Worker                       ⇄  Productboard  — standard auth-code + PKCE
 *
 * The Productboard access/refresh token is stored only inside the encrypted grant props
 * (KV), and is decrypted per request for the user who owns it. No database, no servers.
 */

import {
  OAuthProvider,
  OAuthError,
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from './tools.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Env {
  OAUTH_KV: KVNamespace;
  PUBLIC_URL: string;          // e.g. https://pb-mcp-readonly.example.workers.dev (no trailing slash)
  PB_REGION: string;           // "us" | "eu"
  PB_SCOPES: string;           // space-separated Productboard scopes to request ("" = app defaults)
  PB_CLIENT_ID: string;        // secret
  PB_CLIENT_SECRET: string;    // secret
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Stored encrypted in each grant; only the token holder can decrypt it. */
interface Props {
  pbAccessToken: string;
  pbRefreshToken?: string;
  pbExpiresAt?: number;        // epoch ms
  [key: string]: unknown;
}

// ── Productboard helpers ──────────────────────────────────────────────────────

const pbAppBase = (env: Env) =>
  env.PB_REGION === 'eu' ? 'https://app.eu.productboard.com' : 'https://app.productboard.com';

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

interface PbTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function pbTokenRequest(env: Env, body: Record<string, string>): Promise<{ status: number; data: PbTokenResponse }> {
  const res = await fetch(`${pbAppBase(env)}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: env.PB_CLIENT_ID, client_secret: env.PB_CLIENT_SECRET, ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as PbTokenResponse;
  return { status: res.status, data };
}

function propsFromToken(data: PbTokenResponse, previous?: Props): Props {
  return {
    pbAccessToken: data.access_token!,
    pbRefreshToken: data.refresh_token ?? previous?.pbRefreshToken,
    pbExpiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/** MCP access tokens never outlive the Productboard token behind them (max 1h). */
function ttlFor(props: Props): number {
  if (!props.pbExpiresAt) return 3600;
  return Math.max(60, Math.min(3600, Math.floor((props.pbExpiresAt - Date.now()) / 1000) - 60));
}

/** /mcp — called only after workers-oauth-provider has validated the bearer token. */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props }): Promise<Response> {
    const server = buildMcpServer({ region: env.PB_REGION }, ctx.props.pbAccessToken);
    // Stateless: a fresh server + transport per request, no Durable Objects needed.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

// ── /authorize, /callback, landing page ───────────────────────────────────────

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1f2328;line-height:1.5}
.card{border:1px solid #d0d7de;border-radius:12px;padding:24px}h1{font-size:20px;margin-top:0}
code{background:#f6f8fa;padding:2px 6px;border-radius:6px;word-break:break-all}.warn{background:#fff8c5;padding:8px 12px;border-radius:8px}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #d0d7de;background:#fff;cursor:pointer}
button.primary{background:#0969da;color:#fff;border-color:#0969da}.muted{color:#59636e;font-size:14px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function consentPage(d: ConsentDescription, handle: string): string {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  return page(`Connect ${d.clientName} to Productboard`, `
<h1>Allow <strong>${esc(d.clientName)}</strong> to read your Productboard data?</h1>
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<p class="muted">Read-only: this connector cannot create, change or delete anything. Next you will sign in to Productboard.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<p><button class="primary" name="decision" value="approve">Continue to Productboard</button> <button name="decision" value="deny">Cancel</button></p>
</form>`);
}

const html = (body: string, status = 200, headers = new Headers()) => {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers });
};

const defaultHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const oauth = env.OAUTH_PROVIDER;

    try {
      // Step 1 — MCP client sends the user here; show consent before any redirect to Productboard.
      if (url.pathname === '/authorize' && req.method === 'GET') {
        const authReq = await oauth.parseAuthRequest(req);
        const details = await oauth.describeConsent(authReq);
        const consent = await oauth.beginConsent(authReq);
        return html(consentPage(details, consent.handle), 200, consent.headers);
      }

      // Step 2 — user approved; redirect to Productboard with PKCE.
      if (url.pathname === '/authorize' && req.method === 'POST') {
        const form = await req.formData();
        const handle = String(form.get('handle'));
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(req, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(req, handle);
        const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
        const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
        const params = new URLSearchParams({
          response_type: 'code',
          client_id: env.PB_CLIENT_ID,
          redirect_uri: `${env.PUBLIC_URL}/callback`,
          state,
          code_challenge: await s256(verifier),
          code_challenge_method: 'S256',
        });
        if (env.PB_SCOPES?.trim()) params.set('scope', env.PB_SCOPES.trim());
        headers.set('Location', `${pbAppBase(env)}/oauth2/authorize?${params}`);
        return new Response(null, { status: 302, headers });
      }

      // Step 3 — Productboard redirects back; exchange the code and finish the MCP grant.
      if (url.pathname === '/callback') {
        const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
        if (url.searchParams.get('error') || !url.searchParams.get('code')) {
          headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
          return new Response(null, { status: 302, headers });
        }
        const { status, data: tok } = await pbTokenRequest(env, {
          grant_type: 'authorization_code',
          code: url.searchParams.get('code')!,
          redirect_uri: `${env.PUBLIC_URL}/callback`,
          code_verifier: data.verifier,
        });
        if (!tok.access_token) {
          console.error('Productboard token exchange failed', status, tok.error, tok.error_description);
          return html(page('Sign-in failed', `<h1>Productboard sign-in failed</h1><p>${esc(tok.error_description ?? tok.error ?? `HTTP ${status}`)}</p><p class="muted">Check the client ID/secret and redirect URI of the Productboard OAuth app.</p>`), 502);
        }
        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: crypto.randomUUID(),          // v2 has no "who am I" endpoint; each connection is its own grant
          metadata: { connectedAt: new Date().toISOString() },
          scope: original.scope,
          props: propsFromToken(tok),
        });
        headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/health') return Response.json({ ok: true });

      if (url.pathname === '/') {
        return html(page('Productboard MCP (read-only)', `
<h1>Productboard MCP — read-only</h1>
<p>Add this URL as a remote MCP server / custom connector in your AI client:</p>
<p><code>${esc(env.PUBLIC_URL)}/mcp</code></p>
<p class="muted">You will be asked to sign in to Productboard the first time. Region: ${esc(env.PB_REGION === 'eu' ? 'EU' : 'US')}.</p>`));
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const msg = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
        return html(page('Authorization error', `<h1>Something went wrong</h1><p>${esc(msg ?? 'Authorization failed.')}</p><p class="muted">Close this tab and start connecting again from your AI client.</p>`), 400);
      }
      throw error;
    }
  },
};

// ── Provider (built once per isolate; needs PUBLIC_URL from env) ─────────────

let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpApiHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',   // MCP clients self-register (DCR)
    clientIdMetadataDocumentEnabled: true,      // …or identify via a metadata URL (CIMD)
    scopesSupported: ['read', 'offline_access'],
    requiredScopes: ['read'],
    resourceMetadata: {
      resource: `${env.PUBLIC_URL}/mcp`,
      authorization_servers: [env.PUBLIC_URL],
      resource_name: 'Productboard (read-only)',
    },

    // Keep the Productboard token fresh whenever the MCP client refreshes its own token.
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      const p = props as Props;
      if (grantType === 'authorization_code') return { accessTokenTTL: ttlFor(p) };
      if (grantType !== 'refresh_token') return;

      const stillValid = !p.pbExpiresAt || p.pbExpiresAt - Date.now() > 5 * 60_000;
      if (stillValid) return { accessTokenTTL: ttlFor(p) };
      if (!p.pbRefreshToken) {
        throw new OAuthError('invalid_grant', { description: 'Productboard session expired — please reconnect.' });
      }
      const { status, data } = await pbTokenRequest(env as Env, { grant_type: 'refresh_token', refresh_token: p.pbRefreshToken });
      if (data.access_token) {
        const next = propsFromToken(data, p);
        return { newProps: next, accessTokenTTL: ttlFor(next) };
      }
      if (status === 400 || status === 401) {
        throw new OAuthError('invalid_grant', { description: 'Productboard access was revoked — please reconnect.' });
      }
      throw new OAuthError('temporarily_unavailable', { description: 'Productboard is unavailable', statusCode: 503 });
    },
  });
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.PB_CLIENT_ID || !env.PB_CLIENT_SECRET) {
      const path = new URL(request.url).pathname;
      if (path === '/' || path === '/health') {
        return Promise.resolve(html(page('Not configured', `<h1>Almost there</h1><p>Deployed, but the Productboard OAuth app is not configured yet.</p><p class="muted">Set the <code>PB_CLIENT_ID</code> and <code>PB_CLIENT_SECRET</code> secrets (see SETUP.md). Redirect URI to register in Productboard:</p><p><code>${esc(env.PUBLIC_URL)}/callback</code></p>`), path === '/health' ? 503 : 200));
      }
    }
    return getProvider(env).fetch(request, env, ctx);
  },
};
