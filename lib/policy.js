// 策略层：判定一次工具调用该放行、该问、还是该拦。
//
// 设计参考 damage-control-dev 的「策略阶梯」：
//   allow  直接放行
//   ask    需要用户确认（本插件无交互 UI，降级为 block + 提示原因）
//   block  拒绝执行
//
// 关键原则：只在「不可逆动作 × 受保护目标」同时成立时才拦。
// 单纯动作危险（比如 rm 一个临时文件）不拦；单纯目标敏感（读 workspace.json）也不拦。

import { parseCommand } from './parse.js'
import {
  classifyPath,
  isLoadedPluginDir,
  mentionsDshProcess,
  resolveProfileDir,
} from './paths.js'

/** 用户默认策略，可被插件 Config 覆盖。 */
export const DEFAULT_CONFIG = {
  /** 总开关 */
  enabled: true,
  /** 拦截杀 DSH 自身进程 */
  blockSelfKill: true,
  /** 拦截写入 DSH 运行资源 */
  blockProtectedWrites: true,
  /** 拦截改名/删除被链接加载的插件目录 */
  blockLoadedPluginDir: true,
  /** 需要用户额外声明的保护路径（前缀匹配） */
  extraProtectedPaths: [],
  /** 哨兵：允许明确放行的路径前缀（比如自己的备份目录） */
  allowPaths: [],
  /** 拦截时是否附带修复建议 */
  verbose: true,
}

const DENY_PREFIX = '【规则守卫】'

function deny(reason, hint) {
  const text = DENY_PREFIX + reason + (hint ? ' ' + hint : '')
  return { decision: 'block', reason: text }
}

/**
 * 从任意工具参数里挖出「可能被写入的路径」。
 * 不做语义白名单，而是把字符串参数里像路径的都收进来，交给 classifyPath 判。
 */
function collectPathArgs(args, depth = 0, out = []) {
  if (!args || typeof args !== 'object' || depth > 3) return out
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length < 4096) {
      if (/path|file|dir|to$|from$|target|destination|dest/i.test(k)) out.push(v)
    } else if (v && typeof v === 'object') {
      collectPathArgs(v, depth + 1, out)
    }
  }
  return out
}

/** 从任意工具参数里挖出「命令字符串」。 */
function collectCommandArgs(args, depth = 0, out = []) {
  if (!args || typeof args !== 'object' || depth > 3) return out
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      if (/^(command|cmd|script|shell|input|args|line)$/i.test(k)) out.push(v)
    } else if (v && typeof v === 'object') {
      collectCommandArgs(v, depth + 1, out)
    }
  }
  return out
}

/**
 * 判定杀进程类命令是否指向 DSH 自己。
 * 用解析后的语义判断，而不是字符串包含，减少误伤。
 */
function killsSelf(command, env) {
  for (const seg of parseCommand(command).segments) {
    if (!seg.action.includes('kill')) continue

    // ① 目标是 DSH 进程名（边界匹配，避免 dsh 误伤 --dsh-xxx 参数）
    if (mentionsDshProcess(seg.raw)) return true

    // ② 按 PID 杀，且 PID 就是自己或父进程
    const pidMatch = seg.raw.match(/\b(\d{2,7})\b/)
    if (pidMatch) {
      const pid = Number(pidMatch[1])
      if (pid === process.pid || pid === process.ppid) return true
    }
  }
  return false
}

/**
 * 主判定函数。
 * @param {object} input  { toolName, args }
 * @param {object} config 合并后的配置
 * @param {object} env     环境变量
 * @returns {{ decision: 'allow'|'block', reason?: string, matched?: string }}
 */
