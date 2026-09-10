# zcode-bridge

**让 MCP 客户端通过官方 ZCode CLI 委派编程任务，并保留可检查的执行、审查和验收记录。**

**Delegate coding tasks from an MCP client to the official ZCode CLI, with inspectable execution, review, and acceptance records.**

Version: **1.4.1** · Transport: **stdio MCP** · Tested platform: **Windows / Node.js 24**

[中文说明](#中文说明) · [English](#english) · [审计协议 / Audit protocol](docs/AUDIT_PROTOCOL.md) · [测试结果 / Test results](tests/validation.txt)

## 中文说明

### 这个项目做什么

zcode-bridge 是连接 MCP 客户端与 ZCode CLI 的本地桥接服务。总控客户端负责定义任务、检查实际改动和运行验证；ZCode 在目标项目中执行已授权的编程任务。适合需要后台执行、多轮补充和明确验收条件的编码工作。

例如：总控把一个范围明确的多文件修改任务派给 ZCode，等待结果，检查实际 diff 并运行测试；发现问题后在原会话中补充修复要求，最后记录验收结论。任务提交、进程退出、代码正确和最终验收是不同状态。

项目提供通用 stdio MCP 接口，可供支持该传输方式的客户端配置使用。不同客户端的配置格式和工具呈现方式可能不同；本仓库不声称已逐一验证所有客户端。运行模型任务需要你自己的 ZCode 配置及可用模型额度。

### 主要能力

- 后台任务：start 快速返回任务标识，再用 wait/status 查看进展。
- 会话续聊：followup 复用已有会话，默认沿用上一轮模型。
- 进程控制：支持超时和主动停止；停止不会回滚已写入文件。
- 独立审查：记录问题等级、证据文件和审查结论。
- 最终验收：区分 PASS、PARTIAL、FAIL，生成本地经验报告。
- 控制数据隔离：项目内文件是证据镜像，执行参数来自项目外权威数据。
- 零模型回归：用 fake CLI 验证已列出的正常、异常与并发路径。

### 环境要求与安装

1. Windows 和现代 Node.js。本发布副本的验证环境为 Node.js 24；源码仅依赖 Node 标准库，无需 npm install。
2. 已安装官方 ZCode，并在桌面版完成 Coding Plan 配置。
3. 将本仓库放到本地目录，找到 ZCode 安装目录中的 resources/glm/zcode.cjs。
4. 在 MCP 客户端中注册 server.mjs，配置实际 CLI 路径。

通用 JSON 配置示例，所有路径均需替换为你的实际路径：

    {
      "mcpServers": {
        "zcode-bridge": {
          "command": "node",
          "args": ["C:/Projects/zcode-mcp-bridge/server.mjs"],
          "env": {
            "ZCODE_BRIDGE_CLI": "C:/Program Files/ZCode/resources/glm/zcode.cjs"
          }
        }
      }
    }

Codex 使用 TOML 配置时，对应结构示例：

    [mcp_servers.zcode-bridge]
    command = "node"
    args = ["C:/Projects/zcode-mcp-bridge/server.mjs"]

    [mcp_servers.zcode-bridge.env]
    ZCODE_BRIDGE_CLI = "C:/Program Files/ZCode/resources/glm/zcode.cjs"

以上仅为配置示例，不会自动修改客户端配置。若 node 不在 PATH 中，使用其绝对路径。未指定 ZCODE_BRIDGE_CLI 时，服务尝试 %ProgramFiles%/ZCode/resources/glm/zcode.cjs，该候选位置不一定适合你的安装方式。

凭据默认在运行时从 ~/.zcode/v2/config.json 读取。不要把 API Key 写入仓库或以上示例。连接后先调用 zcode_doctor，它只检查环境，不发起模型请求。

### 九个 MCP 工具

| 工具 | 用途 |
| --- | --- |
| zcode_doctor | 检查 Node、CLI、凭据与模型配置，不请求模型 |
| zcode_start | 派发后台任务；需要绝对 project_dir、任务正文及 audit |
| zcode_wait | 等待进展，单次最长 60 秒；timeout_ms=0 返回快照 |
| zcode_status | 查看单任务或任务列表 |
| zcode_result | 获取执行结果 |
| zcode_followup | 在已有会话中补充要求或修复问题 |
| zcode_stop | 停止任务进程，不回滚文件 |
| zcode_record_review | 记录独立审查、问题分类和文件证据 |
| zcode_finalize | 保存最终验收结论并生成报告 |

### 推荐任务流程

1. doctor 检查环境。
2. start 提交任务，写清目标、允许修改范围、约束和验收方法。
3. wait 等待终态；需要时用 status/result 查看细节。
4. 总控检查真实产物或 diff，并执行适当的测试。
5. record_review 记录本轮结论。
6. 如需继续，followup 后重复等待与审查。
7. finalize 记录最终验收。

默认模型为 GLM-5.3-Flash，可显式指定已配置的 GLM-5.3。支持 edit 和 plan，不支持 yolo/build。prompt 与 prompt_file 必须二选一；prompt_file 必须位于目标项目内。默认任务超时为 600 秒。工具的完整参数以 tools/list schema 为准。

start 必填 audit，包括任务名称、类型、委派原因、范围、验收条件、验证计划及风险说明。每阶段默认最多三次 repair；phase 切换要求上一阶段 PASS。最终 PASS 要求最近轮 PASS Review、没有未解决的 VERIFIED P0/P1，并提供客观文件证据。详细规则见 [审计协议](docs/AUDIT_PROTOCOL.md)。

小型修改不一定值得派发：模型每轮仍有上下文成本。需要安装依赖、构建或运行终端命令时，由总控接手执行。

### 数据存储与隐私

| 数据 | 默认位置与作用 |
| --- | --- |
| 项目内镜像 | 目标项目的 .zcode-mcp/，保存任务正文、结果与日志 |
| 权威控制与审计 | 主机基础目录中的 control/、audits/ |
| CLI runtime | 主机根下按项目哈希分目录，存放会话及缓存 |
| 生成报告 | 目标项目 docs/ZCODE_EXPERIENCE_LOG.md 和 docs/ZCODE_EXPERIENCE_STATS.json |

主机基础目录默认为 %LOCALAPPDATA%/zcode-mcp-bridge。ZCODE_BRIDGE_RUNTIME_ROOT 可覆盖基础目录；默认根中的 authority-location.json 也可指定绝对 root。新项目使用配置根，已有会话库优先选择配置根，其次旧默认根。迁移数据库应在无活动 worker 时做一致性备份和校验。

项目内镜像不能决定 CLI、模型、模式、超时、session、instruction 或 cwd。控制区不保存 API Key，输出会对当前密钥进行脱敏，但不会自动匿名化其他个人信息。运行真实任务时，任务及 CLI 读取的相关上下文会发送到配置的模型服务。

这属于数据来源隔离，并非同一系统用户之间的权限隔离。发布前请检查任务正文、日志、证据及生成报告。本仓库忽略运行目录、数据库、密钥文件和自动经验报告；不要强制将这些内容加入 Git。

### 测试与已知边界

    node tests/run_tests.mjs

**32 场景、160 断言通过；测试全部使用 fake CLI，不调用真实模型。**

测试覆盖镜像篡改、guard 失败、Junction、停止与超时、会话处理、并发续聊、审计和报告等路径。主机定位测试使用隔离的临时配置，不依赖开发者主机。参见 [完整测试输出](tests/validation.txt)。

- Windows 是当前验证平台，不保证其他系统具有相同行为。
- guard 尽力保留结构化结果，磁盘故障或强制终止仍可能阻止落盘。
- 更换 CLI 版本、插件或文件系统后，可能需要重新验证。
- 更新 server.mjs 后需要新的 MCP server 进程加载，现有连接不会热更新。
- 旧 zcode-agent Skill 已停用，发布副本不附带旧 Skill 或真实模型测试驱动。

## English

### What this project does

zcode-bridge is a local bridge between an MCP client and the official ZCode CLI. The coordinating client defines the task, inspects actual changes, and runs validation; ZCode performs authorized coding work in the target project.

A typical workflow is to delegate a scoped change across several files, wait for completion, review the diff, run tests, request a repair in the same session if needed, and record final acceptance. Submission, process completion, correctness, and acceptance are separate states.

The service exposes a standard stdio MCP interface. Client configuration formats and tool presentation may differ; this repository does not claim compatibility testing with every MCP client. Real model tasks require your own configured ZCode access and available model quota.

### Features

- Background execution with separate submission and waiting.
- Session continuation with model continuity by default.
- Timeouts and explicit process stopping, without file rollback.
- Independent reviews with issue severity and evidence files.
- Final PASS, PARTIAL, or FAIL records and local reports.
- Execution controls stored outside the target project.
- Fake-CLI regression tests with no real model requests.

### Requirements and setup

1. Windows and a modern Node.js installation. This public snapshot was tested with Node.js 24.
2. The official ZCode application with Coding Plan configured.
3. A local checkout of this repository.
4. The absolute path to resources/glm/zcode.cjs inside your ZCode installation.

No npm install is required: the source uses Node.js standard libraries. Configure your MCP client to launch node with the absolute path to server.mjs, and set ZCODE_BRIDGE_CLI to the actual CLI path. The JSON and Codex TOML examples above use generic paths; replace them for your machine.

If node is not on PATH, use its absolute path. Without ZCODE_BRIDGE_CLI, the service tries %ProgramFiles%/ZCode/resources/glm/zcode.cjs. This is only a default candidate, not a guaranteed installation path.

Credentials are read at runtime from ~/.zcode/v2/config.json by default. Do not include API keys in this repository or client configuration examples. After connecting, call zcode_doctor first: it checks the environment without sending a model request.

### MCP tools

| Tool | Purpose |
| --- | --- |
| zcode_doctor | Check Node, CLI, credentials, and model configuration without a model request |
| zcode_start | Submit a background task with an absolute project_dir, brief, and audit metadata |
| zcode_wait | Wait up to 60 seconds per call; timeout_ms=0 returns a snapshot |
| zcode_status | Inspect one task or list tasks |
| zcode_result | Retrieve execution results |
| zcode_followup | Continue an existing session with changes or repair instructions |
| zcode_stop | Stop task processes without reverting files |
| zcode_record_review | Record independent review findings and file evidence |
| zcode_finalize | Record final acceptance and generate reports |

### Task and review workflow

Call doctor, submit with start, wait for a terminal state, inspect the actual files or diff, run appropriate checks, and record_review. Use followup when another round is necessary, then repeat the review cycle. Finish with finalize.

The default model is GLM-5.3-Flash; a configured GLM-5.3 can be selected explicitly. Only edit and plan modes are supported. Supply exactly one of prompt or prompt_file; a prompt file must be inside the target project. The default task timeout is 600 seconds. The tools/list schema is authoritative for complete parameters.

start requires audit metadata describing the task, scope, delegation reason, acceptance criteria, validation plan, and risk. Each phase allows up to three repair rounds by default; switching phases requires a PASS review. Final PASS requires the latest review to pass, no unresolved VERIFIED P0/P1 findings, and objective file evidence. See the [audit protocol](docs/AUDIT_PROTOCOL.md), currently documented in Chinese.

Small tasks may not justify the model context cost. The coordinating client should handle terminal commands such as dependency installation, builds, and tests.

### Storage and privacy

The target project's .zcode-mcp/ contains task, result, and log mirrors. Authoritative controls and audits live under control/ and audits/ in the host storage root. CLI sessions and caches use a project-hash directory under the host root. Reports are generated in the target project's docs directory.

The default root is %LOCALAPPDATA%/zcode-mcp-bridge. ZCODE_BRIDGE_RUNTIME_ROOT overrides it; authority-location.json in the default root can also specify an absolute root. New projects use the configured root. Existing session databases are preferred in the configured root, then in the legacy default location. Migrate databases only with no active worker, using a consistent backup and verification.

Project mirrors do not determine the CLI, model, mode, timeout, session, instruction, or working directory. Control records do not store the API key, and output redaction targets the current key. Other personal information is not automatically anonymized. Real tasks send the brief and relevant context read by the CLI to the configured model service.

This is a data-source trust boundary, not an operating-system boundary against processes running as the same user. Review task text, logs, evidence, and reports before publishing. Runtime data, databases, key files, and generated experience reports are excluded by .gitignore; do not force-add them.

### Testing and limitations

    node tests/run_tests.mjs

**32 scenarios and 160 assertions passed using only a fake CLI, with no real model calls.**

Coverage includes mirror tampering, guard failures, Junction boundaries, stopping, timeouts, session handling, competing followups, audits, and reports. Host-location tests use isolated temporary configuration. See the [test output](tests/validation.txt).

Windows is the verified platform. Disk failures or forced termination can still prevent result persistence. CLI, plugin, or filesystem changes may require fresh validation. Existing MCP processes do not hot-reload updated code; start a new server process after changes.

The former zcode-agent Skill is disabled and is not included in this public snapshot. Personal history, real sessions, raw logs, and model-run evidence are also excluded.

## Repository layout / 文件结构

| Path | 内容 / Contents |
| --- | --- |
| server.mjs | MCP 服务与后台 worker / MCP service and background worker |
| audit.mjs | 审查、验收与报告 / Reviews, acceptance, and reporting |
| tests/ | fake CLI 回归及结果 / Fake-CLI regression tests and results |
| docs/AUDIT_PROTOCOL.md | 审计协议 / Audit protocol |
| docs/PUBLIC_RELEASE.md | 脱敏发布范围 / Public snapshot scope |
| scripts/generate_experience_report.mjs | 本地报告生成 / Local report generation |

    node scripts/generate_experience_report.mjs <project_dir> [YYYY-MM]

报告可能含真实使用记录，保持本地保存。
Reports may contain real usage records; keep them local.
