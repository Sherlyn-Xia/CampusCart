# CampusCart — Agentic Commerce Hackathon MVP

CampusCart 是面向香港高校学生的「可验证学生权益结账 Agent」。用户可以用自然语言提出一笔购买需求；Agent 通过 LangChain 调用商品、商户报价、学生资格、确定性规则引擎和支付能力等工具，再由 LangGraph 管理两次人工授权与异步暂停/恢复。最终的预算、优惠叠加、积分、Benefit Lock、ALLOW/STOP 和交易状态仍由确定性交易核心裁决。

> 所有商品、商户、优惠、身份、订单、支付和履约数据均为 **synthetic sandbox data**。Tap & Go 只是本地 Mock；信用卡、WeChat Pay、AlipayHK/Alipay、八达通是 `future_integration` 接口占位，当前没有接入任何真实服务，也不会移动资金或发货。

## 运行

要求：Node.js 22（CI 与 `.nvmrc` 均固定 major version 22，与当前 LangChain/OpenAI SDK 的正式运行要求一致）。

```bash
npm install
npm start
```

`npm start`、`npm run dev` 和 `npm run smoke:llm` 会在本地 `.env` 存在时自动加载；文件不存在时继续使用无 Key 的确定性 fallback。真实 `.env` 已被 Git 忽略，建议权限保持为 `600`。

