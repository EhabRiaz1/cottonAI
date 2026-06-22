#!/usr/bin/env node
// One-time helper to mint a single-mailbox Gmail refresh token (scope gmail.readonly).
// Usage:  node gmail_get_refresh_token.mjs <CLIENT_ID> <CLIENT_SECRET>
// Sign in AS the mailbox (cottonai@ysgroup.pk) when the browser opens.
//
// Uses the loopback redirect flow (http://127.0.0.1:<port>) — no extra deps, nothing
// leaves your machine except the standard OAuth exchange with Google.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: node gmail_get_refresh_token.mjs <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const state = randomBytes(16).toString("hex");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1`);
  if (!url.searchParams.get("code")) {
    res.writeHead(400).end("Missing code");
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("State mismatch");
    return;
  }
  const code = url.searchParams.get("code");
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) {
      res.writeHead(500).end("No refresh_token returned. Revoke prior access and retry.");
      console.error("\nResponse:", JSON.stringify(data, null, 2));
      console.error("\nIf there is no refresh_token, remove the app's access at");
      console.error("https://myaccount.google.com/permissions and run this again.");
      server.close();
      process.exit(1);
    }
    res.writeHead(200, { "Content-Type": "text/plain" })
      .end("Success. You can close this tab and return to the terminal.");
    console.log("\n=== Copy this into your Supabase secret ===\n");
    console.log("GMAIL_REFRESH_TOKEN=" + data.refresh_token + "\n");
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500).end("Token exchange failed: " + e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  console.log("\nOpening browser for Google consent. Sign in AS cottonai@ysgroup.pk.\n");
  console.log("If it doesn't open, visit:\n" + authUrl + "\n");
  const opener = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${authUrl}"`);
});
