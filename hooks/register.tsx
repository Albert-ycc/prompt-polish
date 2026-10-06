import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelApiError, ModelForkResult, Register, RenderSurface } from 'claude-code'

import type { Phase, PolishType } from '../types'

// Claude Code 按项目存自动记忆：<配置目录>/projects/<项目路径里非字母数字全换成 -> /memory/MEMORY.md
const projectKey = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-')

async function claudeDirs($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  return { home, config }
}

// 记忆索引：当前会话项目的一份，加家目录项目的一份（同一份只读一次），让模型知道你有哪些项目、资料在哪
async function readMemory($: EngineInterface) {
  const { home, config } = await claudeDirs($)
  const root = await $.session.root().catch(() => '')
  const dirs = [...new Set([root, home].filter(Boolean))]
  const texts = await Promise.all(
    dirs.map(d => $.fs.read(`${config}/projects/${projectKey(d)}/memory/MEMORY.md`).catch(() => '')),
  )
  return texts.filter(Boolean).join('\n\n')
}

// 新会话第一句没有上下文可借时，按 Claude Code 自己的读法补上：用户级 CLAUDE.md，加从项目根往上各层的 CLAUDE.md
async function readProfile($: EngineInterface) {
  const { config } = await claudeDirs($)
  const user = await $.fs.read(`${config}/CLAUDE.md`).then(t => `# ${config}/CLAUDE.md\n\n${t}`, () => '')
  const project = await $.fs.ancestors({ names: ['CLAUDE.md'] }).catch(() => [])
  return [user, ...project.map(f => `# ${f.dir}/CLAUDE.md\n\n${f.content}`)].filter(Boolean).join('\n\n')
}

// 在草稿末尾连敲两个分号触发优化（中文输入法打出的 ；； 也算）
const TRIGGER = /(;;|；；)$/

// 刚敲进字、光标在末尾、草稿以触发符结尾，才算触发；删字或在中间编辑不算
export const isTrigger = (box: { text: string; cursor: number }, inputText: string) =>
  inputText !== '' && box.cursor === box.text.length && TRIGGER.test(box.text)

export const stripTrigger = (text: string) => text.replace(TRIGGER, '')

// 按类型追加的固定结尾；想改措辞、加类型，改这里（同时改 types/index.d.ts 的 PolishType）
const ENDINGS: Record<PolishType, string> = {
  开放探讨:
    '这件事我还没完全想清楚。先别急着动手做：先给出你的判断和推荐做法，说清理由；再列出最可能改变这个判断的关键问题（最多 3 个，按影响大小排序，用业务场景来问，不出技术选型题）。我确认方向后再开始做。',
  明确执行:
    '目标已经明确，直接执行到完成，过程中不用找我确认；完成后给结论和验证证据（实际运行输出、截图或读过的正文）。',
  调研分析:
    '结论先行。事实性内容注明来源，区分「查证过的」和「推测的」，不确定的地方直接说不确定。',
  快速问答: '',
}

const TYPE_HINTS: Record<PolishType, string> = {
  开放探讨: '方向、方案、该不该做、怎么做还没想清楚，需要先讨论',
  明确执行: '目标和做法基本清楚的具体活（改代码、出文档、画图、整理文件等）',
  调研分析: '查资料、做对比、研究现状、分析原因',
  快速问答: '一两句话就能答的事实或概念问题',
}

const TYPES = Object.keys(ENDINGS) as PolishType[]

const phase = atom({ plugin: 'prompt-polish', key: 'phase' } as const, { kind: 'idle' } as Phase)

// 模型接口的英文错误类别 → 中文
const API_ERRORS: Record<ModelApiError, string> = {
  authentication_failed: '认证失败',
  oauth_org_not_allowed: '当前组织不允许这种登录方式',
  account_on_hold: '账号被暂停',
  verification_required: '账号需要验证',
  billing_error: '账单问题',
  rate_limit: '请求频率受限',
  overloaded: '服务过载',
  invalid_request: '请求无效',
  model_not_found: '模型不存在',
  server_error: '服务器内部错误',
  unknown: '未知错误',
  max_output_tokens: '回复超出长度上限',
  cloud_credential_error: '云端凭据错误',
}

const whyNoReply = (reply: Extract<ModelForkResult, { isAnswered: false }>) => {
  switch (reply.reason) {
    case 'api-error':
      return `接口报错，${API_ERRORS[reply.error] ?? reply.error}（HTTP ${reply.status ?? '无响应'}）`
    case 'empty-reply':
      return '模型回复为空'
    case 'aborted':
      return '超时或被中断'
    case 'nothing-to-fork':
      return '当前会话还没有上下文'
  }
}

