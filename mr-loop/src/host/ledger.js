/**
 * 账本：一个 MR 一个 JSON 文件，0600，原子写（tmp + rename），同文件写串行。
 * 不用 storageDomain 的原因见设计 ADR-5：免 peer 依赖、可人肉查看。
 * 读坏文件按「没有账本」处理，绝不抛给调用方。
 */
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

const MAX_DECISIONS = 200

export function expandHome(input) {
  if (typeof input !== 'string' || input === '') return input
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return resolvePath(homedir(), input.slice(2))
  return input
}

const slug = (projectPath) => String(projectPath ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'

/**
 * @param {{ dir: string, keepRounds?: number, keepDecisions?: number }} options
 */
export function createLedger({ dir, keepRounds = 50, keepDecisions = MAX_DECISIONS }) {
  const root = expandHome(dir)
  const queues = new Map()

  const pathOf = ({ projectPath, iid }) => join(root, `${slug(projectPath)}-${iid}.json`)

  /** 同一文件的写/删共用一条队列：调用顺序即落盘顺序。前一次失败也继续下一次。 */
  const enqueue = (file, task) => {
    const previous = queues.get(file) ?? Promise.resolve()
    const next = previous.then(task, task)
    queues.set(file, next.catch(() => {}))
    return next
  }

  const trim = (record) => {
    const rounds = Array.isArray(record.rounds) ? record.rounds : []
    const decisions = record.decisions !== null && typeof record.decisions === 'object' ? record.decisions : {}
    const entries = Object.entries(decisions).sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')))
    const keptEntries = entries.slice(0, keepDecisions)
    // slice(-0) 等于整段，会把「不留历史」变成「全留」；0 必须显式清空。
    const keptRounds = keepRounds > 0 ? rounds.slice(-keepRounds) : []
    const dropped = Math.max(0, rounds.length - keptRounds.length) + Math.max(0, entries.length - keptEntries.length)
    return {
      ...record,
      rounds: keptRounds,
      decisions: Object.fromEntries(keptEntries),
      ...(dropped > 0 ? { trimmed: dropped } : {}),
    }
  }

  const save = (record) => {
    const projectPath = record?.binding?.projectPath
    const iid = record?.binding?.iid
    const file = pathOf({ projectPath, iid })
    const payload = trim({ ...record, version: 1, updatedAt: record.updatedAt ?? new Date().toISOString() })
    const task = async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const tmpFile = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
      try {
        await writeFile(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        await rename(tmpFile, file)
      } catch (error) {
        // 失败时清掉半成品，目录里不留垃圾；原文件保持上一次的完整内容。
        await unlink(tmpFile).catch(() => {})
        throw error
      }
      return payload
    }
    return enqueue(file, task)
  }

  const load = async ({ projectPath, iid }) => {
    try {
      const text = await readFile(pathOf({ projectPath, iid }), 'utf8')
      const parsed = JSON.parse(text)
      // 数组也是 object：账本必须是对象，否则调用方会拿到 undefined.binding。
      return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false ? parsed : null
    } catch {
      return null
    }
  }

  const forget = ({ projectPath, iid }) => {
    const file = pathOf({ projectPath, iid })
    // 删除也入队：save 在途时 forget 不会被随后的 rename 写回。
    return enqueue(file, async () => {
      await rm(file, { force: true })
    })
  }

  return { pathOf, save, load, forget }
}
