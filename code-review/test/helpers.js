/** 审查者测试共用夹具：假 subagents 与一条合法 finding。 */
export function fakeSubagents(result) {
  return {
    calls: [],
    async startActivation(spec) {
      this.calls.push(spec)
      return { childId: 'child-1', result: Promise.resolve(result), dispose: async () => {} }
    },
  }
}

export const validFinding = {
  ruleId: 'SEC-001', dimension: 'security', severity: 'high',
  location: 'src/a.ts:42', problem: 'p', suggestion: 's',
}