const instruction = (draft: string, memory: string) => `你现在的任务不是执行，而是替我（用户）改写一段准备发给 Claude Code 的提示词。不要调用任何工具，不要回答或执行这段提示词本身，只输出改写结果。

改写原则：
1. 忠于原意：只把我已经表达的、或从上下文能确定的意思说完整、说专业；不添加我没提出的新需求、新功能。
2. 逐项检查这五项：要解决的真实问题与背景、目标、产出物形态、范围与约束、完成标准。每项先在心里判断「清楚 / 部分清楚 / 缺失」（不输出判断过程）。只补那些「缺了会让执行方做出明显不同结果」的项；其余能合理假设的，合并成一行「默认：……」，不展开。不要补原文没提到的具体约束、细节要求或验收指标。
3. 结合你对我的了解：涉及具体项目时，点明项目名和应先读的本地资料路径，放在说清我要解决什么之后。路径、文件名、项目名和系统名只能照抄你在上下文或下面的记忆索引里确实见过的原文，没见过就不写，不要拼接或推测归属。记忆和上下文里的规则分两类处理：管这次产出边界的（不加我没提的功能、不编造内容、以哪份原始材料为准、产物长什么样、截图怎么截、该用哪个 skill 或流程），落到这次任务上写成具体的一句；管操作手法的通用规则（写入方式、工具用法、操作禁忌之类）不要转述，执行方会自己加载。它们和草稿原话冲突时，以草稿原话为准。
4. 我没说清、上下文也推不出来的点：先判断执行方自己能不能查到（读本地文件、代码、文档、系统就能查到的，不列，改成在正文里让执行方先去查）。剩下的只保留「答案会改变产出结果」的，最多 3 条，按影响从大到小排，放在提示词末尾「我还没想清楚的：」下面。不要借待澄清项引出草稿没提的新功能、新状态或新范围。不要替我写默认答案；只有草稿原话或执行方能查到的原文里已经给出答案时，才在该条后注明「（草稿已说明：……）」。没有这样的点时，这一段整段不写。
5. 原文开头的派单前缀（如「后端：」「产品：」）、所有 @文件引用、链接、路径原样保留。
6. 用我的第一人称口吻，中文，技术术语保留英文；篇幅以说清楚为准，最长不超过 500 字。
7. 不要写结尾的工作方式要求（如「先问我」「直接执行」），那部分由程序按类型追加。

同时判断这段提示词属于哪一类，只能选一个：
${TYPES.map(t => `- ${t}：${TYPE_HINTS[t]}`).join('\n')}

严格按以下格式输出，前后不要任何其他文字：
<类型>${TYPES.join(' / ')} 四选一</类型>
<提示词>
改写后的提示词
</提示词>
${memory ? `\n我的记忆索引（每行一条记忆的摘要）：\n<<<\n${memory}\n>>>\n` : ''}
我的原始提示词：
<<<
${draft}
>>>`

const parse = (reply: string) => {
  const text = reply.match(/<提示词>\s*([\s\S]*?)\s*<\/提示词>/)?.[1]
  if (!text) return undefined
  const label = reply.match(/<类型>\s*([\s\S]*?)\s*<\/类型>/)?.[1] ?? ''
  const type = TYPES.find(t => label.includes(t)) ?? null
  return { type, text }
}

// 每次开始优化、取消或你发出消息都 +1，晚到的旧结果直接作废，不会覆盖你新写的草稿
let generation = 0

function fail($: EngineInterface, message: string) {
  return update($, phase, (): Phase => ({ kind: 'error', message }))
}

