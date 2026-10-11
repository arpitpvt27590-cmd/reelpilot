const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const COOKIE_NAME = "reelpub_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function htmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function b64(bytes) {
  let bin = "";
  for (const byte of new Uint8Array(bytes)) bin += String.fromCharCode(byte);
  return btoa(bin);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signSession(env, value) {
  const payload = b64(new TextEncoder().encode(JSON.stringify(value)));
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64(sig)}`;
}
async function readSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + "="));
  if (!match || !env.SESSION_SECRET) return null;
  const token = match.slice(COOKIE_NAME.length + 1);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify("HMAC", key, unb64(signature), new TextEncoder().encode(payload));
    if (!valid) return null;
    const session = JSON.parse(new TextDecoder().decode(unb64(payload)));
    if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch { return null; }
}
function cookieHeader(value, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
async function requireAuth(request, env) {
  const session = await readSession(request, env);
  return session ? null : json({ error: "Your session expired. Sign in again." }, 401);
}
async function encryptionKey(env) {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY is not configured.");
  const raw = unb64(env.TOKEN_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 random bytes.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptToken(token, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return `${b64(iv)}.${b64(cipher)}`;
}
async function decryptToken(stored, env) {
  const [iv, cipher] = stored.split(".");
  const key = await encryptionKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(cipher));
  return new TextDecoder().decode(plain);
}
function apiVersion(env) { return env.GRAPH_API_VERSION || "v24.0"; }
function instagramAppId(env) { return env.INSTAGRAM_APP_ID || env.META_APP_ID || ""; }
function instagramAppSecret(env) { return env.INSTAGRAM_APP_SECRET || env.META_APP_SECRET || ""; }
function redirectUri(env, request) { return env.INSTAGRAM_REDIRECT_URI || env.META_REDIRECT_URI || `${origin(request)}/auth/callback`; }
function redirect(url, status = 302, headers = {}) {
  return new Response(null, { status, headers: { location: url, ...headers } });
}
function origin(request) { return new URL(request.url).origin; }
function safeReturnPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
async function metaFetch(url, init = {}) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const e = data.error || {};
    const error = new Error(e.message || `Meta API request failed (${response.status}).`);
    error.code = e.code;
    error.subcode = e.error_subcode;
    error.status = response.status;
    throw error;
  }
  return data;
}
function userMessage(err) {
  const m = String(err?.message || "Unexpected error");
  if (/expired|invalid.*token|session/i.test(m)) return "Instagram authorization may have expired. Remove this account and connect it again.";
  if (/rate limit|too many calls|code 4|code 17/i.test(m)) return "Meta rate limit reached. Wait and try again later.";
  if (/unsupported get request|object does not exist|permission/i.test(m)) return "Meta rejected this account or permission. Check professional-account eligibility and app permissions.";
  return m.slice(0, 500);
}
async function getTokenAndProfile(code, env, request) {
  const callbackUrl = redirectUri(env, request);
  const form = new URLSearchParams({
    client_id: instagramAppId(env),
    client_secret: instagramAppSecret(env),
    grant_type: "authorization_code",
    redirect_uri: callbackUrl,
    code
  });
  const tokenData = await metaFetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
  let token = tokenData.access_token;
  let expiresIn = tokenData.expires_in || 3600;
  // Exchange short-lived token for long-lived token where the configured API supports it.
  try {
    const long = await metaFetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(instagramAppSecret(env))}&access_token=${encodeURIComponent(token)}`);
    if (long.access_token) token = long.access_token;
    if (long.expires_in) expiresIn = long.expires_in;
  } catch { /* A short-lived token is still stored; dashboard will show auth errors if it expires. */ }
  const profile = await metaFetch(`https://graph.instagram.com/${apiVersion(env)}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
  return { token, expiresIn, profile };
}
async function listAccounts(env) {
  return env.DB.prepare("SELECT id, ig_user_id, username, created_at, token_expires_at FROM accounts ORDER BY username COLLATE NOCASE").all();
}
async function publishForAccount(request, env, account, body, jobId, resultId) {
  const token = await decryptToken(account.encrypted_token, env);
  const version = apiVersion(env);
  const base = `https://graph.instagram.com/${version}`;
  const params = new URLSearchParams({
    media_type: "REELS",
    upload_type: "resumable",
    caption: body.caption || ""
  });
  if (body.cover_url) params.set("cover_url", body.cover_url);
  const container = await metaFetch(`${base}/${encodeURIComponent(account.ig_user_id)}/media?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!container.id) throw new Error("Meta did not return a media container ID.");
  const size = Number(request.headers.get("content-length") || body.file_size || 0);
  if (!size) throw new Error("Could not determine the uploaded video size.");
  const uploadUrl = `https://rupload.facebook.com/ig-api-upload/${encodeURIComponent(container.id)}`;
  const videoResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      "offset": "0",
      "file_size": String(size),
      "Content-Type": "application/octet-stream"
    },
    body: request.body
  });
  const uploadData = await videoResponse.json().catch(() => ({}));
  if (!videoResponse.ok || uploadData.error || uploadData.success === false) {
    throw new Error(uploadData.error?.message || `Instagram video upload failed (${videoResponse.status}).`);
  }

  let statusData = {};
  for (let i = 0; i < 8; i++) {
    statusData = await metaFetch(`${base}/${encodeURIComponent(container.id)}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    if (statusData.status_code === "FINISHED") break;
    if (statusData.status_code === "ERROR" || statusData.status_code === "EXPIRED") {
      throw new Error(statusData.status || `Instagram processing status: ${statusData.status_code}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  if (statusData.status_code !== "FINISHED") {
    throw new Error("Instagram is still processing this Reel. No success was reported; check history before retrying to avoid duplicates.");
  }
  const published = await metaFetch(`${base}/${encodeURIComponent(account.ig_user_id)}/media_publish?creation_id=${encodeURIComponent(container.id)}&access_token=${encodeURIComponent(token)}`, { method: "POST" });
  if (!published.id) throw new Error("Meta did not return a published media ID; success cannot be confirmed.");
  return { mediaId: published.id, containerId: container.id };
}
async function apiRouter(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/login" && request.method === "POST") {
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ error: "Server authentication secrets are not configured." }, 503);
    const body = await request.json().catch(() => ({}));
    if (typeof body.password !== "string" || body.password.length > 300) return json({ error: "Enter your dashboard password." }, 400);
    // Constant-time-ish comparison avoids early character-by-character exits.
    const a = new TextEncoder().encode(body.password);
    const b = new TextEncoder().encode(env.ADMIN_PASSWORD);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
    if (diff !== 0) return json({ error: "Incorrect password." }, 401);
    const session = await signSession(env, { exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, nonce: crypto.randomUUID() });
    return json({ ok: true }, 200, { "set-cookie": cookieHeader(session) });
  }
  if (url.pathname === "/api/logout" && request.method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  if (url.pathname === "/api/session" && request.method === "GET") {
    const session = await readSession(request, env);
    return json({ authenticated: !!session });
  }
  if (url.pathname === "/api/setup-check" && request.method === "GET") {
    const session = await readSession(request, env);
    if (!session) return json({ error: "Sign in first." }, 401);
    const callbackUrl = redirectUri(env, request);
    return json({
      instagramAppIdConfigured: !!instagramAppId(env),
      instagramAppSecretConfigured: !!instagramAppSecret(env),
      tokenEncryptionKeyConfigured: !!env.TOKEN_ENCRYPTION_KEY,
      databaseConfigured: !!env.DB,
      callbackUrl,
      requiredScopes: ["instagram_business_basic", "instagram_business_content_publish"],
      appIdHint: "Use the Instagram App ID from Instagram API setup with Instagram Login, not the Facebook App ID."
    });
  }
  const authFailure = await requireAuth(request, env);
  if (authFailure) return authFailure;

  if (url.pathname === "/api/accounts" && request.method === "GET") {
    const rows = await listAccounts(env);
    return json({ accounts: rows.results.map(a => ({ id: a.id, username: a.username, connectedAt: a.created_at, tokenExpiresAt: a.token_expires_at })) });
  }
  if (url.pathname === "/api/accounts/connect" && request.method === "GET") {
    if (!instagramAppId(env) || !instagramAppSecret(env)) return json({ error: "Instagram App ID or App Secret is missing. Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET in Cloudflare Worker secrets. The App ID must be the Instagram App ID from Instagram API setup with Instagram Login, not a Facebook App ID." }, 503);
    const state = crypto.randomUUID();
    const signed = await signSession(env, { exp: Math.floor(Date.now()/1000)+600, nonce: state, oauth: true });
    const callbackUrl = redirectUri(env, request);
    const scopes = "instagram_business_basic,instagram_business_content_publish";
    // Meta's Instagram Login authorization URL. If the developer dashboard provides an
    // authorization/embed URL, INSTAGRAM_AUTHORIZE_URL may be set to that URL; it must
    // be on instagram.com and use the same registered redirect URI.
    let authUrl;
    try {
      authUrl = env.INSTAGRAM_AUTHORIZE_URL ? new URL(env.INSTAGRAM_AUTHORIZE_URL) : new URL("https://www.instagram.com/oauth/authorize");
    } catch { return json({ error: "INSTAGRAM_AUTHORIZE_URL is not a valid URL." }, 503); }
    if (authUrl.hostname !== "www.instagram.com" || authUrl.pathname !== "/oauth/authorize") {
      return json({ error: "INSTAGRAM_AUTHORIZE_URL must use https://www.instagram.com/oauth/authorize." }, 503);
    }
    authUrl.searchParams.set("client_id", instagramAppId(env));
    authUrl.searchParams.set("redirect_uri", callbackUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("enable_fb_login", "0");
    authUrl.searchParams.set("force_authentication", "1");
    return json({ url: authUrl.toString(), state, session: signed, redirect_uri: callbackUrl, scopes });
  }
  if (url.pathname === "/api/accounts/remove" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.id) return json({ error: "Account ID is required." }, 400);
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(body.id).run();
    return json({ ok: true });
  }
  if (url.pathname === "/api/history" && request.method === "GET") {
    const jobs = await env.DB.prepare("SELECT id, created_at, caption, filename, file_size, status FROM jobs ORDER BY created_at DESC LIMIT 100").all();
    const results = await env.DB.prepare("SELECT job_id, account_id, account_name, status, message, media_id, updated_at FROM job_results ORDER BY updated_at ASC").all();
    const byJob = {};
    for (const r of results.results) (byJob[r.job_id] ||= []).push(r);
    return json({ jobs: jobs.results.map(j => ({ id:j.id, createdAt:j.created_at, caption:j.caption, filename:j.filename, fileSize:j.file_size, status:j.status, results:byJob[j.id] || [] })) });
  }
  if (url.pathname === "/api/publish" && request.method === "POST") {
    const accountId = request.headers.get("x-account-id");
    const caption = request.headers.get("x-caption") || "";
    const filename = request.headers.get("x-filename") || "reel.mp4";
    const idempotency = request.headers.get("x-idempotency-key");
    const coverUrl = request.headers.get("x-cover-url") || "";
    const length = Number(request.headers.get("content-length") || 0);
    const max = Number(env.MAX_VIDEO_BYTES || 95000000);
    if (!accountId || !idempotency) return json({ error: "Missing account or publishing job identifier." }, 400);
    if (!request.headers.get("content-type")?.toLowerCase().includes("video/mp4")) return json({ error: "Upload must be an MP4 video." }, 415);
    if (!length || length > max) return json({ error: `Video must be under ${Math.floor(max/1000000)} MB. This limit keeps uploads within the free hosting request cap.` }, 413);
    if (caption.length > 2200) return json({ error: "Caption is too long (maximum 2,200 characters)." }, 400);
    if (coverUrl) {
      try { const c = new URL(coverUrl); if (c.protocol !== "https:") throw new Error(); }
      catch { return json({ error: "Cover URL must be a valid HTTPS URL. Local cover-image uploads are not supported in this no-storage build." }, 400); }
    }
    const prior = await env.DB.prepare("SELECT id, status, message, media_id FROM job_results WHERE id = ?").bind(`${idempotency}:${accountId}`).first();
    if (prior && ["published", "publishing", "processing"].includes(prior.status)) {
      return json({ error: "This account already has a publishing attempt for this job. Check History before retrying; duplicate prevention is active.", status: prior.status }, 409);
    }
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
    if (!account) return json({ error: "Selected Instagram account is no longer connected." }, 404);
    const now = Math.floor(Date.now()/1000);
    const jobId = idempotency;
    await env.DB.prepare(`INSERT INTO jobs (id, created_at, caption, filename, file_size, status, cover_url, idempotency_key)
      VALUES (?, ?, ?, ?, ?, 'publishing', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status='publishing'`).bind(jobId, now, caption, filename.slice(0,250), length, coverUrl || null, idempotency).run();
    const resultId = `${idempotency}:${accountId}`;
    await env.DB.prepare(`INSERT INTO job_results (id, job_id, account_id, account_name, status, message, updated_at)
      VALUES (?, ?, ?, ?, 'publishing', 'Upload started', ?)
      ON CONFLICT(id) DO UPDATE SET status='publishing', message='Upload started', updated_at=excluded.updated_at`).bind(resultId, jobId, accountId, account.username, now).run();
    try {
      const result = await publishForAccount(request, env, account, { caption, file_size:length, cover_url:coverUrl }, jobId, resultId);
      await env.DB.prepare("UPDATE job_results SET status='published', message='Instagram returned a published media ID.', media_id=?, container_id=?, updated_at=? WHERE id=?")
        .bind(result.mediaId, result.containerId, Math.floor(Date.now()/1000), resultId).run();
      await env.DB.prepare("UPDATE jobs SET status='completed' WHERE id=?").bind(jobId).run();
      return json({ ok:true, status:"published", username:account.username, mediaId:result.mediaId });
    } catch (err) {
      const message = userMessage(err);
      await env.DB.prepare("UPDATE job_results SET status='failed', message=?, updated_at=? WHERE id=?").bind(message, Math.floor(Date.now()/1000), resultId).run();
      await env.DB.prepare("UPDATE jobs SET status='partial_or_failed' WHERE id=?").bind(jobId).run();
      return json({ ok:false, status:"failed", username:account.username, error:message, duplicateSafety:"This attempt may have reached Instagram. Check your profile and History before retrying." }, 502);
    }
  }
  return json({ error: "API route not found." }, 404);
}
async function callback(request, env) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error_description") || url.searchParams.get("error_message") || url.searchParams.get("error_reason") || url.searchParams.get("error");
  if (error) return redirect("/?connect_error=" + encodeURIComponent(error.slice(0,180)));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirect("/?connect_error=" + encodeURIComponent("Meta did not return an authorization code."));
  // State is checked against a short-lived, signed, HttpOnly cookie.
  const cookie = (request.headers.get("Cookie") || "").split(";").map(x=>x.trim()).find(x=>x.startsWith("reelpub_oauth="));
  if (!cookie) return redirect("/?connect_error=" + encodeURIComponent("Authorization state was missing. Start Connect account again."));
  try {
    const signed = cookie.slice("reelpub_oauth=".length);
    const [payload, sig] = signed.split(".");
    const key = await hmacKey(env.SESSION_SECRET);
    if (!await crypto.subtle.verify("HMAC", key, unb64(sig), new TextEncoder().encode(payload))) throw new Error("Bad state signature");
    const saved = JSON.parse(new TextDecoder().decode(unb64(payload)));
    if (saved.nonce !== state || saved.exp < Math.floor(Date.now()/1000) || !saved.oauth) throw new Error("Authorization state expired");
    const { token, expiresIn, profile } = await getTokenAndProfile(code, env, request);
    const instagramUserId = profile.user_id || profile.id;
    if (!instagramUserId || !profile.username) throw new Error("Instagram did not return an account ID and username.");
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now()/1000);
    const encrypted = await encryptToken(token, env);
    await env.DB.prepare(`INSERT INTO accounts (id, ig_user_id, username, encrypted_token, token_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ig_user_id) DO UPDATE SET username=excluded.username, encrypted_token=excluded.encrypted_token,
      token_expires_at=excluded.token_expires_at, updated_at=excluded.updated_at`)
      .bind(id, String(instagramUserId), String(profile.username), encrypted, now + Number(expiresIn || 3600), now, now).run();
    return redirect("/?connected=" + encodeURIComponent(profile.username), 302, { "set-cookie": "reelpub_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  } catch (e) {
    return redirect("/?connect_error=" + encodeURIComponent(userMessage(e).slice(0,180)));
  }
}
async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/auth/callback" && request.method === "GET") return callback(request, env);
  if (url.pathname.startsWith("/api/")) {
    try {
      if (url.pathname === "/api/accounts/connect" && request.method === "GET") {
        const auth = await requireAuth(request, env);
        if (auth) return auth;
        const data = await apiRouter(request, env);
        if (!data.ok) return data;
        const payload = await data.json();
        const oauthCookie = payload.session;
        delete payload.session;
        return json(payload, 200, { "set-cookie": `reelpub_oauth=${oauthCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` });
      }
      return await apiRouter(request, env);
    } catch (e) {
      return json({ error: userMessage(e) }, 500);
    }
  }
  return env.ASSETS.fetch(request);
}
export default { fetch: handle };