export function decide(input, config = DEFAULT_CONFIG, env = process.env) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) }
  if (!cfg.enabled) return { decision: 'allow' }

  const toolName = String(input && input.toolName ? input.toolName : '')
  const args = input && input.args

  // 用户白名单：命中就直接放行，不参与后续判定
  const allowList = Array.isArray(cfg.allowPaths) ? cfg.allowPaths.filter(Boolean) : []
  const allPathArgs = collectPathArgs(args)
  const isAllowed = (p) => {
    const n = String(p).replace(/\\/g, '/').toLowerCase()
    return allowList.some((a) => n.startsWith(String(a).replace(/\\/g, '/').toLowerCase()))
  }

  // ① 杀 DSH 自身
  if (cfg.blockSelfKill) {
    const commands = collectCommandArgs(args)
    // 也把路径参数当命令文本兜一层（有些工具把整条命令塞进 path/input）
    for (const cmd of commands) {
      if (killsSelf(cmd, env)) {
        return deny(
          '这条命令会终止 DSH 进程本身，已拒绝执行。',
          cfg.verbose ? 'DSH 是运行 AI 助手的环境，杀掉它当前对话会中断。需要重启请让用户手动完全退出再打开。' : '',
        )
      }
    }
  }

  // ② 写 DSH 运行资源
  if (cfg.blockProtectedWrites) {
    const paths = allPathArgs.filter((p) => !isAllowed(p))

    // 工具本身是不是写操作？
    // 为什么必须判断：read / grep / stat 这类只读工具碰 workspace.json 是正常的
    // （比如检查它有没有坏），拦了会误伤。只有写/改/移/删才该拦。
    const toolIsReadOnly = /^(read|read_|get|list|search|grep|glob|stat|inspect|outline|digest|file_card)/i
      .test(toolName) && !/write|edit|replace|copy|move|remove|delete/i.test(toolName)

    // 结构化路径参数
    if (!toolIsReadOnly) {
      for (const p of paths) {
        const verdict = classifyPath(p, env)
        if (verdict.protected) {
          return deny(
            '目标 ' + p + ' 是 ' + verdict.why + '，禁止直接写入。',
            cfg.verbose ? '这类文件只能由 DSH 自己通过接口写。测试请用临时目录副本。' : '',
          )
        }
      }
    }

    // shell 命令里的写入目标
    for (const cmd of collectCommandArgs(args)) {
      for (const seg of parseCommand(cmd).segments) {
        // 只有写/删/移类动作才检查目标
        const mutating = seg.action.some((a) => a === 'write' || a === 'delete' || a === 'move')
        if (!mutating) continue
        for (const t of seg.targets) {
          if (isAllowed(t)) continue
          const verdict = classifyPath(t, env)
          if (verdict.protected) {
            return deny(
              '命令要写入 ' + t + '，它是 ' + verdict.why + '，已拒绝。',
              cfg.verbose ? 'DSH 运行数据禁止手工修改。' : '',
            )
          }
        }
      }
    }
  }

  // ③ 改名/删除被链接加载的插件目录
  if (cfg.blockLoadedPluginDir) {
    const mutatingTool = /move|rename|remove|delete|bash|shell|pwsh|exec/i.test(toolName)
    if (mutatingTool) {
      for (const p of allPathArgs) {
        if (isLoadedPluginDir(p, env) && !isAllowed(p)) {
          const profileDir = resolveProfileDir(env) || 'profile'
          const inProfile = String(p).replace(/\\/g, '/').toLowerCase()
            .includes(String(profileDir).replace(/\\/g, '/').toLowerCase())
          if (inProfile) {
            return deny(
              '不能直接改名或删除被 profile 链接加载的插件目录（' + p + '）。',
              cfg.verbose ? '改名会让符号链接变断链，DSH 重启后加载失败。换版本请复制新目录再改链接。' : '',
            )
          }
        }
      }
    }
  }

  // ④ 用户自定义保护路径
  const extra = Array.isArray(cfg.extraProtectedPaths) ? cfg.extraProtectedPaths.filter(Boolean) : []
  if (extra.length) {
    for (const p of allPathArgs) {
      if (isAllowed(p)) continue
      const n = String(p).replace(/\\/g, '/').toLowerCase()
      for (const e of extra) {
        const en = String(e).replace(/\\/g, '/').toLowerCase()
        if (n === en || n.startsWith(en + '/')) {
          return deny('目标 ' + p + ' 在用户声明的保护路径内，已拒绝。', '')
        }
      }
    }
  }

  return { decision: 'allow' }
}
