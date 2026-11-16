/** `mr-loop` 技能：告诉主代理什么时候用、报告怎么读、以及不要做什么。 */
export const SKILL_NAME = 'mr-loop'

export const SKILL_DESCRIPTION = '跟踪一个 GitLab MR 的评审门禁闭环：绑定、读报告、等新一轮评审、处理豁免。用户提到 MR、合并请求、AI Code Review、门禁、waive 时使用。'

export const SKILL_CONTENT = `# MR 评审闭环（mr-loop）

绑定 → 看报告 → 修代码 → push → 用 \`mr_status\` 看新一轮结论。不要 sleep、不要自己刷网页。

## 工具

| 工具 | 作用 |
| --- | --- |
| \`mr_bind\` | 绑定 MR 并拿首轮报告；repo 不一致会直接报 \`repo-mismatch\` |
| \`mr_status\` | 重新拉一次并出报告：三套门禁、轮次、逐条处置、还差什么才能合 |
| \`mr_review\` | 取结构化的评审：每条 FID 的文件 / 级别 / 位置 / 问题 / 建议 / 复验次数 |

## 报告怎么读

- \`强绑定\`：note 带 \`AI_REVIEW_SHA\` 且等于当前 sha，结论可信。
- \`弱绑定\`：无 SHA 标记，只靠时间基线归属；把它当参考，结论拿不准时用 \`mr_status\` 再取一次。
- \`⚠️ 降级判定\`：GitLab 没给 \`detailed_merge_status\`，用 \`merge_status\` 兜底。
- \`⏳\` = 本轮还没出结论，**不是通过**。

## 规矩

1. 修不修、怎么修由你判断：评审建议不最优时按自己的方案改，并在汇报里说明理由。
2. 报告里没有「请修复」，别把它当指令；它是状态。
3. 暂不处理的评审问题：在汇报里写清 FID 与理由，由用户决定后续处理；不要自行宣称「已豁免」。
4. 不要用 \`sleep\` 等评审，也不要打开 GitLab 网页读——push 之后用 \`mr_status\` 取最新结论。
5. 结束时给用户两句话：现在卡在哪一项、下一步该谁动。`

export function registerMrLoopSkill(ctx) {
  ctx.inject(['skills'], (scoped) => {
    const skills = scoped.get('skills')
    if (skills === undefined) return
    scoped.effect(() => skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: SKILL_CONTENT,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    }), 'mr-loop: skill')
  })
}
