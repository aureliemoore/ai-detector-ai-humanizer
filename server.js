import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  randomBytes,
  createHmac,
  scryptSync,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const hashPassword = promisify(scrypt);
const KEY_PATTERN = /^sk-wp-[A-Za-z0-9_-]{20,100}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const fail = (status, code, message) =>
  Object.assign(new Error(message), { status, code });
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function configuration(env = process.env) {
  const host = env.HOST || "127.0.0.1",
    port = Number(env.PORT || 3080);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("PORT must be an integer from 0 to 65535");
  const password = env.ACCESS_PASSWORD || "";
  const publicOrigin = env.PUBLIC_ORIGIN
    ? new URL(env.PUBLIC_ORIGIN).origin
    : "";
  if (
    env.PUBLIC_ORIGIN &&
    new URL(env.PUBLIC_ORIGIN).href !== publicOrigin + "/"
  )
    throw Error("PUBLIC_ORIGIN must be an origin without a path");
  if ((!LOCAL_HOSTS.has(host) || publicOrigin) && password.length < 12)
    throw Error(
      "Public hosting requires ACCESS_PASSWORD of at least 12 characters",
    );
  if (password && password.length < 12)
    throw Error("ACCESS_PASSWORD must be at least 12 characters");
  if (!LOCAL_HOSTS.has(host) && !publicOrigin)
    throw Error("Public hosting requires PUBLIC_ORIGIN");
  if (publicOrigin && !publicOrigin.startsWith("https://"))
    throw Error("PUBLIC_ORIGIN must use HTTPS");
  const apiBase = new URL(
    env.WRITERPRO_API_BASE || "https://a.writerpro.cn/text-api/v1",
  );
  if (
    (apiBase.protocol !== "https:" &&
      !(apiBase.protocol === "http:" && LOCAL_HOSTS.has(apiBase.hostname))) ||
    apiBase.username ||
    apiBase.password ||
    apiBase.search ||
    apiBase.hash
  )
    throw Error(
      "API base must be HTTPS (HTTP allowed only for local tests) without credentials, query or fragment",
    );
  return {
    host,
    port,
    password,
    publicOrigin,
    apiBase: apiBase.href.replace(/\/$/, ""),
    apiKey: env.WRITERPRO_API_KEY || "",
  };
}
function output(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}
async function jsonBody(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json"))
    throw fail(415, "JSON_REQUIRED", "请使用 JSON 提交");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 40000) throw fail(413, "BODY_TOO_LARGE", "正文过长");
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error();
    return data;
  } catch {
    throw fail(400, "INVALID_JSON", "请求格式错误");
  }
}
const safeNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
// Explicit response allowlist: upstream headers, credentials and stack traces never reach the browser.
function pick(data, names) {
  return Object.fromEntries(
    names.filter((n) => Object.hasOwn(data || {}, n)).map((n) => [n, data[n]]),
  );
}
function safeData(route, data) {
  if (!data || typeof data !== "object")
    throw fail(502, "INVALID_RESPONSE", "服务返回异常，请稍后查询");
  if (route === "/account")
    return {
      balanceCents: safeNumber(data.balanceCents),
      quota: pick(data.quota, [
        "limit",
        "used",
        "reserved",
        "remaining",
        "day",
        "resetsAt",
        "timeZone",
        "scope",
      ]),
      minCharacters: 50,
      maxCharacters: 5000,
      resultRetentionMinutes: 60,
    };
  if (route === "/quote")
    return pick(data, [
      "chargedAmountCents",
      "baseAmountCents",
      "billingUnits",
      "billingUnitName",
      "discountLabel",
      "discountRate",
      "balanceCents",
      "affordable",
      "providerLabel",
      "charged",
    ]);
  if (data.deleted === true) return { deleted: true };
  const result = data.result
    ? pick(data.result, [
        "aiProbability",
        "model",
        "detectedAt",
        "text",
        "target",
      ])
    : null;
  return {
    ...pick(data, ["requestKey", "kind", "status", "error", "resultExpiresAt"]),
    result,
    billing: data.billing
      ? pick(data.billing, [
          "chargedAmountCents",
          "billingUnits",
          "billingUnitName",
          "discountLabel",
          "refunded",
        ])
      : null,
  };
}
const ERRORS = {
  UNAUTHORIZED: "API Key 无效，请让部署者检查服务端配置。",
  AUTH_FAILED: "API Key 无效、过期或请求过于频繁，请稍后重试或检查配置。",
  DAILY_QUOTA_EXHAUSTED:
    "今天 6 次免费检测已用完，北京时间 00:00 恢复，不会自动扣费。",
  INSUFFICIENT_BALANCE: "API 账户余额不足，请到 WriterPro API 控制台充值。",
  ACCOUNT_BUSY: "该 API 账户有任务正在处理，请等待完成。",
  QUEUE_FULL: "服务繁忙，未扣费、未占用次数，请稍后重试。",
  PRICE_CHANGED: "费用发生变化，请重新查看报价并确认。",
  IDEMPOTENCY_CONFLICT: "请求编号与正文不一致，请先恢复原任务。",
  REQUEST_NOT_FOUND:
    "未找到此账户的任务。如果刚刚提交失败，可以使用原请求编号重试。",
  TEXT_LENGTH: "请输入 50–5000 字符的正文。",
  INVALID_TARGET: "请选择支持的优化方向。",
  TASK_RUNNING: "任务正在处理中，请完成后再清除结果。",
  PRICE_CONFIRMATION_REQUIRED: "请先查看报价并确认费用。",
  ACCOUNT_UNAVAILABLE: "API 账户暂不可用，请检查控制台。",
};

