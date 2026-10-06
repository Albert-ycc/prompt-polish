import { expect, mock, test } from 'claude-code/testing'

const REPLY = '<类型>明确执行</类型>\n<提示词>\n帮我排查日志为空的原因\n</提示词>'

type On = Parameters<Parameters<typeof test>[1]>[1]

// 模拟「谁在用、在哪个项目里」：家目录、配置目录、会话项目根、逐层 CLAUDE.md
function machine(on: On, opts: { home?: string; root?: string; config?: string; ancestors?: { dir: string; content: string }[] } = {}) {
  const env: Record<string, string | undefined> = { HOME: opts.home ?? '/home/u', CLAUDE_CONFIG_DIR: opts.config }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.root', () => ({ value: opts.root ?? '/work/proj' }))
  on('fs.ancestors', () => ({
    value: (opts.ancestors ?? []).map(a => ({ dir: a.dir, name: 'CLAUDE.md', content: a.content, parts: [] })),
  }))
}

test('桌面端回车时末尾带 ;;：拦下不发，优化后填回输入框', async ($, on) => {
  const clock = mock.clock(on)
  machine(on)
  const filled: string[] = []
  let sent = false
  on('prompt.submit', (_$, e) => {
    sent = true
    return { text: e.text }
  })
  on('prompt.read', () => ({ text: '', cursor: 0 }))
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('fs.read', () => ({ value: '' }))
  on('model.fork', () => ({ value: { isAnswered: true, text: REPLY, usage: {} as never } }))

  const result = await $.prompt.submit({ text: '帮我看下日志为啥是空的;;', wait: false, origin: { kind: 'sdk' } })
  expect(result.drop).toContain(';;')
  expect(sent).toBe(false)

  await clock.advance(0)
  await clock.advance(1000)
  expect(filled.length).toBe(1)
  expect(filled[0]).toContain('帮我排查日志为空的原因')
  expect(filled[0]).toContain('直接执行到完成')
})