// surface 只用于写不进输入框时复制到剪贴板；打字触发时不知道界面，留空即用会话的默认界面
// given：回车拦截时输入框已被清空，草稿由调用方直接传入
async function polish($: EngineInterface, surface?: RenderSurface, given?: string) {
  const draft = given ?? (await $.prompt.read().then(box => box.text, () => undefined))
  if (draft === undefined) {
    await fail($, '读不到输入框里的草稿，原草稿未改动')
    return
  }
  if (!draft.trim()) {
    $.ui.toast('输入框是空的，先写下你想做的事')
    return
  }

  const mine = ++generation
  await update($, phase, (): Phase => ({ kind: 'working', seconds: 0 }))
  // 每秒刷新一次已用秒数，让你知道它还在跑
  const tick = $.clock.every(1000, () => {
    void update($, phase, (now): Phase => (now.kind === 'working' ? { ...now, seconds: now.seconds + 1 } : now))
  })

  try {
    const memory = await readMemory($)
    const ask = instruction(draft, memory)

    // 优先借当前会话的完整上下文（系统提示、CLAUDE.md、对话），新会话第一句时退回读本地文件
    // 「依据」只列实际读到内容的来源
    const sources = (...parts: (string | false)[]) => parts.filter(Boolean).join(' + ') || '仅草稿'
    let source = sources('当前会话上下文', memory !== '' && '记忆索引')
    let reply = await $.model.fork({ prompt: ask })
    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      const profile = await readProfile($)
      source = sources(profile !== '' && '全局指令', memory !== '' && '记忆索引')
      reply = await $.model.complete({
        model: 'opus',
        system: `下面是用户的个人工作指令，用来了解用户是谁、在做哪些项目、有哪些工作习惯：\n\n${profile}`,
        prompt: ask,
        maxTokens: 4000,
        timeoutMs: 120_000,
      })
    }

    if (mine !== generation) return

    if (!reply.isAnswered) {
      await fail($, `模型没给出结果：${whyNoReply(reply)}，原草稿未改动`)
      return
    }

    const parsed = parse(reply.text)
    if (!parsed) {
      await fail($, '模型返回的格式不对，没能解析，原草稿未改动')
      return
    }

    const ending = parsed.type ? ENDINGS[parsed.type] : ''
    const polished = ending ? `${parsed.text}\n\n${ending}` : parsed.text

    // 等待期间你可能又改了草稿：以覆盖前那一刻的内容作为「原文」，还原时不丢字
    const latest = await $.prompt.read().then(box => box.text || draft, () => draft)
    const filled = await $.prompt.fill({ text: polished, mode: 'replace' })
    if (!filled.isFilled) {
      await $.ui.copy({ text: polished, surface })
      await fail($, '输入框暂时写不进去（可能有弹窗挡着），优化结果已复制到剪贴板')
      return
    }

    await update($, phase, (): Phase => ({ kind: 'done', type: parsed.type, source, original: latest }))
  } catch (error) {
    if (mine === generation) {
      await fail($, `优化失败，原草稿未改动（英文原文：${error instanceof Error ? error.message : String(error)}）`)
    }
  } finally {
    tick.cancel()
  }
}

export const register: Register = on => {
  // 你发出任何消息，按钮条回到初始状态，进行中的优化作废
  on('prompt.submit', async ($, e, next) => {
    // 回车时草稿末尾带 ;;：拦下不发，优化后填回输入框。
    // 桌面端新会话发出第一条消息前不转发输入框编辑，第一条消息只能走这条路
    const typed = e.text.trimEnd()
    const byPerson = ['composer', 'sdk', 'bridge', 'unclassified'].includes(e.origin.kind)
    if (byPerson && TRIGGER.test(typed) && stripTrigger(typed).trim()) {
      $.clock.after(0, () => void polish($, undefined, stripTrigger(typed)))
      return { drop: '这条没有发出去：末尾带 ;;，正在优化提示词，结果会填回输入框' }
    }

    generation += 1
    await update($, phase, () => ({ kind: 'idle' }))

    return next(e)
  })

  // 打字触发：去掉触发符后立刻开始优化（放到定时器里跑，不卡输入框）
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (!isTrigger(box, e.inputText)) {
      return box
    }

    const text = stripTrigger(box.text)
    $.clock.after(0, () => void polish($))

    return { ...box, text, cursor: text.length }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const now = await read($, phase)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (now.kind === 'working') {
      return (
        <Box gap={1}>
          <Text>⏳ 正在优化提示词… 已用 {now.seconds} 秒</Text>
          <Button
            key="cancel"
            label="取消"
            onPress={() => {
              generation += 1
              void update($, phase, () => ({ kind: 'idle' }))
            }}
          />
        </Box>
      )
    }

    if (now.kind === 'done') {
      return (
        <Box gap={1}>
          <Text dimColor>
            已优化 · 类型：{now.type ?? '未识别（未加结尾）'} · 依据：{now.source}
          </Text>
          <Button
            key="restore"
            label="↩ 还原原文"
            onPress={async () => {
              await $.prompt.fill({ text: now.original, mode: 'replace' })
              await update($, phase, () => ({ kind: 'idle' }))
            }}
          />
          <Button key="again" label="✨ 再优化" onPress={press => void polish($, press.surface)} />
        </Box>
      )
    }

    return (
      <Box gap={1}>
        <Button
          key="polish"
          label="✨ 优化提示词"
          variant="primary"
          onPress={press => void polish($, press.surface)}
        />
        {now.kind === 'error' ? (
          <Text color="red">{now.message}</Text>
        ) : (
          <Text dimColor>在草稿末尾输入 ;; 快速优化 · 结果写回输入框，发送前可编辑或还原</Text>
        )}
      </Box>
    )
  })
}