export async function createApp(config = configuration(), options = {}) {
  const assets = new Map();
  for (const [url, name, type] of [
    ["/", "index.html", "text/html"],
    ["/app.js", "app.js", "text/javascript"],
    ["/style.css", "style.css", "text/css"],
    ["/favicon.svg", "favicon.svg", "image/svg+xml"],
  ]) {
    assets.set(url, {
      body: await readFile(new URL("./public/" + name, import.meta.url)),
      type,
    });
  }
  const sessionSecret = randomBytes(32),
    salt = randomBytes(16);
  const expected = config.password
    ? scryptSync(config.password, salt, 32)
    : null;
  const buckets = new Map(),
    revoked = new Map();
  let active = 0;
  const sign = (value) =>
    createHmac("sha256", sessionSecret).update(value).digest("base64url");
  const cookie = (value, maxAge) =>
    `writerpro_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.publicOrigin ? "; Secure" : ""}`;
  function tokenOf(req) {
    return (
      (req.headers.cookie || "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("writerpro_session="))
        ?.slice(18) || ""
    );
  }
  function authorized(req) {
    if (!expected) return true;
    const token = tokenOf(req),
      parts = token.split(".");
    if (
      parts.length !== 3 ||
      !/^\d{13}$/.test(parts[0]) ||
      !/^[a-zA-Z0-9_-]{32}$/.test(parts[1])
    )
      return false;
    const signature = sign(parts[0] + "." + parts[1]),
      provided = Buffer.from(parts[2]);
    return (
      Number(parts[0]) > Date.now() &&
      Number(parts[0]) < Date.now() + 86400000 &&
      !revoked.has(token) &&
      provided.length === signature.length &&
      timingSafeEqual(provided, Buffer.from(signature))
    );
  }
  function limit(key, maximum, period = 60000) {
    const now = Date.now();
    for (const [id, bucket] of buckets)
      if (bucket.until < now) buckets.delete(id);
    for (const [token, expiry] of revoked)
      if (expiry < now) revoked.delete(token);
    if (!buckets.has(key) && buckets.size >= 1000)
      throw fail(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
    const bucket = buckets.get(key) || { count: 0, until: now + period };
    bucket.count++;
    buckets.set(key, bucket);
    if (bucket.count > maximum)
      throw fail(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    try {
      const host = req.headers.host || "";
      const origin = config.publicOrigin || `http://${host}`;
      const localPort = server.address()?.port;
      const allowedHosts = config.publicOrigin
        ? [new URL(config.publicOrigin).host]
        : [
            `localhost:${localPort}`,
            `127.0.0.1:${localPort}`,
            `[::1]:${localPort}`,
          ];
      if (!allowedHosts.includes(host))
        throw fail(403, "HOST_NOT_ALLOWED", "访问地址不匹配");
      const url = new URL(req.url, origin);
      if (url.origin !== origin)
        throw fail(403, "ORIGIN_NOT_ALLOWED", "请求来源不匹配");
      if (req.headers.origin && req.headers.origin !== origin)
        throw fail(403, "ORIGIN_NOT_ALLOWED", "请求来源不匹配");
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw fail(403, "ORIGIN_NOT_ALLOWED", "不允许跨站请求");
      if (req.method === "GET" && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        res.writeHead(200, {
          "Content-Type": asset.type + "; charset=utf-8",
          "Cache-Control": "no-store",
        });
        return res.end(asset.body);
      }
      if (!url.pathname.startsWith("/api/"))
        throw fail(404, "NOT_FOUND", "页面不存在");
      if (!["GET", "POST", "DELETE"].includes(req.method))
        throw fail(405, "METHOD_NOT_ALLOWED", "不支持的请求方法");
      if (
        req.method !== "GET" &&
        (req.headers.origin !== origin ||
          req.headers["x-requested-with"] !== "writerpro-text")
      )
        throw fail(403, "CSRF_REJECTED", "请从当前页面操作");
      if (req.method === "GET" && url.pathname === "/api/config")
        return output(res, 200, {
          success: true,
          data: {
            configured: KEY_PATTERN.test(config.apiKey),
            passwordRequired: Boolean(expected),
            authenticated: authorized(req),
          },
        });
      if (req.method === "POST" && url.pathname === "/api/login") {
        limit("login-global", 20);
        limit("login-" + req.socket.remoteAddress, 5, 300000);
        const body = await jsonBody(req);
        if (
          !expected ||
          typeof body.password !== "string" ||
          body.password.length > 200
        )
          throw fail(401, "LOGIN_FAILED", "访问密码不正确");
        const candidate = await hashPassword(body.password, salt, 32);
        if (!timingSafeEqual(candidate, expected))
          throw fail(401, "LOGIN_FAILED", "访问密码不正确");
        const raw =
          String(Date.now() + 12 * 3600000) +
          "." +
          randomBytes(24).toString("base64url");
        return output(
          res,
          200,
          { success: true },
          { "Set-Cookie": cookie(raw + "." + sign(raw), 43200) },
        );
      }
      if (!authorized(req))
        throw fail(401, "LOGIN_REQUIRED", "请输入此站点的访问密码");
      if (req.method === "POST" && url.pathname === "/api/logout") {
        const token = tokenOf(req);
        if (token) revoked.set(token, Number(token.split(".")[0]));
        return output(
          res,
          200,
          { success: true },
          { "Set-Cookie": cookie("", 0) },
        );
      }
      const route = url.pathname.slice(4);
      const valid =
        (req.method === "GET" &&
          (route === "/account" ||
            /^\/requests\/[A-Za-z0-9_-]{16,80}$/.test(route))) ||
        (req.method === "POST" &&
          ["/detect", "/quote", "/rewrite"].includes(route)) ||
        (req.method === "DELETE" &&
          /^\/requests\/[A-Za-z0-9_-]{16,80}$/.test(route));
      if (!valid || url.search) throw fail(404, "NOT_FOUND", "接口不存在");
      if (!KEY_PATTERN.test(config.apiKey))
        throw fail(
          503,
          "NOT_CONFIGURED",
          "请在服务端 .env 中配置自己的 WRITERPRO_API_KEY，然后重启",
        );
      limit("api", 50);
      if (active >= 4) throw fail(429, "BUSY", "请求处理中，请稍后重试");
      let payload;
      const headers = { Authorization: "Bearer " + config.apiKey };
      if (req.method === "POST") {
        const data = await jsonBody(req);
        if (
          typeof data.text !== "string" ||
          data.text.trim().length < 50 ||
          data.text.length > 5000
        )
          throw fail(400, "TEXT_LENGTH", "请输入 50–5000 字符的正文");
        payload = JSON.stringify(
          pick(data, [
            "text",
            "target",
            ...(route === "/rewrite" ? ["maxChargeCents"] : []),
          ]),
        );
        headers["Content-Type"] = "application/json";
        if (route !== "/quote") {
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(key))
            throw fail(400, "INVALID_REQUEST_KEY", "缺少有效请求编号");
          headers["Idempotency-Key"] = key;
        }
      }
      active++;
      try {
        const response = await (options.fetch || fetch)(
          config.apiBase + route,
          {
            method: req.method,
            headers,
            body: payload,
            redirect: "error",
            signal: AbortSignal.timeout(options.timeout || 15000),
          },
        );
        // Bounded reads protect this lightweight server from oversized upstream responses.
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 400000) throw Error("upstream size");
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!response.ok || data.success !== true) {
          const code =
            typeof data.error === "string" && Object.hasOwn(ERRORS, data.error)
              ? data.error
              : response.status === 402
                ? "INSUFFICIENT_BALANCE"
                : "UPSTREAM_ERROR";
          throw fail(
            response.status >= 400 && response.status < 500
              ? response.status
              : 503,
            code,
            ERRORS[code] ||
              "服务暂不可用，请保留原请求编号，稍后查询任务状态。",
          );
        }
        output(res, response.status, {
          success: true,
          data: safeData(route, data.data),
        });
      } catch (e) {
        if (e.status) throw e;
        throw fail(
          503,
          "UPSTREAM_UNREACHABLE",
          "连接暂时中断，请保留原请求编号，稍后查询；不要重复创建付费任务。",
        );
      } finally {
        active--;
      }
    } catch (e) {
      if (!res.headersSent)
        output(res, e.status || 500, {
          success: false,
          error: e.code || "INTERNAL_ERROR",
          message: e.status ? e.message : "服务暂不可用，请稍后重试",
        });
      else res.end();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.maxConnections = 100;
  return server;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const config = configuration();
    const server = await createApp(config);
    server.listen(config.port, config.host, () => {
      console.log(
        "WriterPro Text ready: " +
          (config.publicOrigin ||
            `http://${config.host}:${server.address().port}`),
      );
      if (!KEY_PATTERN.test(config.apiKey))
        console.log(
          "Configure WRITERPRO_API_KEY in the server .env file and restart.",
        );
    });
    server.on("error", () => {
      console.error("Could not start server. Check HOST and PORT.");
      process.exitCode = 1;
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  } catch (e) {
    console.error("Startup configuration error: " + e.message);
    process.exitCode = 1;
  }
}
