# CampusCart Research & Evidence Notes

> 状态：根据 `Shopping_Agent_PRD.md` 在 2026-10-03 补回的证据索引，不是一次新的实时网页核验。原 PRD 的公开资料观察日期为 2026-10-02。仓库中的价格、Offer Card、身份、商户和支付均为 synthetic sandbox data，不能引用本文件来声称实时优惠或合作关系。

## 证据使用规则

- 官方条款或官方产品页只支持其明确陈述的事实；没有公开 Agent API 不等于绝对不存在接口。
- 搜索索引、营销页或第三方比较只用于候选研究，不足以独立支持自动付款。
- 研究价格不能直接成为可执行报价；执行需要受信商户回执、版本、有效期和最终费用。
- 未进行用户访谈、真实购买、支付联调、奖励到账或商户合作验证。
- 代码中的 `verified_demo` 表示测试规则通过本地一致性校验，不表示服务商官方认证。

## 来源分组

| 编号 | 主题 | 来源与用途 | 证据限制 |
| --- | --- | --- | --- |
| S01–S03, S38 | 香港高等教育统计 | CSPE、UGC、教育局；支持学生规模和政策背景 | 不是付费用户或消费需求证明 |
| S04–S09 | iPad、教育价格、HKT education、Apple 付款 | 官方商品/帮助/条款；用于研究固定 SKU 案例 | 不是本仓库的实时商户报价或合作证明 |
| S10–S11, S37 | Tap & Go | 官方收费、条款和历史推广 | 未确认第三方 Agent 限额代扣接口 |
| S12–S19 | 信用卡与积分 | HSBC、恒生、MoneyBack、yuu | 条件和共享额度需逐次核验；MVP 未接入 |
| S20–S31 | 教育商店、零售、订阅和学生资格 | Samsung、Lenovo、adidas、Watsons、PNS、Spotify、MTR、UNiDAYS、Student Beans | 用于跨品类规则研究；当前代码未实现这些品类 |
| S32 | 学生信用卡比较 | MoneyHero 第三方资料 | 不能替代银行正式条款 |
| S33–S35 | 支付工程 | Stripe 幂等、测试、预授权文档 | 仅支持架构模式，不代表 CampusCart 接入 Stripe |
| S36 | 隐私与 AI | 香港私隐专员公署资料 | 生产上线仍需独立法律与隐私评审 |

完整 38 条 URL 与标题保留在 [`Shopping_Agent_PRD.md`](Shopping_Agent_PRD.md) 的 `SOURCE_DEFINITIONS`，避免两份链接清单产生版本漂移。

## 已复核的计算与 Demo 数据边界

| 项目 | 复核结果 | 性质 |
| --- | --- | --- |
| 金额表示 | 代码统一使用整数 cents | 真实执行的本地逻辑 |
| 成功场景 | HK$3,599 − HK$200 = HK$3,399 | Synthetic Demo 计算 |
| STOP 场景 | HK$3,399 + HK$160 = HK$3,559，超过 HK$3,500 cap HK$59 | Synthetic Demo 计算 |
| 积分 | 受余额、授权上限和兑换步长约束；旧积分价值计入参考成本 | 真实执行的本地逻辑＋Synthetic 兑换率 |
| 学生身份 | 只保存 `studentStatus`、`credentialStatus` 和 provider 状态 | Mock adapter；不是真实认证 |
| 审计 | SHA-256 前向链可检测相对已保存副本的修改 | 本地逻辑；不是第三方公证 |

## 仍需外部确认

1. HKT／Tap & Go 是否提供适合此 Agent 的测试账户、认证、限额、撤销、查询和 webhook。
2. 哪个商户能提供获授权、可锁定、带版本与有效期的最终报价。
3. 学生资格供应商的同意、最小数据、回执和保存期限。
4. 卡、WeChat Pay、AlipayHK/Alipay、八达通各自允许的 redirect／SDK／deep-link 集成模式。
5. 比赛是否接受 Sandbox 交易，以及工具轨迹、支付调用为零和审计链的证据格式。

## 当前实现对照

当前实现只声称：固定单 SKU、三个 Synthetic 路径、最小资格状态、两个本地支付 Mock、两次人工动作、一个成功交易和一个后端 STOP。多品类、退款、真实库存、真实支付、结果未知、对账和生产恢复均未完成。
