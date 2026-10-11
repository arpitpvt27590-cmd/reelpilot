# Smoke tests

Run these after deployment:
1. Open the Worker URL; the login screen should appear.
2. Wrong dashboard password should be rejected.
3. Correct password should open the dashboard.
4. `/api/session` should return `{"authenticated":true}` while signed in.
5. Open `/api/setup-check` in the same signed-in browser session; verify required secret flags and callback URL (no secret values are returned).
6. Confirm Meta's registered OAuth redirect URI exactly matches the callback URL.
7. Connect an authorized professional Instagram test account.
8. Upload an MP4 under 95 MB and publish to a test account.
9. Verify a successful result has a real Meta media ID and appears on Instagram.
10. Verify a failed attempt is shown as failed and includes a message.
11. Verify history survives a page reload.
12. Confirm no access token or app secret is visible in browser DevTools or GitHub.
