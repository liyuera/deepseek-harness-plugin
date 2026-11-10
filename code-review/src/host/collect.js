/**
 * 取材：把 `ctx.workspaceChanges` 的本轮摘要转成「可注入审查者的 diff 清单」。
 * @module @liyuera/dsh-code-review/host/collect
 */

import { createHash } from 'node:crypto'

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
 * 计算一次取材结果的内容指纹（路径 + 渲染文本），用于同一 turn 内去重。
 * @param {readonly {path: string, text: string}[]} files
 * @returns {string} sha256 十六进制摘要；空数组返回空串摘要
 */
export function fingerprint(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.text)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * 收集本轮可审的 diff。
 *
 * `files[].added/deleted` 取自 `summary.files[].added/deleted`（`WorkspaceChangedFile`），
 * 因为运行时 `WorkspaceFileDiff` 只有 hunks、没有行数字段；缺失时回退 0。
 *
 * `skipped[].reason` 为 `'not-code' | 'budget' | 'unavailable' | 'coarse'` 之一，或服务
 * `diff.kind` 原值（如 `'binary' | 'oversized' | 'refusal'`）。`coarse` 表示 diff 服务超时后
 * 返回的整文件替换形态，不能当普通 diff 送审（否则旧行会被误认为新增）。
 * `bytes` 为已收录 `files[].text` 的 UTF-8 字节数。
 *
 * @param {object} input
 * @param {{summary:Function,diff:Function}} input.workspaceChanges 服务（可为假实现）
 * @param {string} input.sessionId
 * @param {number} input.seq `workspace/changes` 事件序号
 * @param {object} input.config 已解析配置
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{files: Array<object>, skipped: Array<{path: string, reason: string}>, bytes: number}>}
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
    if (diff.coarse === true) {
      skipped.push({ path: file.path, reason: 'coarse' })
      continue
    }
    const text = renderHunks(diff.hunks)
    const size = Buffer.byteLength(text, 'utf8')
    if (bytes + size > config.maxDiffBytes) {
      exhausted = true
      skipped.push({ path: file.path, reason: 'budget' })
      continue
    }
    bytes += size
    files.push({
      path: file.path,
      display: file.display ?? file.path,
      hunks: diff.hunks,
      text,
      added: file.added ?? 0,
      deleted: file.deleted ?? 0,
    })
  }

  return { files, skipped, bytes }
}
