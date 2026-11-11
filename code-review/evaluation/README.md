# 离线评测语料（pipeline eval）

这个目录锁定**管道行为**，不评价模型好坏：输入是固定的 reviewer 结构化输出 fixture，
走真实的规则加载 → prompt 构建 → schema/证据校验 → 复验归并 → 渲染，断言
「该报的报、该拒的拒」。不调用模型、不联网、不引用私有仓库，可进 CI。

```bash
npm run eval                 # 人读输出
node evaluation/run.mjs --json
```

`npm test` 里的 `test/eval-corpus.test.js` 会跑同一份语料，任何回归都会让测试失败。

## case 结构

```jsonc
{
  "name": "behavior-dimension-preserved",
  "description": "这个 case 在防什么回归",
  "mode": "turn",                     // turn=按 hunk 证据校验；full=按文件全文
  "files": [
    {
      "path": "src/merge-settings.js",
      "hunks": [{ "oldStart": 1, "oldLines": 0, "newStart": 1, "newLines": 13,
                  "lines": ["+import fs from 'node:fs'", "+"] }],
      "text": "..."                    // full 模式必填；turn 模式可省略
    }
  ],
  "reviewer": { "findings": [/* 原样投喂 validateStructured */], "coverage": { "files": [] } },
  "config": { "evidenceMode": "warn", "coverageMode": "warn", "verify": "blocking" },
  "verifier": ["confirmed"],          // 按序伪造复验结论；timeout 模拟未证实
  "suppressions": [],                 // 走真实 validateSuppressions/applySuppressions
  "expected": {
    "ok": true,
    "kept": [{ "ruleId": "BEH-009", "severity": "medium", "verified": "confirmed",
               "evidenceStatus": "ok", "fixMode": "auto" }],
    "dropped": ["COR-002"],           // 期望不出现的 ruleId
    "suppressed": [{ "ruleId": "MNT-001" }],
    "verification": { "checked": 1, "confirmed": 1, "rejected": 0, "unverified": 0 },
    "coverage": { "valid": true, "reviewed": 1 },
    "renderContains": ["结论: 需修改"],
    "renderExcludes": ["请按上面每条阻塞 finding 修复"],
    "renderEmpty": false,
    "promptContains": ["BEH-009", "src/merge-settings.js"]
  }
}
```

`kept` 按顺序做**部分字段**比对；`expected.ok=false` 时只比对 `reason`（例如全部 finding
被证据校验丢弃 → `invalid-result`，不得当成通过）。

## 现有覆盖面

| case | 锁定什么 |
| --- | --- |
| `behavior-dimension-preserved` | behavior 维度不被 schema 白名单漏掉（0.4.0 回归） |
| `fabricated-evidence-downgraded` | 证据伪造在 warn 下降级仅报告，且不付费复验 |
| `fabricated-evidence-enforce-dropped` | enforce 下丢弃；全丢 = invalid-result |
| `outside-hunk-dropped` | 旧行号/旧代码冒充新问题总是丢弃 |
| `verifier-refuted-dropped` | 复验明确反驳 → 丢弃，但 rejected 计数留给 journal 审计 |
| `verifier-timeout-unverified` | 复验失败 → 未复验，保留仅报告，不静默 |
| `suppression-wontfix` | wontfix 抑制不阻塞、不修，但报告可见原因 |
| `coverage-invalid-warn` | 非法 coverage 不给假「已覆盖」，报告显式说无效 |
| `full-mode-evidence` | full 模式按文件全文校验证据 |
| `max-findings-truncated` | 超出上限按严重度截断，不整体吞掉 |

## 从真实运行补充 case

1. 在真实审查里发现误报/漏报；
2. 把当次 reviewer 原始输出（structured JSON）与对应 diff/hunk 脱敏后存成新 case；
3. 在 `expected` 里写明「应该报 / 应该拒」及理由；
4. 先让它失败（复现），再改 prompt/规则/校验层让它通过。

## 模型质量评测（本文档不覆盖）

管道 eval 不评价模型本身。模型质量按「预注册分母」人工评测，规则如下（借鉴
`@feng0531` 的 evaluation 合同）：

- **预注册**：先在文档里登记 run 集合（仓库+commit+审查范围）与指标，再跑；
- **分母保留**：precision/recall 的分母是登记过的全部 finding，不允许事后剔除；
- **null ≠ 0**：没有金标的项记 `null`（未评估），不得当成 0 计入平均；
- **可比性**：改 prompt / 规则 / 模型 / 证据模式后，必须重跑同一组 run 才能比较结论；
- **工件不公开**：评分记录只保留在仓库文档，不引入私有仓库内容或模型日志。
