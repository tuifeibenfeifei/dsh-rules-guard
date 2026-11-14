// 受保护路径：不写死任何用户路径，运行时从 DSH 的环境和目录结构推导。
//
// 为什么不能用 storage 服务：ctx.storage 只暴露抽象层（backend/form），
// 拿不到真实文件路径。所以改为「环境变量 + 已知目录形状」推导，
// 并保留 fallback 正则，保证换任何机器、改任何 DSH_HOME 都能工作。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 推导 DSH_HOME。
 * 顺序与 dsh-rules 插件一致：环境变量 → ~/.dsh。
 */
export function resolveDshHome(env = process.env) {
  const explicit = env.DSH_HOME
  if (explicit && String(explicit).trim()) {
    const p = String(explicit).trim()
    // 允许 ~ 前缀
    if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
    return p
  }
  return path.join(os.homedir(), '.dsh')
}

/**
 * 推导 profile 目录（node_modules 里放着已装插件的地方）。
 * 由 DSH_PROFILE_DIR 给出；没有就用 DSH_HOME/profiles/<profile>。
 */
export function resolveProfileDir(env = process.env) {
  const dir = env.DSH_PROFILE_DIR
  if (dir && String(dir).trim()) return String(dir).trim()
  const profile = env.DSH_PROFILE
  if (profile && String(profile).trim()) {
    return path.join(resolveDshHome(env), 'profiles', String(profile).trim())
  }
  return undefined
}

/** 统一成 forward-slash 小写比较用的形式。 */
export function normalize(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 判断 child 是否在 parent 之内（含相等）。 */
export function isInside(child, parent) {
  const c = normalize(child).toLowerCase()
  const p = normalize(parent).toLowerCase()
  if (!c || !p) return false
  return c === p || c.startsWith(p + '/')
}

/**
 * DSH 的「运行资源」目录：动这些地方会让 DSH 自身出问题。
 *
 * 每一项都是「目录 + 说明」，判定时用 isInside 比较，
 * 不依赖具体文件名，所以 DSH 升级改了文件名也不会失效。
 */
export function protectedRoots(env = process.env) {
  const home = resolveDshHome(env)
  const roots = [
    // 会话日志、项目缓存、sidebar 树、workspace 注册表都在这里
    { dir: path.join(home, 'storages'), why: 'DSH 的存储目录（workspace/侧栏/会话缓存）' },
    // 会话正文
    { dir: path.join(home, 'sessions'), why: 'DSH 的会话日志' },
    // 附件、凭据
    { dir: path.join(home, 'attachments'), why: 'DSH 的附件存储' },
  ]

  const profileDir = resolveProfileDir(env)
  if (profileDir) {
    roots.push({ dir: profileDir, why: 'DSH 的 profile（配置与已装插件）' })
  }

  return roots
}

/**
 * 精确到「文件级」的保护名单。
 *
 * 有些文件不在上面那些目录里，但同样是 DSH 运行必需的。
 * 用文件名匹配，跨平台都成立。
 */
const PROTECTED_FILENAMES = [
  /^workspace\.json$/i,
  /^sidebar-tree\.json$/i,
  /^AGENTS\.md$/i,
]

const PROTECTED_PATH_PATTERNS = [
  // profile 里的插件链接目标
  /\/node_modules\/[^/]+$/i,
  // cordis 组合配置
  /\/cordis\.(yml|patch\.yml|yaml)$/i,
  // 会话日志
  /\/sessions?\/[^/]+\.(json|jsonl)$/i,
  // 项目缓存
  /session_projcache/i,
]

/**
 * 判断一个路径是否是 DSH 运行资源。
 * @returns {{ protected: boolean, why?: string }}
 */
export function classifyPath(target, env = process.env) {
  if (!target) return { protected: false }
  const n = normalize(target)
  if (!n) return { protected: false }

  // ① 目录归属
  for (const { dir, why } of protectedRoots(env)) {
    if (isInside(n, dir)) return { protected: true, why }
  }

  // ② 文件名
  const base = n.split('/').pop() || ''
  for (const re of PROTECTED_FILENAMES) {
    if (re.test(base)) return { protected: true, why: 'DSH 的核心配置文件 ' + base }
  }

  // ③ 路径形状
  for (const re of PROTECTED_PATH_PATTERNS) {
    if (re.test(n)) return { protected: true, why: 'DSH 的运行路径（' + re.source + '）' }
  }

  return { protected: false }
}

/**
 * 判断目标是否是「被 node_modules 链接加载的插件目录」。
 * 只对这些目录本身改名/删除才会断链，改里面的文件是正常开发。
 */
export function isLoadedPluginDir(target, env = process.env) {
  const n = normalize(target)
  if (!n) return false
  if (!/\/node_modules\/[^/]+$/i.test(n)) return false

  // 必须真的存在且是目录，才谈得上「正在被加载」
  try {
    const stat = fs.statSync(target)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * 当前 DSH 进程可能的可执行文件名。
 *
 * 为什么给一组而不是一个：DSH 在不同平台/打包方式下进程名不同——
 * Electron 打包版是「DeepSeek Harness.exe」，命令行版是 dsh，
 * 用户也可能用 deepseek-harness 启动。漏掉任何一个都会让守卫失效。
 */
export function dshProcessNames(env = process.env) {
  const names = [
    'DeepSeek Harness',
    'DeepSeek-Harness',
    'deepseek-harness',
    'deepseek_harness',
    'dsh',
  ]
  const home = resolveDshHome(env)
  // 桌面端会写 runtime.json，存在即可确认这是桌面安装
  try {
    const marker = path.join(home, 'dsh-runtimes')
    if (fs.existsSync(marker)) names.push('DeepSeek')
  } catch { /* 读不到就只用默认名单 */ }
  return names
}

/**
 * 判断一段命令文本是否指向 DSH 进程。
 *
 * 用「边界匹配」而不是 simple includes：`dsh` 太短，
 * 直接 includes 会误伤 `--dsh-option` 之类的参数。
 */
export function mentionsDshProcess(text) {
  const s = String(text || '')
  if (!s) return false
  const patterns = [
    /deepseek[\s_-]*harness/i,
    /\bdsh\b/i,
    /deepseek(\.exe)?\b/i,
  ]
  return patterns.some((re) => re.test(s))
}
