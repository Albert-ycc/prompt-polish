export type PolishType = '开放探讨' | '明确执行' | '调研分析' | '快速问答'

export type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; seconds: number }
  | { kind: 'done'; type: PolishType | null; source: string; original: string }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-polish': { phase: Phase }
  }
}
