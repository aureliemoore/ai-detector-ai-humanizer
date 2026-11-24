# WriterPro Text 专用接口

Base URL：`https://a.writerpro.cn/text-api/v1`。仅服务端调用，使用现有开放平台 API Key：

```http
Authorization: Bearer <YOUR_SERVER_SIDE_API_KEY>
Content-Type: application/json
```

成功响应为 `{ "success": true, "data": ... }`。失败响应含 `success: false`、`error` 和 `message`。所有响应禁止 HTTP 缓存。账户、余额和额度来自 Key 对应的真实账户，不接受客户端指定用户 ID、折扣或价格。

| 方法   | 路径              | 功能                                                             |
| ------ | ----------------- | ---------------------------------------------------------------- |
| GET    | `/account`        | API 余额（分）、当天已用/预占/剩余次数、北京时间重置时间         |
| POST   | `/quote`          | `{text,target}`，获取费用；不扣款                                |
| POST   | `/detect`         | `{text}`，预占一次免费检测额度，返回任务                         |
| POST   | `/rewrite`        | `{text,target,maxChargeCents}`，确认最高可接受费用，返回付费任务 |
| GET    | `/requests/{key}` | 仅当前 API 账户可查询任务                                        |
| DELETE | `/requests/{key}` | 清除已结束任务的云端结果，不能取消计费或重置额度                 |

`target` 可选 `维普`、`知网`，默认 `维普`；英文路由遵循服务端现有模型规则。正文限制 50–5000 字符。

创建检测/优化任务必须传 `Idempotency-Key`，16–80 位字母、数字、下划线或连字符，推荐 UUID。**同一个逻辑提交的网络重试始终使用原编号、正文、方向和确认金额。** 同账户、同编号、不同参数返回 409；编号不会跨账户共享。创建新编号是新的请求，可能重新扣款。

任务状态：`accepted` → `running` → `completed` / `failed`，结果过期或清除后为 `expired`。提交返回 202 表示已受理；按 5 秒间隔查询即可，不要轮询创建接口。现有 API Key 自身速率上限仍然适用。

示例（Node 服务端）：

```js
const base = "https://a.writerpro.cn/text-api/v1";
const authorization = `Bearer ${process.env.WRITERPRO_API_KEY}`;
const headers = {
  Authorization: authorization,
  "Content-Type": "application/json",
};
const text = "这里放置 50–5000 字符的实际正文……";

// 免费检测，不会在额度耗尽时转为扣款。
const requestKey = crypto.randomUUID();
const response = await fetch(`${base}/detect`, {
  method: "POST",
  headers: { ...headers, "Idempotency-Key": requestKey },
  body: JSON.stringify({ text }),
});
const submitted = await response.json();
// 检查 HTTP 状态和 success 后，每 5 秒 GET /requests/{requestKey}。
// 不要把 Authorization 或环境变量返回给浏览器。
```

报价响应中的 `chargedAmountCents` 是实际报价。优化需用户明确确认后将该数值作为 `maxChargeCents` 提交；服务端重新计算，若报价升高则停止并返回 409，不按客户端价格扣费。

常见状态：400 输入错误；401 Key 不可用；402 余额不足；409 账户有任务/参数冲突/费用变化；429 次数耗尽或速率超限；503 暂时不可用或队列已满。遇到创建请求超时，应先查询原编号，不能直接生成新编号重扣。