test('中文分号 ；； 回车同样拦下', async ($, on) => {
  mock.clock(on)
  machine(on)
  let sent = false
  on('prompt.submit', (_$, e) => {
    sent = true
    return { text: e.text }
  })
  on('prompt.read', () => ({ text: '', cursor: 0 }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('fs.read', () => ({ value: '' }))
  on('model.fork', () => ({ value: { isAnswered: true, text: REPLY, usage: {} as never } }))

  const result = await $.prompt.submit({ text: '帮我看下日志；；', wait: false, origin: { kind: 'composer' } })
  expect(result.drop).toBeDefined()
  expect(sent).toBe(false)
})

test('开放探讨类型：先要判断和推荐，请求里带上收紧后的改写原则', async ($, on) => {
  const clock = mock.clock(on)
  machine(on)
  const filled: string[] = []
  const asked: string[] = []
  on('prompt.read', () => ({ text: '', cursor: 0 }))
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('fs.read', () => ({ value: '' }))
  on('model.fork', (_$, e) => {
    asked.push(e.prompt)
    return { value: { isAnswered: true, text: '<类型>开放探讨</类型>\n<提示词>\n记录好还是做成 skill 好\n</提示词>', usage: {} as never } }
  })

  await $.prompt.submit({ text: '那套流程记录好还是做成skill好;;', wait: false, origin: { kind: 'composer' } })
  await clock.advance(0)
  await clock.advance(1000)

  expect(asked[0]).toContain('缺了会让执行方做出明显不同结果')
  expect(asked[0]).toContain('不要替我写默认答案')
  expect(asked[0]).toContain('以草稿原话为准')
  expect(asked[0]).toContain('管这次产出边界的')
  expect(asked[0]).toContain('项目名和系统名只能照抄')
  expect(asked[0]).toContain('不要借待澄清项引出草稿没提的新功能')
  expect(filled[0]).toContain('先给出你的判断和推荐做法')
  expect(filled[0]).not.toContain('先针对我的需求向我提问')
})

test('不带 ;; 的消息照常发出', async ($, on) => {
  let sent = false
  on('prompt.submit', (_$, e) => {
    sent = true
    return { text: e.text }
  })

  const result = await $.prompt.submit({ text: '帮我看下日志', wait: false, origin: { kind: 'sdk' } })
  expect(result.drop).toBe(undefined)
  expect(sent).toBe(true)
})

test('只有 ;; 没有正文时照常发出', async ($, on) => {
  let sent = false
  on('prompt.submit', (_$, e) => {
    sent = true
    return { text: e.text }
  })

  const result = await $.prompt.submit({ text: ';;', wait: false, origin: { kind: 'sdk' } })
  expect(sent).toBe(true)
  expect(result.drop).toBe(undefined)
})

// 跑一次「草稿末尾 ;; 回车」，返回读过的文件和发给模型的请求
async function polishOnce($: Parameters<Parameters<typeof test>[1]>[0], on: On, files: Record<string, string>, fork: 'ok' | 'empty' = 'ok') {
  const clock = mock.clock(on)
  const reads: string[] = []
  const asked: string[] = []
  const systems: string[] = []
  on('prompt.read', () => ({ text: '', cursor: 0 }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    if (e.path in files) return { value: files[e.path] }
    throw new Error('ENOENT')
  })
  on('model.fork', (_$, e) => {
    asked.push(e.prompt)
    return { value: fork === 'ok' ? { isAnswered: true, text: REPLY, usage: {} as never } : { isAnswered: false, reason: 'nothing-to-fork' } }
  })
  on('model.complete', (_$, e) => {
    asked.push(e.prompt)
    systems.push(e.system ?? '')
    return { value: { isAnswered: true, text: REPLY, usage: {} as never } }
  })
  await $.prompt.submit({ text: '帮我看下日志;;', wait: false, origin: { kind: 'composer' } })
  await clock.advance(0)
  await clock.advance(1000)
  return { reads, asked, systems }
}

test('记忆按当前用户推算：当前项目和家目录项目各读一份', async ($, on) => {
  machine(on, { home: '/home/u', root: '/work/my proj' })
  const { reads, asked } = await polishOnce($, on, {
    '/home/u/.claude/projects/-work-my-proj/memory/MEMORY.md': '项目记忆',
    '/home/u/.claude/projects/-home-u/memory/MEMORY.md': '家目录记忆',
  })
  expect(reads).toContain('/home/u/.claude/projects/-work-my-proj/memory/MEMORY.md')
  expect(reads).toContain('/home/u/.claude/projects/-home-u/memory/MEMORY.md')
  expect(asked[0]).toContain('项目记忆')
  expect(asked[0]).toContain('家目录记忆')
})

test('会话就开在家目录时只读一份', async ($, on) => {
  machine(on, { home: '/Users/alice', root: '/Users/alice' })
  const { reads } = await polishOnce($, on, { '/Users/alice/.claude/projects/-Users-alice/memory/MEMORY.md': '记忆' })
  expect(reads.filter(r => r.endsWith('MEMORY.md'))).toEqual(['/Users/alice/.claude/projects/-Users-alice/memory/MEMORY.md'])
})

test('设了 CLAUDE_CONFIG_DIR 就从那里读', async ($, on) => {
  machine(on, { home: '/home/u', root: '/work/proj', config: '/cfg' })
  const { reads } = await polishOnce($, on, {})
  expect(reads).toContain('/cfg/projects/-work-proj/memory/MEMORY.md')
  expect(reads.some(r => r.startsWith('/home/u/.claude/'))).toBe(false)
})

test('新会话第一句：按用户级和逐层 CLAUDE.md 补背景', async ($, on) => {
  machine(on, { home: '/home/u', root: '/work/proj', ancestors: [{ dir: '/work', content: '项目层规则' }] })
  const { systems } = await polishOnce($, on, { '/home/u/.claude/CLAUDE.md': '用户层规则' }, 'empty')
  expect(systems[0]).toContain('用户层规则')
  expect(systems[0]).toContain('项目层规则')
  expect(systems[0]).toContain('/work/CLAUDE.md')
})
