# Changelog

本文件记录 dsh-rules-guard 的版本变化。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-14

### 新增

- 基于 `ctx.tools.guard()` 的工具层硬拦截，命中即拒绝执行，命令不会跑
- 三条内置拦截：
  - **终止 DSH 自身进程**：命令语义是 `kill` 且目标匹配 DSH 进程名
  - **写入运行数据**：写/删/移动动作 且 目标在 DSH 运行目录内
  - **改名已加载的插件目录**：`move`/`delete` 动作 且 目标是 profile 里链接的插件目录
- 命令语义解析（`lib/parse.js`）：
  - 剥包裹层：`sh -c`、`bash -c`、`pwsh -Command`、`cmd /c`、`sudo`、`env`、`nohup`、`ssh host`、`docker exec/run`
  - 按分隔符切分：换行、`;`、`&&`、`||`、`|`
  - 语义分类：`delete` / `move` / `write` / `kill` / `none`，不按命令名穷举
- 受保护路径运行时推导（`lib/paths.js`）：
  - 从 `DSH_HOME`、`DSH_PROFILE_DIR`、`DSH_PROFILE` 推导，不写死任何路径
  - 无环境变量时回退 `~/.dsh`
  - 覆盖存储目录、会话日志、附件、profile、插件链接、cordis 配置
- 策略判定（`lib/policy.js`）：只在「不可逆动作 × 受保护目标」同时成立时拦截
- 只读工具（`read`/`grep`/`stat` 等）访问受保护路径不拦截，避免误伤
- 跨环境测试（`test/generic.test.mjs`）：Windows / POSIX / 无环境变量三套环境，含中文路径

### 设计依据

- Claude Code 的 `PreToolUse` hook：返回 deny 即阻止，多个 hook 以最严格者为准
- [damage-control-dev](https://pypi.org/project/damage-control-dev/)：策略阶梯 allow/ask/block，重扫包裹命令
- [agentwall-sdk](https://pypi.org/project/agentwall-sdk/)：调用分类 + 结构化事件

### 已知边界

- 只拦工具调用，不拦用户在 DSH 外的操作
- 判定异常时放行而非拦死，避免一个 bug 让所有工具失效
- 按 PID 杀进程只在 PID 等于当前或父进程时拦截
- 误伤是保守的：命令文本含关键词就会拦，哪怕只是分析该文本

### 撤销与配置

- 通过 `apply(ctx, config)` 接收配置，支持 `enabled` / `blockSelfKill` / `blockProtectedWrites` / `blockLoadedPluginDir` / `extraProtectedPaths` / `allowPaths` / `verbose`
- 不声明 `Config` schema，避免依赖 schema 库；配置在插件行里传
