# How the OAuth works

![OAuth flow for a hosted Productboard app](oauth-flow.svg)

The core of this project is plain OAuth: you register an app with Productboard and host it, and each person signs in through that app with their own Productboard account. After that one sign-in, the app can call the Productboard API on that person's behalf, and it keeps working on its own by refreshing tokens.

The MCP server is one way to use that access. It lets AI assistants call the API through the app. Any other client, such as a scheduled export, an internal tool or a SAP system, would use the same four steps below.

## 1. One-time setup (an admin)

1. **Register an OAuth app in Productboard.** Give it a name, a redirect URI that points at your hosted app (`https://<your-app>/callback`), and the scopes it may use. For read-only access, choose only the `:read` scopes (`entities:read`, `notes:read`, `members:read`, `teams:read`).
2. Productboard gives you a **client ID** and a **client secret**.
3. **Host the app** (here, a Cloudflare Worker). Store the client ID and client secret as server-side secrets, never in the code or in a client.

## 2. Each user connects once

1. The user adds the app's URL to their client.
2. The client asks the app for access. The app shows a consent page in the browser.
3. The app redirects the browser to **Productboard's own sign-in page**. The user signs in with their own Productboard login and approves the scopes the app asked for. Their password goes only to Productboard; the app never sees it.
4. Productboard redirects back to the app's `/callback` with a one-time code.
5. The app exchanges that code, together with its client secret and a PKCE verifier, for an **access token** and a **refresh token**.
6. The app stores both tokens encrypted (here, in Cloudflare KV), then gives the client a separate token of its own. **The Productboard tokens never leave the app.**

## 3. Every request

The client calls the app with its app token. The app looks up that user's Productboard access token and calls the Productboard API v2 as that user. Productboard returns only what both the user's permissions and the app's scopes allow, so a user can never see more through the app than they could in Productboard.

## 4. When the access token expires

Access tokens are short-lived. When one expires, the app sends the stored **refresh token** and its client secret to Productboard and gets a new access token, usually with a new refresh token as well. It stores them and carries on. The user doesn't need to do anything.

If the user revoked the app in Productboard, or an admin rotated the client secret, the refresh fails. The user then simply connects again (step 2).

## What lives where

| Item | Where it lives |
|---|---|
| Client ID and client secret | Server-side secrets of the hosted app |
| Each user's access and refresh token | App storage, encrypted per user |
| User passwords | Only Productboard |
| Productboard data | Not stored; passed through per request |

## In this repo

| Step | Code |
|---|---|
| Consent page, redirect to Productboard, `/callback` code exchange | `src/index.ts` (`defaultHandler`) |
| Encrypted token storage and the app's own tokens | `@cloudflare/workers-oauth-provider` with the `OAUTH_KV` binding |
| Refreshing the Productboard token | `src/index.ts` (`tokenExchangeCallback`) |
| Calling the API as the user | `src/tools.ts` |

[SETUP.md](../SETUP.md) walks through registering the app and hosting it.
