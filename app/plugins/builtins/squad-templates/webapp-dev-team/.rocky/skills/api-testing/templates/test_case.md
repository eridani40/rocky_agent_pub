# {case_id}: {一句话描述本用例}

## 前置条件
- 服务已通过 `env_start.sh` 启动，`BASE_URL` 可达
- （如有）测试数据已准备 / 鉴权 token 已 export

## 场景描述
{说明本用例验证的功能点 / 用户路径来源}

## 步骤
1. {step1 描述} → 预期：HTTP {code}，{关键断言}
2. {step2 描述} → 预期：HTTP {code}，{关键断言}

## 预期结果
- {整体通过判据，如：所有 step 全 pass，last_run.json result=pass}
- {如有副作用清理要求，说明已 DELETE}

## 产物
- `checkpoint.json`（含回写的 result/desc）
- `response-step{N}.json`（每步响应原文）
- `last_run.json`（汇总结果）
