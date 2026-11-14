# dsh-rules-guard · 规则守卫

[![test](https://github.com/tuifeibenfeifei/dsh-rules-guard/actions/workflows/test.yml/badge.svg)](https://github.com/tuifeibenfeifei/dsh-rules-guard/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--0-8b5cf6.svg)](https://github.com/deepseek-ai/deepseek-harness)

把 AI 助手「知道规则但不遵守」变成**工具层硬拦截**。

> 配套插件：[dsh-rules](https://github.com/tuifeibenfeifei/dsh-rules) —— 提供 6 层 28 条通用规则模板和设置页编辑器。

## 解决什么问题

几乎每个用 AI 编程助手的人都遇到过同一类事故：

- 助手把你正在运行的程序的目录改名了，程序重启后加载失败
- 助手往程序的数据文件里手写了一条记录，程序启动校验失败，所有功能失灵
- 助手为了「让改动生效」直接杀了自己正在运行的进程，当前对话中断，还误以为重启成功
- 助手改了一堆代码，告诉你「应该没问题」，实际一次都没跑过

`AGENTS.md` 里写几十条规则也拦不住。原因不是规则写得不好，而是**违反没有即时代价**——模型读到「不可逆操作前要停下」和它真的停下，中间隔着一次自由裁量。

这个插件把最危险的那几类变成**物理上做不到**：命令根本不会执行，助手只会收到一条拒绝原因。

## 怎么做到的

DSH 提供 `ctx.tools.guard()`，在工具真正执行前调用，返回字符串即拒绝。这是唯一的硬拦截点。

判定逻辑分三步：

1. **解析命令语义**，不穷举命令名
   - 先剥包裹层：`sh -c "..."`、`cmd /c "..."`、`sudo`、`ssh host "..."`、`docker exec`
   - 再按分隔符切成独立命令段（`&&`、`;`、`|`）
   - 对每段识别动作类型：`delete` / `move` / `write` / `kill` / `none`

2. **推导受保护目标**，不写死路径
   - 从 `DSH_HOME`、`DSH_PROFILE_DIR` 运行时推导，换机器、改目录都成立
   - 覆盖存储目录、会话日志、附件、profile、插件链接、cordis 配置

3. **只在「不可逆动作 × 受保护目标」同时成立时拦截**
   - 单纯动作危险（删临时文件）不拦
   - 单纯目标敏感（读配置文件）不拦
   - 两个条件同时满足才拦

## 拦什么

| 拦截 | 判定方式 | 典型事故 |
| --- | --- | --- |
| 终止 DSH 自身进程 | 命令语义是 `kill` 且目标匹配 DSH 进程名（含包裹命令） | `taskkill` 把自己的执行环境杀掉，任务中断 |
| 写入运行数据 | 写/删/移动动作 且 目标在 DSH 运行目录内 | 手写 workspace 记录导致启动校验失败，全部功能失灵 |
| 改名已加载的插件目录 | `move`/`delete` 动作 且 目标是 profile 里链接的插件目录 | 改名导致符号链接断链，重启后加载失败 |

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖，或在插件设置页改：

```yaml
- id: rules-guard
  config:
    enabled: true
    blockSelfKill: true
    blockProtectedWrites: true
    blockLoadedPluginDir: true
    extraProtectedPaths: []   # 额外保护的路径前缀
    allowPaths: []            # 明确放行，优先级最高
    verbose: true             # 拒绝时附修复建议
```

## 已知边界

- **只拦工具调用**：用户自己在 DSH 外改名、删文件，这个插件管不了。
- **判定异常时放行**：守卫自己出错会放行而不是拦死，避免一个 bug 让所有工具失效。代价是可能漏拦。
- **按 PID 杀进程**：只有 PID 等于当前进程或父进程时才拦；杀别的进程不拦。
- **误伤是保守的**：命令文本里出现 `taskkill` + DSH 字样就会拦，哪怕只是想分析这段文本。这是刻意选择——宁可多拦一次，不要放过真杀进程的。
- **不替代规则**：它只覆盖「不可逆且后果严重」的少数动作。「改完代码更新文档」「收尾给下一步」这类流程规则仍然靠自觉，那是 `dsh-rules` 包的职责。

## 和 dsh-rules 的分工

| 包 | 职责 |
| --- | --- |
| `dsh-rules-guard` | **机制**：拦不住就真的做不了 |
| `dsh-rules` | **内容**：提供通用规则模板，用户勾选后写入自己的 AGENTS.md |

两者独立，可以只装一个。

## 安装

```
侧栏「插件」→「添加插件」→ 填包目录绝对路径
```

改代码后需重启 DSH（宿主侧插件，link 加载也不热更新）。

## 自测

```bash
node test/generic.test.mjs
```

覆盖跨环境（Windows / POSIX / 无环境变量）、包裹命令、中文路径、只读工具不误伤、用户白名单与自定义保护路径。

## 版本记录

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT
