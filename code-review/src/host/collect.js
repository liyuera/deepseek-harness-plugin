/**
 * 取材：把 `ctx.workspaceChanges` 的本轮摘要转成「可注入审查者的 diff 清单」。
 * @module @liyuera/dsh-code-review/host/collect
 */

/**
 * 判断路径是否属于待审代码。
 * @param {string} path
 * @param {readonly string[]} extensions 形如 `.js`
 * @returns {boolean}
 */
export function isCodeFile(path, extensions) {
  const lowered = String(path ?? '').toLowerCase()
  return extensions.some((extension) => lowered.endsWith(extension))
}

/**
 * 把一个文件的 hunks 渲染成 unified diff 文本。
 * @param {readonly object[]} hunks
 * @returns {string}
 */
export function renderHunks(hunks) {
  return hunks
    .map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`)
    .join('\n')
}

/**
 * 收集本轮可审的 diff。
 * @param {object} input
 * @param {{summary:Function,diff:Function}} input.workspaceChanges 服务（可为假实现）
 * @param {string} input.sessionId
 * @param {number} input.seq `workspace/changes` 事件序号
 * @param {object} input.config 已解析配置
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{files: Array<object>, skipped: Array<{path:string,reason:string}>, bytes: number}>}
 */
export async function collect({ workspaceChanges, sessionId, seq, config, signal }) {
  const summary = workspaceChanges?.summary(sessionId, seq)
  if (summary === undefined) return { files: [], skipped: [], bytes: 0 }

  const files = []
  const skipped = []
  let bytes = 0
  let exhausted = false

  for (let index = 0; index < summary.files.length; index += 1) {
    const file = summary.files[index]
    if (!isCodeFile(file.path, config.codeExtensions)) {
      skipped.push({ path: file.path, reason: 'not-code' })
      continue
    }
    if (exhausted) {
      skipped.push({ path: file.path, reason: 'budget' })
      continue
    }
    const diff = await workspaceChanges.diff(sessionId, seq, index, signal)
    if (diff === undefined) {
      skipped.push({ path: file.path, reason: 'unavailable' })
      continue
    }
    if (diff.kind !== 'text') {
      skipped.push({ path: file.path, reason: diff.kind })
      continue
    }
    const text = renderHunks(diff.hunks)
    if (bytes + text.length > config.maxDiffBytes) {
      exhausted = true
      skipped.push({ path: file.path, reason: 'budget' })
      continue
    }
    bytes += text.length
    files.push({
      path: file.path,
      display: file.display ?? file.path,
      hunks: diff.hunks,
      text,
      added: diff.added,
      deleted: diff.deleted,
    })
  }

  return { files, skipped, bytes }
}
