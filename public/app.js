const $ = (id) => document.getElementById(id);
const money = (cents) =>
  typeof cents === "number" ? "¥" + (cents / 100).toFixed(2) : "—";
const show = (id, visible = true) => {
  $(id).hidden = !visible;
};
let pending = null,
  timer = null,
  lastResult = null,
  quoted = null,
  quoteText = "",
  quoteVersion = 0,
  locked = false;
const storageKey = "writerpro-text:pending-v1";
function remember(value) {
  pending = value;
  try {
    value
      ? sessionStorage.setItem(storageKey, JSON.stringify(value))
      : sessionStorage.removeItem(storageKey);
  } catch {}
}
function message(text = "") {
  $("message").textContent = text;
  show("message", Boolean(text));
}
function busy(value) {
  locked = value;
  for (const id of ["detect", "rewrite", "clear", "text"])
    $(id).disabled = value;
}
async function api(path, body, extra = {}) {
  const response = await fetch("/api" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "writerpro-text",
      ...extra.headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    ...Object.fromEntries(
      Object.entries(extra).filter(([k]) => k !== "headers"),
    ),
  });
  const json = await response.json();
  if (!response.ok || !json.success)
    throw Object.assign(new Error(json.message || "服务暂时不可用"), {
      status: response.status,
      code: json.error,
    });
  return json.data;
}
async function refreshAccount() {
  const data = await api("/account");
  $("remaining").textContent = data.quota.remaining;
  $("quota-detail").textContent =
    `已用 ${data.quota.used} 次${data.quota.reserved ? " · 处理中 " + data.quota.reserved + " 次" : ""} · 每日 00:00 重置`;
  $("balance").textContent = money(data.balanceCents);
}
function progress(title, detail, recover = false) {
  for (const id of [
    "empty-result",
    "detection-result",
    "rewrite-result",
    "result-footer",
  ])
    show(id, false);
  show("progress");
  $("progress-title").textContent = title;
  $("progress-detail").textContent = detail;
  $("request-id").textContent = pending ? "请求编号 " + pending.key : "";
  show("recover", recover);
  $("result-badge").textContent = recover ? "等待查询" : "处理中";
  show("retry-original", false);
}
function result(data) {
  clearTimeout(timer);
  lastResult = data;
  for (const id of [
    "empty-result",
    "progress",
    "detection-result",
    "rewrite-result",
    "result-footer",
  ])
    show(id, false);
  $("result-badge").textContent =
    data.status === "completed" ? "已完成" : "已结束";
  if (data.status === "completed" && data.result) {
    if (data.kind === "detect") {
      show("detection-result");
      const score = data.result.aiProbability * 100;
      $("score").textContent = score.toFixed(1) + "%";
      $("score-fill").style.width = score + "%";
      $("model").textContent = data.result.model;
      $("detected-at").textContent = new Date(
        data.result.detectedAt,
      ).toLocaleString("zh-CN");
    } else {
      show("rewrite-result");
      $("output").value = data.result.text;
      $("charged").textContent =
        "本次扣费 " + money(data.billing?.chargedAmountCents);
    }
    show("result-footer");
    $("expiry").textContent =
      "云端结果保留至 " +
      new Date(data.resultExpiresAt).toLocaleTimeString("zh-CN");
    message();
  } else {
    show("empty-result");
    message(
      data.status === "failed"
        ? data.billing?.refunded
          ? "优化未完成，本次费用已退回 API 余额。你可以修改文本后重试。"
          : "任务未完成，本次未消耗免费检测次数。请稍后重试。"
        : "结果已过期或已清除。不会重复扣费；如需再次处理，请重新提交。",
    );
  }
  remember(
    data.status === "completed"
      ? { key: data.requestKey, kind: data.kind, completed: true }
      : null,
  );
  busy(false);
  refreshAccount().catch((e) => message(e.message));
}
async function poll() {
  if (!pending) return;
  show("recover", false);
  try {
    const data = await api("/requests/" + encodeURIComponent(pending.key));
    if (["accepted", "running"].includes(data.status)) {
      progress(
        data.status === "accepted"
          ? "已提交，等待处理"
          : pending.kind === "detect"
            ? "正在分析文本特征"
            : "正在优化表达",
        pending.kind === "rewrite"
          ? "任务已记录。通常需要数分钟，刷新页面仍可查询原任务。"
          : "任务已记录，完成后自动显示结果。",
      );
      timer = setTimeout(poll, 5000);
    } else result(data);
  } catch (e) {
    if (e.status === 404) {
      if (pending.completed) {
        remember(null);
        busy(false);
        show("progress", false);
        show("empty-result");
        $("result-badge").textContent = "准备就绪";
        message("原结果已不可用或当前 API 账户已更换。可以开始新的任务。");
        return;
      }
      progress(
        "暂未查到任务",
        "请保留原编号重试；若已刷新，请重新粘贴原正文。系统使用同一编号和原确认金额，避免重复扣费。",
        true,
      );
      if (
        pending.kind === "detect" ||
        Number.isSafeInteger(pending.maxChargeCents)
      ) {
        show("retry-original");
        $("text").disabled = false;
      }
      message(e.message);
    } else {
      progress(
        "连接暂时中断",
        "任务可能仍在处理中。查询原任务不会再次扣费。",
        true,
      );
      message(e.message);
    }
  }
}
async function submit(kind, text, price, target) {
  busy(true);
  message();
  const key = crypto.randomUUID();
  remember({
    key,
    kind,
    ...(kind === "rewrite" ? { target, maxChargeCents: price } : {}),
  });
  progress("正在提交", "正在记录任务，请勿重复提交。");
  try {
    const data = await api(
      "/" + kind,
      {
        text,
        ...(kind === "rewrite" ? { maxChargeCents: price, target } : {}),
      },
      { headers: { "Idempotency-Key": key } },
    );
    if (["accepted", "running"].includes(data.status)) {
      refreshAccount().catch(() => {});
      timer = setTimeout(poll, 1200);
    } else result(data);
  } catch (e) {
    if (
      e.status >= 400 &&
      e.status < 500 &&
      e.code !== "IDEMPOTENCY_CONFLICT"
    ) {
      remember(null);
      busy(false);
      show("progress", false);
      show("empty-result");
      $("result-badge").textContent = "未提交";
      message(e.message);
    } else {
      progress(
        "等待确认提交结果",
        "连接中断不等于任务失败。请查询原任务，避免重复扣费。",
        true,
      );
      message(e.message);
    }
  }
}
function text() {
  return $("text").value.trim();
}
function validate() {
  if (text().length < 50 || text().length > 5000) {
    message("请输入 50–5000 字符的正文。");
    $("text").focus();
    return false;
  }
  return true;
}
$("text").addEventListener("input", () => {
  $("count").textContent = $("text").value.length.toLocaleString();
});
$("clear").addEventListener("click", () => {
  $("text").value = "";
  $("count").textContent = "0";
  $("text").focus();
  message();
});
$("detect").addEventListener("click", () => {
  if (validate() && !locked) submit("detect", text());
});
async function updateQuote() {
  const version = ++quoteVersion;
  quoted = null;
  $("confirm-rewrite").disabled = true;
  $("quote-price").textContent = "报价中…";
  show("quote-recharge", false);
  try {
    const target = $("target").value,
      data = await api("/quote", { text: quoteText, target });
    if (version !== quoteVersion) return;
    quoted = { ...data, target, text: quoteText };
    $("quote-price").textContent = money(data.chargedAmountCents);
    $("quote-detail").textContent =
      `${data.billingUnits} ${data.billingUnitName === "words" ? "单词" : "计费字符"} · ${data.discountLabel}`;
    $("quote-balance").textContent = "API 余额 " + money(data.balanceCents);
    $("confirm-rewrite").disabled = !data.affordable;
    show("quote-recharge", !data.affordable);
  } catch (e) {
    if (version !== quoteVersion) return;
    $("quote-price").textContent = "报价失败";
    $("quote-detail").textContent = e.message;
  }
}
$("rewrite").addEventListener("click", () => {
  if (!validate() || locked) return;
  quoteText = text();
  $("quote-dialog").showModal();
  updateQuote();
});
$("target").addEventListener("change", updateQuote);
$("confirm-rewrite").addEventListener("click", () => {
  if (!quoted || locked) return;
  const quote = quoted;
  quoted = null;
  $("quote-dialog").close();
  submit("rewrite", quote.text, quote.chargedAmountCents, quote.target);
});
$("recover").addEventListener("click", poll);
$("retry-original").addEventListener("click", async () => {
  if (!pending || !validate()) return;
  busy(true);
  show("retry-original", false);
  message();
  try {
    const data = await api(
      "/" + pending.kind,
      {
        text: text(),
        ...(pending.kind === "rewrite"
          ? { target: pending.target, maxChargeCents: pending.maxChargeCents }
          : {}),
      },
      { headers: { "Idempotency-Key": pending.key } },
    );
    if (["accepted", "running"].includes(data.status)) {
      progress("原任务已受理", "继续查询同一任务，不会重复扣费。");
      timer = setTimeout(poll, 1200);
    } else result(data);
  } catch (e) {
    progress(
      "原请求尚未恢复",
      "请核对原正文和请求状态；不要另建付费请求。",
      true,
    );
    show("retry-original");
    $("text").disabled = false;
    message(e.message);
  }
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("output").value);
    message("已复制优化文本。");
  } catch {
    $("output").select();
    message("浏览器不允许自动复制，请使用系统复制操作。");
  }
});
$("download").addEventListener("click", () => {
  const blob = new Blob([$("output").value], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "WriterPro-优化文本.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("erase").addEventListener("click", async () => {
  if (!lastResult || !confirm("清除云端结果？已完成任务的计费和检测次数不变。"))
    return;
  try {
    await api("/requests/" + lastResult.requestKey, null, { method: "DELETE" });
    lastResult.status = "expired";
    lastResult.result = null;
    result(lastResult);
  } catch (e) {
    message(e.message);
  }
});
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("/login", { password: $("password").value });
    $("password").value = "";
    message();
    await boot();
  } catch (err) {
    message(err.message);
  } finally {
    button.disabled = false;
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/logout", {});
    clearTimeout(timer);
    location.reload();
  } catch (e) {
    message(e.message);
  }
});
async function boot() {
  try {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey));
      if (
        saved &&
        /^[A-Za-z0-9_-]{16,80}$/.test(saved.key) &&
        ["detect", "rewrite"].includes(saved.kind)
      ) {
        pending = saved;
        busy(true);
      }
    } catch {}
    const config = await api("/config");
    show("setup", !config.configured);
    show("login-panel", config.passwordRequired && !config.authenticated);
    show("workspace", config.authenticated && config.configured);
    show("logout", config.authenticated && config.passwordRequired);
    if (!config.authenticated || !config.configured) return;
    await refreshAccount();
    if (pending) {
      busy(true);
      progress("恢复原任务", "正在查询上次提交的结果，不会再次扣费。");
      await poll();
    }
  } catch (e) {
    message(e.message);
  }
}
boot();
