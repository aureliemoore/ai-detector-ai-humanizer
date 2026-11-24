import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp, configuration } from "../server.js";

const secret = "sk-wp-test_secret_server_only_123456789";
const paragraph =
  "这是用于自动化验收的合成文本，不包含任何真实用户资料。我们测试检测额度、服务端密钥保护、确认计费和请求恢复，以确保工具可以稳定使用。";
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + server.address().port;
}
async function harness(t, overrides = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: raw && JSON.parse(raw),
    });
    if (overrides.handler) return overrides.handler(req, res);
    let data;
    if (req.url.endsWith("/account"))
      data = {
        balanceCents: 1200,
        quota: { remaining: 6, used: 0, reserved: 0, limit: 6 },
        apiKey: secret,
      };
    else if (req.url.endsWith("/quote"))
      data = {
        chargedAmountCents: 500,
        billingUnits: 70,
        billingUnitName: "chars",
        discountLabel: "原价",
        affordable: true,
        balanceCents: 1200,
      };
    else
      data = {
        requestKey: req.headers["idempotency-key"] || "test_request_key_0001",
        kind: "rewrite",
        status: "completed",
        result: {
          text: "这是已经完成优化的合成正文，服务端测试不会读取或消耗任何生产用户资料。",
          apiKey: secret,
        },
        billing: { chargedAmountCents: 500, refunded: false, apiKey: secret },
      };
    res.writeHead(
      req.method === "POST" && req.url.endsWith("/rewrite") ? 202 : 200,
      { "Content-Type": "application/json", "X-Private-Key": secret },
    );
    res.end(JSON.stringify({ success: true, data, secret }));
  });
  const apiBase = await listen(upstream);
  const config = configuration({
    WRITERPRO_API_KEY: secret,
    WRITERPRO_API_BASE: apiBase + "/text-api/v1",
    PORT: "0",
    ...overrides.env,
  });
  const app = await createApp(config, { timeout: overrides.timeout || 2000 });
  const base = await listen(app);
  t.after(() => {
    app.closeAllConnections();
    upstream.closeAllConnections();
    app.close();
    upstream.close();
  });
  const call = (path, body, extra = {}) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "X-Requested-With": "writerpro-text",
        ...extra.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      ...Object.fromEntries(
        Object.entries(extra).filter(([k]) => k !== "headers"),
      ),
    });
  return { base, app, seen, call };
}
test("configuration refuses public exposure without password, origin or HTTPS", () => {
  assert.throws(() => configuration({ HOST: "0.0.0.0" }), /ACCESS_PASSWORD/);
  assert.throws(
    () =>
      configuration({ HOST: "0.0.0.0", ACCESS_PASSWORD: "long-password-here" }),
    /PUBLIC_ORIGIN/,
  );
  assert.throws(
    () =>
      configuration({
        HOST: "0.0.0.0",
        ACCESS_PASSWORD: "long-password-here",
        PUBLIC_ORIGIN: "http://example.com",
      }),
    /HTTPS/,
  );
  assert.throws(
    () => configuration({ WRITERPRO_API_BASE: "http://example.com" }),
    /HTTPS/,
  );
  assert.throws(
    () => configuration({ WRITERPRO_API_BASE: "https://secret@example.com" }),
    /credentials/,
  );
  assert.throws(
    () =>
      configuration({
        PUBLIC_ORIGIN: "https://example.com/path",
        ACCESS_PASSWORD: "long-password-here",
      }),
    /origin/,
  );
});
test("page and assets render without dependency download or exposed API Key", async (t) => {
  const h = await harness(t);
  for (const path of [
    "/",
    "/app.js",
    "/style.css",
    "/favicon.svg",
    "/api/config",
  ]) {
    const res = await h.call(path);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(secret));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(
      res.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
  }
  assert.equal(h.seen.length, 0);
});
test("server-only key, fixed upstream, body/response/header allowlists", async (t) => {
  const h = await harness(t);
  let res = await h.call("/api/account");
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes(secret));
  res = await h.call(
    "/api/rewrite",
    {
      text: paragraph,
      target: "维普",
      maxChargeCents: 500,
      userId: 1,
      price: 0,
      url: "https://evil.invalid",
      apiKey: "evil",
    },
    { headers: { "Idempotency-Key": "request_stable_key_001" } },
  );
  assert.equal(res.status, 202);
  const body = await res.text();
  assert.ok(!body.includes(secret));
  assert.equal(res.headers.get("x-private-key"), null);
  assert.equal(h.seen[1].headers.authorization, "Bearer " + secret);
  assert.equal(h.seen[1].headers["idempotency-key"], "request_stable_key_001");
  assert.deepEqual(h.seen[1].body, {
    text: paragraph,
    target: "维普",
    maxChargeCents: 500,
  });
});
test("static file allowlist rejects secrets, source and path traversal", async (t) => {
  const h = await harness(t);
  for (const p of [
    "/.env",
    "/server.js",
    "/package.json",
    "/../.env",
    "/%2e%2e/.env",
    "/test/server.test.js",
    "/api/proxy?url=https://evil.invalid",
  ])
    assert.equal((await h.call(p)).status, 404, p);
  assert.equal(h.seen.length, 0);
});
test("same-origin CSRF, DNS rebinding and foreign origin are rejected before billing", async (t) => {
  const h = await harness(t);
  assert.equal(
    (
      await h.call(
        "/api/detect",
        { text: paragraph },
        { headers: { Origin: "https://evil.invalid" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await h.call(
        "/api/detect",
        { text: paragraph },
        { headers: { "X-Requested-With": "" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(h.base + "/api/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: paragraph }),
      })
    ).status,
    403,
  );
  const status = await new Promise((resolve, reject) => {
    const req = http.get(
      h.base + "/api/account",
      { headers: { Host: "evil.invalid" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(status, 403);
  assert.equal(h.seen.length, 0);
});
test("password sessions, rejected login, logout revocation and cookie flags", async (t) => {
  const h = await harness(t, {
    env: { ACCESS_PASSWORD: "independent-test-password" },
  });
  assert.equal((await h.call("/api/account")).status, 401);
  assert.equal((await h.call("/api/login", { password: "wrong" })).status, 401);
  const login = await h.call("/api/login", {
    password: "independent-test-password",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const headers = { Cookie: cookie.split(";")[0] };
  assert.equal((await h.call("/api/account", null, { headers })).status, 200);
  assert.equal((await h.call("/api/logout", {}, { headers })).status, 200);
  assert.equal((await h.call("/api/account", null, { headers })).status, 401);
});
test("login attempts are bounded", async (t) => {
  const h = await harness(t, {
    env: { ACCESS_PASSWORD: "independent-test-password" },
  });
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await h.call("/api/login", { password: "wrong" })).status,
      401,
    );
  assert.equal((await h.call("/api/login", { password: "wrong" })).status, 429);
});
test("missing configuration has explicit actionable state", async (t) => {
  const h = await harness(t, {
    env: { WRITERPRO_API_KEY: "replace_with_your_api_key" },
  });
  assert.equal(
    (await (await h.call("/api/config")).json()).data.configured,
    false,
  );
  assert.equal((await h.call("/api/account")).status, 503);
  assert.equal(h.seen.length, 0);
});
test("input limits, idempotency required and no query-string API keys", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/api/detect", { text: "short" })).status, 400);
  assert.equal(
    (await h.call("/api/detect", { text: "x".repeat(5001) })).status,
    400,
  );
  assert.equal((await h.call("/api/detect", { text: paragraph })).status, 400);
  assert.equal((await h.call("/api/account?api_key=key")).status, 404);
  assert.equal(
    (await h.call("/api/quote", { text: "x".repeat(41000) })).status,
    413,
  );
  assert.equal(h.seen.length, 0);
});
test("uncertain upstream timeout does not auto retry a paid submission", async (t) => {
  const h = await harness(t, { timeout: 30, handler: () => {} });
  const res = await h.call(
    "/api/rewrite",
    { text: paragraph, maxChargeCents: 500 },
    { headers: { "Idempotency-Key": "stable_timeout_key_01" } },
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "UPSTREAM_UNREACHABLE");
  assert.equal(h.seen.length, 1);
});
test("upstream errors cannot disclose credentials or SQL details", async (t) => {
  const h = await harness(t, {
    handler: (req, res) => {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          success: false,
          error: "DATABASE_ERROR",
          message: secret + " SELECT secret FROM config",
        }),
      );
    },
  });
  const res = await h.call("/api/account");
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes("SELECT"));
});
test("same request key is preserved on explicit retry and lookup is authenticated", async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 2; i++)
    await h.call(
      "/api/detect",
      { text: paragraph },
      { headers: { "Idempotency-Key": "stable_retry_key_001" } },
    );
  await h.call("/api/requests/stable_retry_key_001");
  assert.equal(
    h.seen[0].headers["idempotency-key"],
    h.seen[1].headers["idempotency-key"],
  );
  assert.equal(h.seen[2].method, "GET");
  assert.equal(h.seen[2].headers.authorization, "Bearer " + secret);
});
