# ReelPilot — Instagram Reel publisher for Cloudflare

**Start with [`QUICKSTART-CLOUD-ONLY.md`](./QUICKSTART-CLOUD-ONLY.md)** for the simple update and Meta OAuth setup guide.

A Cloudflare Worker dashboard for uploading MP4 Reels and publishing them to multiple Instagram **professional** accounts through Meta's official Instagram API. It uses Cloudflare D1 for account/job metadata and encrypts access tokens at rest. It does not require Cloudflare R2.

> **Important limits / status**
>
> - The app uses Instagram Login for professional accounts and the resumable Reel upload flow. Meta may change endpoints, scopes, review requirements, or API versions; confirm the current official Meta docs before production use.
> - Publishing can only be tested end-to-end after configuring a Meta developer app and authorizing eligible accounts. No fake success is returned: a post is marked published only when Meta returns a media ID from `media_publish`.
> - Cloudflare Workers Free has a 100 MB request-body cap and this project sets a conservative 95,000,000-byte MP4 limit. Very large videos will not work. The upload request must finish within platform/network limits.
> - Cloudflare Workers Free CPU time is limited (currently 10 ms per request). This app streams the upload body rather than storing the video in the Worker. Meta processing is polled briefly; if processing takes longer, the app fails safely and tells you to check history/profile before retrying.
> - No storage provider is unlimited. D1 is used only for account metadata and history, not video files. Cloudflare D1 free quotas and Workers limits can change.
> - This is a single-owner dashboard protected by a password. Do not deploy with a weak password or expose the Meta app secret.
> - Optional cover image is a public HTTPS URL only. Local cover uploads are not implemented because this no-R2 design has no persistent image hosting.
> - Meta app configuration, account eligibility, and any required app review/business verification are manual steps and cannot be completed by this repository.

## Features

- Responsive dark dashboard with MP4 selection, local video preview, file-size validation, caption editor and account selection.
- Instagram Login authorization; supports connecting multiple eligible professional accounts.
- Encrypted access tokens in D1 using AES-GCM and a server-side encryption key.
- HttpOnly, Secure, SameSite=Lax signed dashboard session cookie.
- Individual account result statuses, per-job history and conservative duplicate-attempt protection.
- No Instagram password collection, no token in browser localStorage, no R2 dependency.

## Requirements

- A Cloudflare account able to create a free Worker and D1 database.
- A Meta developer account and Instagram app configured for Instagram API with Instagram Login.
- Node.js 20+ and npm on your computer for one-time deployment. Your computer does **not** need to stay online after deployment.
- GitHub account if you want source control (optional for deploy).

## 1. Create a Meta app

