// 命令解析：把一条 shell 命令拆成「它会做什么动作」「动到哪些路径」。
//
// 为什么不能穷举命令名：damage-control 之类的成熟实现都发现，只匹配
// `rm -rf` / `taskkill` 这类字面量，别人换个写法就漏。正确做法是解析语义：
//   ① 递归剥掉包裹层（sh -c "..."、cmd /c "..."、sudo、ssh host "..."）
//   ② 按分隔符切成独立命令段
//   ③ 对每段识别「动作类型」和「目标路径」
//
// 这个模块只做解析，不做判定。判定在 policy.js。

/** 命令分隔符：换行、分号、&&、||、管道。 */
const SEPARATORS = /\n|;|&&|\|\||\|/

/**
 * 包裹命令：外层命令只是把内层再执行一遍。
 * 剥掉它们才能看到真正的动作，例如 `sh -c "rm -rf /"`。
 */
const WRAPPERS = [
  /^\s*sh\s+-c\s+/i,
  /^\s*bash\s+-c\s+/i,
  /^\s*zsh\s+-c\s+/i,
  /^\s*pwsh\s+(-command|-c)\s+/i,
  /^\s*powershell(\.exe)?\s+(-command|-c)\s+/i,
  /^\s*cmd(\.exe)?\s+\/c\s+/i,
  /^\s*sudo\s+/i,
  /^\s*doas\s+/i,
  /^\s*env\s+/i,
  /^\s*time\s+/i,
  /^\s*nohup\s+/i,
  /^\s*exec\s+/i,
  // ssh <host> "命令"
  /^\s*ssh\s+\S+\s+/i,
  // docker exec/run ... 命令
  /^\s*docker\s+(exec|run)\s+[^"']*?\s+(?=[a-z])/i,
]

/** 去掉包裹层，最多剥 4 层防止病态输入。 */
export function unwrap(raw, depth = 0) {
  let s = String(raw || '').trim()
  if (depth > 4 || !s) return s
  // 去掉最外层的引号
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  for (const re of WRAPPERS) {
    if (re.test(s)) {
      const next = s.replace(re, '')
      if (next !== s) return unwrap(next, depth + 1)
    }
  }
  return s
}

/**
 * 动作语义分类。
 *
 * 不按命令名穷举，而按「这条命令会不会造成不可逆改变」归类：
 *   delete  删除文件/目录
 *   move    移动或改名
 *   write   覆盖写入
 *   kill    终止进程
 *   none    其余（读取、查询、构建等）
 */
const ACTION_PATTERNS = [
  { action: 'delete', re: /\b(rm|rmdir|del|erase|unlink|shred|truncate)\b/i },
  { action: 'delete', re: /\bRemove-Item\b|\bRemove-ItemProperty\b/i },
  { action: 'delete', re: /\bgit\s+(clean\s+-[a-z]*f|reset\s+--hard)\b/i },
  { action: 'move', re: /\b(mv|move|rename|ren)\b/i },
  { action: 'move', re: /\bRename-Item\b|\bMove-Item\b/i },
  { action: 'kill', re: /\b(kill|killall|pkill|taskkill|killall5)\b/i },
  { action: 'kill', re: /\bStop-Process\b/i },
  { action: 'kill', re: /\b(wmic|Get-CimInstance)\b.*\b(terminate|delete)\b/i },
  { action: 'write', re: /\b(cp|copy|install|rsync|scp|tee|dd)\b/i },
  { action: 'write', re: /\bCopy-Item\b|\bSet-Content\b|\bOut-File\b|\bAdd-Content\b/i },
]

/** 判断一段命令的语义动作。返回动作列表（可能多个，取最危险）。 */
export function classifyAction(segment) {
  const s = String(segment || '')
  const found = []
  for (const { action, re } of ACTION_PATTERNS) {
    if (re.test(s)) found.push(action)
  }
  // 重定向也算写入
  if (/>>?/.test(s) && !/^[^>]*2>&1/.test(s)) found.push('write')
  if (found.length === 0) return ['none']
  // 危险度排序：delete > kill > move > write
  const rank = { delete: 4, kill: 3, move: 2, write: 1, none: 0 }
  found.sort((a, b) => rank[b] - rank[a])
  return [...new Set(found)]
}

/**
 * 从一段命令里抽出目标路径。
 *
 * 策略：先取重定向/tee/cp 这类明确的目标位置，再退化为「取参数里的路径样式 token」。
 * 宁可多抽几个，判定侧再做过滤，避免漏掉真正的目标。
 */
export function extractTargets(segment) {
  const s = String(segment || '')
  const targets = []

  const push = (p) => {
    if (!p) return
    const clean = p.replace(/^["']|["']$/g, '').trim()
    if (!clean) return
    // 排除纯数字（fd 编号）、&1 这类
    if (/^&?\d+$/.test(clean)) return
    if (/^\/dev\/(null|stdout|stderr|tty)$/.test(clean)) return
    targets.push(clean)
  }

  // 重定向
  for (const m of s.matchAll(/>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)) push(m[1])

  // dd of=
  const dd = s.match(/\bof=("[^"]+"|'[^']+'|\S+)/)
  if (dd) push(dd[1])

  // 命令 + 参数：取所有像路径的 token
  const words = s.split(/\s+/)
  for (const w of words) {
    if (!w || w.startsWith('-')) continue
    // 路径样式：含 / 或 \，或者是带扩展名的文件名
    if (/[\\/]/.test(w) || /\.(json|js|mjs|cjs|ts|md|txt|log|db|sqlite|yaml|yml|exe)$/i.test(w)) {
      push(w)
    }
  }

  return [...new Set(targets)]
}

/**
 * 完整解析一条命令。
 * @returns {{ segments: Array<{ raw: string, action: string[], targets: string[] }> }}
 */
export function parseCommand(command) {
  const text = String(command || '')
  if (!text.trim()) return { segments: [] }

  const segments = []
  for (const rawSeg of text.split(SEPARATORS)) {
    if (!rawSeg.trim()) continue
    // 对每一段先剥包裹，再解析；剥完可能又是一整条命令，递归拆一次
    const unwrapped = unwrap(rawSeg)
    if (unwrapped !== rawSeg.trim() && SEPARATORS.test(unwrapped)) {
      for (const inner of unwrapped.split(SEPARATORS)) {
        if (!inner.trim()) continue
        segments.push({
          raw: inner.trim(),
          action: classifyAction(inner),
          targets: extractTargets(inner),
        })
      }
      continue
    }
    segments.push({
      raw: unwrapped,
      action: classifyAction(unwrapped),
      targets: extractTargets(unwrapped),
    })
  }
  return { segments }
}