浏览器界面位于 [http://localhost:3000](http://localhost:3000)。六步网页已经直接使用 Agent API，现场可见自然语言入口、LangChain/LangGraph 模式、真实工具轨迹、两次 `interrupt/resume`、grounded Q&A、Benefit Lock、Sandbox 支付认证页和双审计链。后续组员仍可按 OpenAPI 整体替换网页，无需修改交易核心。

```bash
npm test           # 规则、交易状态机、Agent 图、STOP-before-payment
npm run demo       # 原有确定性成功/阻止演示
npm run demo:agent # 自然语言 → 工具轨迹 → 授权 → 成功/阻止
npm run demo:audits # 重建成功、STOP、拒绝、支付失败的四份审计样本
npm run smoke:llm # 需要 OPENAI_API_KEY；真实调用一次模型，只停在首次授权前
```

## Agent 模式

默认不需要 API Key，系统运行经测试的 `langgraph_deterministic_fallback`：自然语言中的预算、积分和支付偏好由有限解析器读取，LangGraph 仍会真实调度工具、暂停授权并输出轨迹，但这不是 LLM。

如需比赛现场展示 LLM 工具选择，复制 [`.env.example`](.env.example) 中的变量到运行环境：

```bash
export OPENAI_API_KEY="..."
export CAMPUSCART_AGENT_MODEL="gpt-6-astra"
npm start
```

启用后为 `langchain_llm_tools`。LLM 只能理解意图、选择只读/评估工具和生成解释；它没有授权、创建 Benefit Lock 或付款工具。即使模型调用失败，系统也会记录失败并回退到确定性图，绝不会让模型自行决定付款。

测试套件还用本地 OpenAI-compatible 协议桩验证了“模型完全漏掉工具调用”时，确定性协调器仍会补齐身份、报价和规则工具并阻止超预算授权；这只是集成回归，不冒充真实模型调用。比赛前应在有 Key 的环境运行 `npm run smoke:llm`，保存输出作为 `langchain_llm_tools` 的真实 smoke evidence。

## Agent API（当前网页已经使用）

完整合约见 [`docs/openapi.yaml`](docs/openapi.yaml)。最小调用流程：

```bash
# 1. 自然语言创建 run
curl -X POST http://localhost:3000/api/v1/agent/runs \
  -H 'content-type: application/json' \
  -d '{"message":"帮我买这台 iPad，预算 HK$3,600，最多用 100 积分"}'

# 2. 用响应中的 pendingAction.actionId 明确授权
curl -X POST http://localhost:3000/api/v1/agent/runs/RUN_ID/resume \
  -H 'content-type: application/json' \
  -d '{"actionId":"authorize_...","decision":"approve"}'

# 3. 推荐做法：打开 pendingAction.url，在独立 Sandbox 页面完成认证。
# 测试客户端也可直接恢复当前一次性 action：
curl -X POST http://localhost:3000/api/v1/agent/runs/RUN_ID/resume \
  -H 'content-type: application/json' \
  -d '{"actionId":"payment_...","decision":"authenticated","paymentSessionId":"pauth_..."}'
```

可用端点：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/v1/agent/capabilities` | 查看 Agent 模式与适配器真实性标签 |
| POST | `/api/v1/agent/runs` | 从自然语言创建异步 Agent run |
| GET | `/api/v1/agent/runs/:id` | 读取当前 run 和待处理动作 |
| POST | `/api/v1/agent/runs/:id/resume` | 一次性恢复用户授权或支付认证 |
| POST | `/api/v1/agent/runs/:id/messages` | 询问“为什么选它/为什么阻止” |
| GET | `/api/v1/agent/runs/:id/trace` | 获取哈希链工具与状态轨迹 |
| GET | `/api/v1/agent/runs/:id/events` | 通过 Server-Sent Events 实时订阅轨迹 |
| GET | `/api/v1/agent/runs/:id/transaction` | 获取该 run 独占的交易状态与审计链 |

`actionId` 只能使用一次；过期返回 `410 ACTION_EXPIRED`，串单、绑定错误和并发重放返回 409。支付认证必须同时匹配 `runId + actionId + paymentSessionId`。支付方式被写入 Benefit Lock，认证阶段不可偷偷更换。改用另一支付方式必须重新取得商户/优惠报价并重新授权。独立支付页用 `BroadcastChannel` 通知主页面，主页面每 2.5 秒轮询作为降级。

旧 `/api/sessions` 交易接口已返回 `410 LEGACY_TRANSACTION_API_RETIRED`。Agent 创建的 transaction 标记为 `channel=agent`，即使内部代码误调用旧 `execute()` 也会返回 `AGENT_TRANSACTION_ISOLATED`。首次拒绝、支付认证失败或 Agent 运行异常都会把 transaction 置为 `CANCELLED`，关闭活动锁并清空 `pendingExecution`。

商品不会再默认回退到 iPad。自然语言必须明确匹配支持商品；只有“买这台/this item”这类指代请求，才可使用客户端显式传入且 `userConfirmed=true` 的 `selectedProduct`。例如“帮我买一串香蕉”返回 `422 UNSUPPORTED_PRODUCT`，不会创建交易。

预算没有默认值。解析器支持 `99`、`99.5`、`3,600.50` 等 HKD 格式，并在 proposal 中保留“用户原文 → integer cents”的证据。没有预算或格式不能确认时，run 为 `NEEDS_CLARIFICATION`：仍可展示比较，但不会生成购买授权。`只能用微信支付` 会成为硬约束并在当前无可执行 adapter 时 STOP；`最好用微信支付` 只是软偏好，不会越过可执行性规则。

## 两个比赛 Demo

### A. 成功交易

1. 提交预算 HK$3,600、最多 100 积分的自然语言需求。
2. 工具轨迹依次显示 catalog → merchant quotes → identity → deterministic evaluation → payment methods。
3. Agent 推荐 `Campus Demo Store`，现金支付 HK$3,399，并展示备选方案。
4. 用户授权后，交易核心创建 Benefit Lock 并完成最终预检；身份 adapter 的最小状态快照实际进入确定性资格判断。
5. LangGraph 暂停，返回可操作的 `/sandbox/payment-auth/...` 页面；用户模拟认证后完成交易。
6. 收据与 Agent trace 分别保留交易审计和跨工具行动证据。

### B. 被阻止交易

1. 创建 run 时传入 `context.demoScenario="blocked"`，预算 HK$3,500。
2. 用户授权后，最终报价撤回免运规则并加入 HK$160 运费，总额从 HK$3,399 变为 HK$3,559。
3. 后端规则引擎返回 `MAX_TOTAL_EXCEEDED`，状态为 `BLOCKED`。
4. 图直接进入结束节点，**不会创建支付认证 session、不会调用支付适配器、不会产生付款成功记录**。

STOP 不是网页弹窗；自动化测试断言工具轨迹中不存在 `create_payment_authorization_session`。

预算也是推荐阶段的硬约束。若所有路径的 `cashOutCents` 都超过预算，run 直接以 `NO_EXECUTABLE_PLAN` 结束，不会生成购买授权 action 或 Benefit Lock。

## 分层职责

| 层 | 技术 | 可以做 | 不能做 |
| --- | --- | --- | --- |
| 自然语言 Agent | LangChain `createAgent` | 理解目标、选择工具、生成基于事实的解释 | 授权、锁定、付款、修改裁决 |
| 流程编排 | LangGraph `StateGraph` + interrupts | 跨工具编排、暂停/恢复、人工确认、成功/STOP 分支 | 绕过交易核心 |
| 外部工具层 | 可替换 async adapters | 商品检索、并发报价、资格状态、支付认证接口 | 将占位接口伪报成真实连接 |
| 交易核心 | 本地确定性规则/状态机 | 金额、资格、叠加、积分、Benefit Lock、预检、状态转换 | 依赖 LLM 猜测安全结论 |
| 审计 | SHA-256 前向哈希链 | 记录工具调用、人工动作和交易事件 | 冒充第三方公证 |

LangGraph 在固定网页流程里并非必需；这里采用它，是因为比赛明确需要可见的 Agent framework、跨多个异步工具、两次 human-in-the-loop 暂停和可恢复轨迹。交易状态机与 LangGraph 不是重复：前者保护资金与授权不变量，后者只编排外围工作。

## 适配器边界

适配器注册中心位于 [`src/agent/adapters/registry.js`](src/agent/adapters/registry.js)：

- Merchant adapter：`searchProducts(input)`、`fetchQuotes({ sku })`；多个商户适配器用 `Promise.all` 并发拉取并标准化报价。
- Identity adapter：`getStatus()`；只返回 `studentStatus` 和 `credentialStatus`，不返回学生证号或证件图片。
- Payment adapter：`listAvailableMethods()`、`createAuthorizationSession()`、`confirmAuthorization()`；真实接入时应以 provider redirect/SDK token/deep link + webhook 替换本地确认。

当前 `MockMerchantAdapter` 已证明接口与异步编排，但确定性交易核心仍只认固定 seed SKU/路径。也就是说，新商户报价现在可以被 Agent 拉取和展示，**尚不能自动成为可执行报价**；生产化前需要增加“规范化报价 → 版本化规则注册表”的受信导入与签名/有效期校验，不能把任意 adapter 输出直接送去付款。

支付能力：

| 方法 | 当前状态 | 当前行为 |
| --- | --- | --- |
| Tap & Go | `sandbox` | 本地 redirect 占位，可完成沙盒认证 |
| Campus Wallet | `sandbox` | 本地 redirect 占位，可完成沙盒认证 |
| Credit card | `future_integration` | 只暴露 `sdk_token` 合约，不能执行 |
| WeChat Pay | `future_integration` | 只暴露 redirect 合约，不能执行 |
| AlipayHK / Alipay | `future_integration` | 只暴露 redirect 合约，不能执行 |
| Octopus | `future_integration` | 只暴露 app deep-link 合约，不能执行 |

## Benefit Lock 与双状态机

Benefit Lock 绑定精确 SKU、商户、规则 ID/版本/来源/观察时间、支付上限、积分权限、指定支付方式、15 分钟有效期、单次使用状态和用户授权状态，并对不可变字段生成 SHA-256 digest。

交易核心状态机：

```text
DRAFT → OPTIONS_EVALUATED → USER_AUTHORIZED → BENEFIT_LOCKED
      → PRECHECK → PAYMENT_AUTH_REQUIRED → PAYMENT_EXECUTED → COMPLETED
                 ↘ BLOCKED
      ↘ NEEDS_CLARIFICATION (missing/invalid budget or ambiguous input)
      ↘ CANCELLED (reject / auth failed / runtime failure)
      ↘ EXPIRED (unused human action timed out)
```

Agent 图：

```text
discover tools → [interrupt: purchase authorization]
  → authorize + Benefit Lock + PRECHECK
      ├─ BLOCKED → finish
      └─ ALLOW → create payment auth → [interrupt: user authentication]
                   → complete payment → finish
```

付款认证之前先做最终预检；认证后提交前再次预检，避免报价在认证过程中变化。拒绝或认证失败会关闭锁；已经完成、阻止或取消的交易不能继续付款。

## 数据、测试与目录

种子数据位于 [`src/domain/seed.js`](src/domain/seed.js)：1 个固定 SKU、1 个最小身份、3 条购买路径、5 张 Offer Card、2 个本地支付 Mock。每张 Offer Card 包含资格、有效期、叠加、最低消费、价值、支付限制、来源、更新时间、规则版本和验证状态。

```text
public/app.js                    Agent 六步移动端 Web UI
public/payment-auth.*           可操作的独立 Sandbox 认证页
src/agent/runtime.js              LangGraph 图、interrupt/resume
src/agent/coordinator.js          LangChain Agent 与 grounded Q&A
src/agent/tools.js                可追踪工具定义
src/agent/adapters/               Merchant / identity / payment 接口与 Mock
src/domain/rule-engine.js         确定性资格、组合、金额与最终预检
src/domain/transaction-service.js Benefit Lock 与交易状态机
docs/openapi.yaml                 后续网页可直接使用的 Agent API 合约
tests/agent-runtime.test.js       商品/身份/预算、两次授权、取消隔离、并发与 STOP
tests/http-api.test.js            Agent HTTP、SSE、认证页与旧 API 退役合约
docs/demo-audits/                 四条真实沙盒运行生成的演示审计样本
```

内存中的 `MemorySaver`、run store 和交易 store 会随服务重启清空，只适合 48 小时 Hackathon。接真实异步 provider 前必须换成持久 checkpointer/数据库、webhook 验签、幂等键、过期任务恢复与并发预算预占。`PAYMENT_RESULT_UNKNOWN` 没有为了“凑状态”而伪造：当前 Mock 在提交时同步返回确定结果；只有接入真实异步 provider/webhook 后才应加入该状态与对账恢复路径。

更完整的信任边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。本项目以 [`Shopping_Agent_PRD.md`](Shopping_Agent_PRD.md) 为研究与规则底座，但只完成固定单 SKU 的纵向闭环；没有完成 PRD 中的多品类、退款对账、支付未知结果、生产履约和真实集成。
