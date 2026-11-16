/** 只接受「与配置同源、同 base 路径前缀」的 MR 地址；其余一律 null，由调用方报 invalid-url。 */
export function parseMrUrl(input, baseUrl) {
  let url
  let base
  try {
    url = new URL(String(input ?? '').trim())
    base = new URL(baseUrl)
  } catch {
    return null
  }
  if (url.origin !== base.origin) return null
  const basePath = base.pathname.replace(/\/+$/, '')
  let pathname = url.pathname
  if (basePath) {
    if (!pathname.startsWith(`${basePath}/`)) return null
    pathname = pathname.slice(basePath.length)
  }
  const match = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(pathname)
  if (!match) return null
  const project = match[1].replace(/^\/+/, '')
  if (!project.includes('/') || project.includes('/-/')) return null
  const iid = Number(match[2])
  return Number.isSafeInteger(iid) && iid > 0 ? { project, iid } : null
}
