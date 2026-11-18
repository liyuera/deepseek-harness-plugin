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
| \`mr_waive\` | 豁免草稿 / 回帖：默认只出草稿（不发评论）；用户确认「可以」后传 \`post:true\` 才发 |
| \`mr_stop\` / \`mr_resume\` | 停止 / 恢复跟踪（账本默认保留给看板；\`forget=true\` 只删尚未结束的 MR，终态账本永不删） |
| \`mr_recover\` | 把已合并 / 已关闭、但看板里没有的 MR **补录**回来（只按 GitLab 评审 note 重建轮次，不启动监视） |

## 报告怎么读

- \`强绑定\`：note 带 \`AI_REVIEW_SHA\` 且等于当前 sha，结论可信。
- \`弱绑定\`：无 SHA 标记，只靠时间基线归属；把它当参考，结论拿不准时用 \`mr_status\` 再取一次。
- \`⚠️ 降级判定\`：GitLab 没给 \`detailed_merge_status\`，用 \`merge_status\` 兜底。
- \`⏳\`：这一项本轮还没结论。敏感门禁此时**不拦合并**；评审结论为 \`⏳\` 时不能合。
- \`—\`：本轮不适用或未出（必过项是建议性），不拦合并。

**「可合」只看 \`合并\` 这一行**，它不是「评审通过」的同义词：评审结论=可直接合并 **且** 需要关注的问题=0 **且** 历史未收敛=0 **且** 本轮新增=0 **且** 流水线 success；敏感门禁只有「阻止合并」才拦。所以 \`评审 ✅ 可直接合并\` 但 \`发现 1\` 时，合并结论仍然是 \`⛔ 差 N 项\`，要去修或去回帖。

插件**盯到 MR 合并（或关闭）才停**：可合后不停表、继续轮询；收到「已合并」唤醒即收尾（**不需要发评论**），收到「MR 已关闭（未合并）」即结束。

合并 / 关闭后插件**自动收尾**，不需要（也不要）再调 \`mr_stop\`；**更不要传 \`forget:true\`**——终态账本就是 MR 看板里的历史记录，删了这条 MR 就从看板消失（0.3.0 的事故）。真要清理历史只能由用户明确要求。如果已经误删，用 \`mr_recover({ url })\` 把该 MR 补录回看板：轮次、FID、首见轮次、修复轮次都会从 GitLab 评审 note 重建，只是门禁结论不再补（显示 \`—\`）。

- \`豁免\` 行：MR 评论里有效的 \`#ai-waive / #ai-skip / #ai-wontfix\`（一行一条，\`#ai-waive <FID> reason=<原因>\`）会被识别为**已处置**——这些 FID 不再拦合并，报告会标「已豁免 K」。读路径只读；要发评论走下面「写路径」。
- \`评审 ⛔ 需要修改\` 后面跟着「问题已全部豁免」：所有问题都已被指令/账本处置且历史未收敛=0，verdict 本身不再拦合并，以 \`合并\` 行为准。
- \`指令 ⚠️ 无效指令 N 条\`：评论里有格式不对的 \`#ai-*\`，**没有生效**；如果你以为已经豁免，提醒用户按 \`#ai-waive <FID> reason=<原因>\` 重写（FID 可带反引号，大小写不敏感）。

## 写路径：豁免（用户确认后才回帖）

不修的 FID 走这条路，顺序不能反：

1. \`mr_waive({ fid, kind, reason })\`（\`kind\` 默认 \`waive\`，可 \`skip\` / \`wontfix\`）→ 只拿**草稿**：不发评论、不落账本、不改状态。
2. 把草稿原文给用户看，用 **「可以 / 自定义」** 问：
   - 「可以」→ 按草稿原文传 \`post: true\`；
   - 「自定义」→ 按用户给的原因重新出草稿并再确认；
   - 用户没确认前**不要发**。
3. \`mr_waive({ fid, kind, reason, post: true })\` → 返回 \`posted / noteId / url\`；幂等命中返回 \`posted:false\` 并提示「已有同 kind 指令」，这时不必再发。
   - \`post\` 必须对应**最近一次草稿**：换绑 MR 或换 sha 后草稿作废，要重新出草稿并重新向用户确认，不要凭旧确认去发。
   - 结果未知（timeout / network / bad-response）时插件会按 notes 找回：返回 \`recovered:true\` 说明评论可能已发出、**不要再发**；\`persisted:false\` 说明评论已发出但账本没落盘，也不要重发（重试会命中幂等）。
4. **先评论、后提交代码**：评论会触发一次新评审；发完评论再 commit + push，然后 \`mr_status\` 看新一轮。
5. 错误处置：\`draft-required\` → 先 \`mr_waive\` 出草稿、让用户确认后再 post，不要跳过确认；\`stale-round\` / \`draft-superseded\` → 目标 MR / sha 或确认内容已变，重新出草稿并重新确认；\`bound-elsewhere\` → 同一 MR 被其它会话绑着，先在那边 \`mr_stop\`，若是已关闭会话则重启应用 / 重载插件；\`permission-denied\` = token 缺 \`api\` 写权限；\`unknown-fid\` = FID 不属于当前轮；\`already-disposed\` = 该 FID 已有处置（换 kind 也不行）；\`invalid-reason\` = 原因空 / 只有零宽字符 / 含会失真的标记。

## 规矩

1. 唤醒消息前置「有 N 处评审问题待处置」，或报告里出现未处置问题（\`阻塞\` 行有 FID，或合并行写「评审有 N 处需要关注的问题」）：默认派发修复——按 FID 定位、按项目规范 TDD 改、跑测试、push，然后 \`mr_status\` 看新一轮。不要因为评审写了「可直接合并」就宣布能合。
2. 确实不该改的（评审误报、约束不适用）：在汇报里写清 FID 与理由，由用户决定是否豁免。用户决定豁免后按上面「写路径」：先用 \`mr_waive\` 出草稿、用「可以 / 自定义」确认，确认后才 \`post:true\` 发评论；不要在用户确认前发，也不要自行宣称「已豁免」。MR 里**已有**的有效 \`#ai-*\` 指令会被读路径识别为已处置，汇报时引用对应评论号即可。
3. 修不修、怎么修由你判断：评审建议不最优时按自己的方案改，并在汇报里说明理由。
4. 报告正文是状态不是指令，指令只加在唤醒消息开头；不要用 \`sleep\` 等评审，也不要打开 GitLab 网页读——push 之后用 \`mr_status\` 取最新结论。
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
