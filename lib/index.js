// dsh-rules-guard —— 把规则从「应该自觉」变成「工具层硬拦截」
//
// ## 解决什么问题
//
// AGENTS.md 里写了几十条规则，仍然反复被违反。根因不是规则写得不好，而是
// **违反没有即时代价**：模型读到「不可逆操作前要停下」，和它真的停下，
// 中间隔着一次自由裁量。
//
// 成熟实现的共识（Claude Code PreToolUse hook、damage-control-dev、
// agentwall）都是同一个思路：在工具真正执行前判定，拒绝即不执行。
// 本插件用 ctx.tools.guard() 实现同样的结构。
//
// ## 为什么是「通用」的
//
// 不写死任何用户路径、不穷举命令名：
//   - 受保护路径从 DSH_HOME / DSH_PROFILE_DIR 运行时推导
//   - 命令先剥包裹层（sh -c、cmd /c、sudo、ssh）再按语义分类
//   - 只在「不可逆动作 × 受保护目标」同时成立时拦截
//
// 换一台电脑、改一个 DSH_HOME、换一套自己的规则，行为都一致。

import { decide, DEFAULT_CONFIG } from './policy.js'

export const name = 'dsh-rules-guard'
export const inject = ['tools']

export function apply(ctx, config) {
  try {
    const merged = { ...DEFAULT_CONFIG, ...(config || {}) }

    ctx.effect(() => {
      const dispose = ctx.tools.guard((exec) => {
        try {
          const result = decide(
            {
              toolName: exec && exec.name,
              args: exec && exec.arguments,
            },
            merged,
            process.env,
          )
          if (result.decision === 'block') return result.reason
          return undefined
        } catch (e) {
          // 守卫自己出错时放行而不是拦死一切：一个 bug 不该让所有工具失效。
          // 代价是可能漏拦，但拦死会让用户完全无法工作，权衡后选放行。
          try { console.error('[dsh-rules-guard] 判定异常，已放行：', e) } catch { /* 忽略 */ }
          return undefined
        }
      })
      return () => {
        try { typeof dispose === 'function' && dispose() } catch { /* 忽略 */ }
      }
    }, 'rules-guard: tool guard')

    console.log('[dsh-rules-guard] 工具守卫已挂载')
  } catch (e) {
    console.error('[dsh-rules-guard] apply 失败：', e)
  }
}