1. Go to [Meta for Developers](https://developers.facebook.com/) and create an app that supports Instagram API with Instagram Login (the exact dashboard labels may change).
2. Add/configure Instagram API with Instagram Login.
3. Configure the Instagram OAuth redirect/callback URL to exactly:
   `https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/auth/callback`
4. Request the current equivalent of `instagram_business_basic` and `instagram_business_content_publish`.
5. Add eligible Instagram professional accounts as app testers/developers while the app is in development. Follow Meta's current review requirements before connecting accounts you don't control or enabling general use.
6. Copy the **Instagram App ID and Instagram App Secret** from the Instagram API with Instagram Login setup. Do not use a Facebook App ID and do not paste secrets into source files or GitHub.
7. Instagram Personal accounts are not eligible for this professional publishing API. Use a Business or Creator account and complete any setup Meta requires. Instagram Login does not require a linked Facebook Page, unlike the Facebook Login variant.

Meta docs to verify:
- [Instagram API documentation (Meta Postman workspace)](https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00)
- [Reels publishing flow](https://www.postman.com/meta/instagram/folder/y6xustx/reels-publishing)

## 2. Install and configure Cloudflare

1. Install [Node.js LTS](https://nodejs.org/) if you do not already have it.
2. Extract this ZIP and open a terminal in the `insta-reel-publisher` directory.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Log in to Cloudflare:
   ```bash
   npx wrangler login
   ```
   Follow the browser authorization. Free Workers usage does not require subscribing to a paid Workers plan; do not activate R2 or a paid plan.
5. Create the D1 database:
   ```bash
   npx wrangler d1 create reel-publisher-db
   ```
   Copy the returned `database_id` into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
6. Apply the schema:
   ```bash
   npx wrangler d1 migrations apply reel-publisher-db --remote
   ```
7. Generate a random AES key and session secret. On macOS/Linux use:
   ```bash
   openssl rand -base64 32
   openssl rand -hex 32
   ```
   On Windows PowerShell, you can use:
   ```powershell
   $bytes = New-Object byte[] 32
   [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
   [Convert]::ToBase64String($bytes)
   [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
   ```
   The first value is `TOKEN_ENCRYPTION_KEY` (base64). The second is `SESSION_SECRET`.
8. Set server-side secrets. Replace the values with your own:
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put TOKEN_ENCRYPTION_KEY
   npx wrangler secret put INSTAGRAM_APP_ID
   npx wrangler secret put INSTAGRAM_APP_SECRET
   npx wrangler secret put INSTAGRAM_REDIRECT_URI
   ```
   For `INSTAGRAM_REDIRECT_URI`, enter your exact Worker callback URL. Older secret names `META_APP_ID`, `META_APP_SECRET`, and `META_REDIRECT_URI` are still recognized for compatibility, but the App ID must be the Instagram App ID from Instagram Login setup. Secrets are stored in Cloudflare, not in Git.
9. Deploy:
   ```bash
   npx wrangler deploy
   ```
10. Open the `workers.dev` URL shown by Wrangler, sign in using `ADMIN_PASSWORD`, and click **Connect account**.

If `INSTAGRAM_REDIRECT_URI` (or the legacy `META_REDIRECT_URI`) is set, it must exactly match the callback URL configured in the Meta developer dashboard. Keep the Worker URL stable after OAuth configuration.

## 3. GitHub source repository (optional)

1. Create a new **private** repository on GitHub.
2. Upload the project files except `.dev.vars`, `.env`, secrets, token exports, and any real user videos.
3. `.gitignore` excludes local secrets and dependencies. The Meta app secret and admin password must only be entered with `wrangler secret put`.
4. You can deploy from your terminal with Wrangler as above. Do not add secrets to GitHub Actions unless you intentionally set up a protected deployment workflow.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Fill in development secrets and set `INSTAGRAM_REDIRECT_URI` to the local callback only if your OAuth setup supports it.
3. Run `npm run db:migrate:local` and `npm run dev`.
4. Never commit `.dev.vars`.

## How video upload works

The browser sends the selected MP4 directly to the Worker endpoint for each selected account. The Worker creates an Instagram Reel media container, forwards the binary body to Meta's resumable-upload endpoint, checks processing status, then calls `media_publish`. The video is not persisted in D1 or R2.

The configured limit is 95,000,000 bytes to stay below Cloudflare's 100 MB Free request-body ceiling. The browser uses XMLHttpRequest upload events to show per-account byte-upload progress; processing/publishing status follows after the upload completes. A timeout/network interruption may leave a container on Meta. Check Instagram and history before retrying.

## Test checklist

- [ ] Sign in with correct password; incorrect password is rejected.
- [ ] Connect an eligible Instagram Creator/Business test account.
- [ ] Confirm the account appears by username.
- [ ] Select an MP4 under 95 MB and confirm preview and size.
- [ ] Select two test accounts, use a short caption, and publish.
- [ ] Confirm each result is only marked Published if Meta returns a media ID.
- [ ] Check history after both successful and failed attempts.
- [ ] Test an invalid file and an oversized file.
- [ ] Remove a test account and verify it disappears.
- [ ] Verify secrets are absent from GitHub and browser storage.
- [ ] Reauthorize an account after token expiry/revocation.

## Troubleshooting

**`Server authentication secrets are not configured`** — Set `ADMIN_PASSWORD` and `SESSION_SECRET` with `wrangler secret put`, then redeploy if required.

**Meta OAuth redirect mismatch** — Make `INSTAGRAM_REDIRECT_URI` (or the legacy `META_REDIRECT_URI`) match the Meta app callback URL exactly, including HTTPS and path. Use the Instagram App ID from Instagram Login setup, not a Facebook App ID.

**Missing permission / account not eligible** — Confirm a Business or Creator account, current scopes, app mode, app role/tester access, and Meta review status.

**Invalid/expired token** — Remove the account and connect it again. Tokens are encrypted at rest; the dashboard never displays them.

**Video upload failed / 413** — Use an MP4 smaller than 95 MB. Cloudflare Free rejects request bodies above its request-size limit.

**Processing did not finish** — Check the Instagram profile and History before retrying. Do not assume a failed HTTP request guarantees Instagram did not publish.

**Cover URL rejected** — Use a publicly accessible HTTPS image URL in a format supported by Meta. Local cover uploads are not supported in this build.

**Worker CPU/runtime or timeout error** — The free platform has execution and request-duration constraints. Very slow/large uploads may not be reliable on the free tier.

## Security notes

- Use a unique, long admin password.
- Do not share the Worker URL plus password with other people.
- Do not commit `.dev.vars`, app secrets, database exports, or tokens.
- Keep the repository private if you prefer, but a public source repository is safe only while it contains source code and no secrets.
- Rotate the Meta app secret and application encryption/session keys if they are exposed. Rotating the encryption key requires a migration/reconnection strategy for stored account tokens.
- The signed session is HttpOnly/Secure/SameSite=Lax. For a high-risk public deployment, add stricter origin/CSRF controls, login throttling, and operational monitoring before allowing untrusted users.

## Known limitations

This is a real API integration, but it has not been end-to-end tested against your Meta developer app because those credentials and authorized accounts are not available in this build environment. Meta can change the supported Graph API version and upload protocol. Confirm current documentation and test with a low-risk test account before relying on it for important posts. Free hosting means best-effort service, not a contractual 24/7 uptime guarantee.
