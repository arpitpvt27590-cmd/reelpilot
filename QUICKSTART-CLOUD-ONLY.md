# ReelPilot — cloud-only setup (read this first)

This package keeps the same ReelPilot dashboard but improves Instagram Login configuration and troubleshooting. It uses Instagram's official OAuth consent screen; it does **not** collect Instagram passwords.

## Important: the ZIP alone cannot authorize Instagram

You must create/configure an app at Meta for Developers and use the **Instagram App ID and Instagram App Secret from the “Instagram API with Instagram Login” setup**. A Facebook App ID is not interchangeable. Meta may require phone verification and may require app roles/testing or review before accounts can authorize.

## 1) Update your existing GitHub repository

1. Open your private `insta-reel-publisher` repository on GitHub.
2. Upload the contents of this ZIP's `insta-reel-publisher` folder into the repository and choose to replace the existing files when asked.
3. **Keep the real `database_id` in your existing `wrangler.toml`.** Do not replace it with the placeholder from a fresh copy. Keep your current D1 database binding and name.
4. Commit the changes. If Cloudflare is connected to this repository, it should deploy the update automatically. Wait for the deployment to finish.

Do not upload `.dev.vars`, real passwords, app secrets, access tokens, or videos to GitHub.

## 2) Configure Worker secrets in Cloudflare

Cloudflare Dashboard → Workers & Pages → your Worker → Settings → Variables and Secrets.

Set the following secrets using the **Instagram** credentials from Meta:

- `INSTAGRAM_APP_ID` — Instagram App ID, not Facebook App ID.
- `INSTAGRAM_APP_SECRET` — Instagram App Secret.
- `INSTAGRAM_REDIRECT_URI` — exact callback URL shown below.

The code also recognizes the older secret names `META_APP_ID`, `META_APP_SECRET`, and `META_REDIRECT_URI` for backward compatibility. If you already have those older names, make sure their values are the correct Instagram Login credentials and callback URI. If both old and new names exist, the `INSTAGRAM_*` values take priority.

Keep the existing `ADMIN_PASSWORD`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY` secrets. Do not reveal or send their values to anyone. The `TOKEN_ENCRYPTION_KEY` must be base64 for exactly 32 random bytes; if the existing app has already stored connected accounts, do not rotate it unless you understand that stored tokens would need to be reconnected/re-encrypted.

The callback URL must be your actual Worker origin plus `/auth/callback`, for example:

`https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/auth/callback`

Use the real hostname from your deployed website. The URL must match exactly in Cloudflare and Meta, including `https://` and `/auth/callback`.

## 3) Configure the Meta app

1. Open https://developers.facebook.com/apps/ and select your app, or create one if you do not have one.
2. Add/set up **Instagram API with Instagram Login** (sometimes shown under the Instagram product or Instagram Platform).
3. In its Business Login / OAuth settings, add the exact callback URL above as a valid OAuth redirect URI.
4. Enable the permissions/scopes:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
5. Copy the **Instagram App ID** and **Instagram App Secret** from this Instagram Login setup into Cloudflare secrets.
6. While the app is in Development mode, Meta may only allow app admins/developers/testers to authorize. Add the relevant Instagram accounts as testers where Meta provides that option, then accept the invitations from each account. For broader use, complete any app review/verification Meta requires.

Instagram Login's authorization consent screen is expected to open at `instagram.com`. The user logs in there and approves permissions; your site receives an authorization code at `/auth/callback` and exchanges it server-side. Do not ask users for Instagram passwords.

## 4) Verify configuration

1. Open your deployed Worker and sign in to the dashboard.
2. Open this URL in the same browser tab/session, replacing the hostname with your Worker URL:
   `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/api/setup-check`
3. It returns a small JSON report with booleans for whether the required settings exist, the exact callback URL, and required scopes. It never returns secret values.
4. Click **Connect account** again.

## If Instagram says “Page not available”

Check these in order:

1. `INSTAGRAM_APP_ID` is the **Instagram App ID from Instagram API with Instagram Login**, not a Facebook App ID.
2. Instagram API with Instagram Login / Business Login has been added and set up in Meta.
3. The exact callback URL ending in `/auth/callback` is registered in Meta and matches `INSTAGRAM_REDIRECT_URI` in Cloudflare.
4. Both required scopes are enabled.
5. The account is Creator or Business, and has any required tester role/invitation accepted while the app is in Development mode.
6. The Meta app is not disabled or blocked pending account verification.

If it still fails, copy only the visible error text or send a screenshot with IDs, email addresses, and tokens hidden. Never share any secret values or authorization codes.

## Hosting expectations

- The Worker runs in Cloudflare, so your laptop can be switched off after deployment.
- This is a **manual upload-and-publish dashboard**, not an automatic scheduled-post queue.
- Cloudflare Free has limits, and there is no guaranteed 24/7 uptime contract on the free tier.
- Current build accepts MP4 files under 95 MB and does not persist the video in R2.
- This package has syntax checks, but has not been end-to-end tested with your personal Meta app; only a real authorized test account can confirm the full flow.
