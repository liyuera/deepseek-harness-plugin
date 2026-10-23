import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { resolveConfig } from '../lib/config.js'
import {
  extractProjects,
  isInside,
  normalizeProject,
  ProjectResolver,
  sessionCwd,
} from '../lib/project.js'

/** In-memory filesystem seam: only the directories and files a test declares. */
function makeFs({ dirs = [], files = [] } = {}) {
  const dirSet = new Set(dirs)
  const fileSet = new Set(files)
  return {
    exists: path => dirSet.has(path) || fileSet.has(path),
    isDirectory: path => dirSet.has(path),
    listDirs: path => dirs.filter(candidate => dirname(candidate) === path),
  }
}

/** CLI stub returning one IDE project list. */
function cliWith(projects) {
  return {
    calls: [],
    async call(toolName) {
      this.calls.push(toolName)
      return { result: { success: true, projects }, tool: toolName, payload: {}, warnings: [] }
    },
  }
}

/** Resolver whose project list is the given IDE rows. */
function resolverWith(projects, { dirs = [], files = [], config = {}, cwd } = {}) {
  const cli = cliWith(projects)
  const resolver = new ProjectResolver(cli, resolveConfig(config), { fs: makeFs({ dirs, files }), listTtlMs: 0 })
  const exec = cwd === undefined ? {} : { agent: { session: { header: { cwd } } } }
  return { resolver, cli, exec }
}

const UNIAPP_PROJECT = {
  projectPath: '/workspace/app/dist/build/mp-weixin',
  projectName: 'my-app',
  appId: 'wx123',
}

test('isInside treats a path as inside itself and its descendants', () => {
  assert.equal(isInside('/a/b', '/a'), true)
  assert.equal(isInside('/a/b/c', '/a'), true)
  assert.equal(isInside('/a', '/a/b'), false)
  assert.equal(isInside('/ab', '/a'), false)
  assert.equal(isInside('/a', '/a'), true)
})

test('sessionCwd reads the durable session header defensively', () => {
  assert.equal(sessionCwd({ agent: { session: { header: { cwd: '/workspace' } } } }), '/workspace')
  assert.equal(sessionCwd({}), undefined)
  assert.equal(sessionCwd(null), undefined)
  assert.equal(sessionCwd({ agent: { session: { header: { cwd: 'relative' } } } }), undefined)
})

test('extractProjects and normalizeProject accept the CLI project row layout', () => {
  const rows = extractProjects({ success: true, count: 1, projects: [UNIAPP_PROJECT] })
  assert.equal(rows.length, 1)
  assert.deepEqual(normalizeProject(rows[0]), UNIAPP_PROJECT)
  assert.deepEqual(normalizeProject({ projectPath: '/a', projectName: '', appId: undefined }), { projectPath: '/a', projectName: 'a', appId: '' })
  assert.equal(normalizeProject({}), undefined)
  assert.equal(normalizeProject(null), undefined)
})

test('explicit IDE project path resolves exactly', async () => {
  const { resolver, exec } = resolverWith([UNIAPP_PROJECT], { dirs: ['/workspace/app/dist/build/mp-weixin'], cwd: '/workspace' })
  assert.deepEqual(await resolver.resolve(UNIAPP_PROJECT.projectPath, exec), { projectPath: UNIAPP_PROJECT.projectPath, source: 'ide' })
})

test('a uni-app source root resolves to the IDE compiled-output path', async () => {
  const { resolver, exec } = resolverWith([UNIAPP_PROJECT], { dirs: ['/workspace/app'], cwd: '/workspace' })
  assert.deepEqual(await resolver.resolve('/workspace/app', exec), { projectPath: UNIAPP_PROJECT.projectPath, source: 'ide-descendant' })
})

test('a relative project path resolves against the session cwd', async () => {
  const { resolver, exec } = resolverWith([UNIAPP_PROJECT], { dirs: ['/workspace/app'], cwd: '/workspace' })
  assert.deepEqual(await resolver.resolve('app', exec), { projectPath: UNIAPP_PROJECT.projectPath, source: 'ide-descendant' })
})

test('without an explicit project the session workspace picks the IDE entry', async () => {
  const { resolver, exec } = resolverWith([UNIAPP_PROJECT], { dirs: ['/workspace/app'], cwd: '/workspace' })
  assert.deepEqual(await resolver.resolve(undefined, exec), { projectPath: UNIAPP_PROJECT.projectPath, source: 'workspace' })
})

test('an unregistered workspace project with project.config.json resolves to itself', async () => {
  const { resolver, exec } = resolverWith([], {
    dirs: ['/workspace/mini'],
    files: ['/workspace/mini/project.config.json'],
    cwd: '/workspace',
  })
  assert.deepEqual(await resolver.resolve(undefined, exec), { projectPath: '/workspace/mini', source: 'project-config' })
})

test('an unregistered source root discovers its uni-app build output', async () => {
  const { resolver, exec } = resolverWith([], {
    dirs: ['/workspace/app'],
    files: ['/workspace/app/dist/build/mp-weixin/project.config.json'],
    cwd: '/workspace',
  })
  assert.deepEqual(await resolver.resolve('/workspace/app', exec), { projectPath: '/workspace/app/dist/build/mp-weixin', source: 'build-output' })
})

test('two IDE projects under the workspace are ambiguous and list both candidates', async () => {
  const projects = [
    { projectPath: '/workspace/a/dist/dev/mp-weixin', projectName: 'a', appId: 'wx1' },
    { projectPath: '/workspace/b/dist/dev/mp-weixin', projectName: 'b', appId: 'wx2' },
  ]
  const { resolver, exec } = resolverWith(projects, { dirs: ['/workspace/a', '/workspace/b'], cwd: '/workspace' })
  await assert.rejects(resolver.resolve(undefined, exec), error => {
    assert.equal(error.kind, 'project')
    assert.match(error.message, /\/workspace\/a\/dist\/dev\/mp-weixin/u)
    assert.match(error.message, /\/workspace\/b\/dist\/dev\/mp-weixin/u)
    assert.match(error.message, /projectPath/u)
    return true
  })
})

test('a missing explicit project reports the IDE candidates', async () => {
  const { resolver, exec } = resolverWith([UNIAPP_PROJECT], { dirs: ['/workspace/app'], cwd: '/workspace' })
  await assert.rejects(resolver.resolve('/nowhere', exec), error => {
    assert.equal(error.kind, 'project')
    assert.match(error.message, /不存在/u)
    assert.match(error.message, /uni-app/u)
    return true
  })
})

test('the configured default project is used when the call omits one', async () => {
  const { resolver, exec } = resolverWith([UNIAPP_PROJECT], {
    dirs: ['/workspace/app'],
    cwd: '/workspace',
    config: { project: '/workspace/app' },
  })
  assert.deepEqual(await resolver.resolve(undefined, exec), { projectPath: UNIAPP_PROJECT.projectPath, source: 'ide-descendant' })
})

test('a failing project listing does not mask an explicit path that resolves on disk', async () => {
  const cli = {
    async call() {
      throw new Error('CONNECT_ERROR')
    },
  }
  const resolver = new ProjectResolver(cli, resolveConfig({}), {
    fs: makeFs({ dirs: ['/workspace/app'], files: ['/workspace/app/project.config.json'] }),
    listTtlMs: 0,
  })
  assert.deepEqual(await resolver.resolve('/workspace/app', {}), { projectPath: '/workspace/app', source: 'project-config' })
})
