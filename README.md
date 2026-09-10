# zcode-bridge v1.4.1

通过官方 ZCode CLI 委派任务的本地 stdio MCP 服务。支持后台执行、等待、续聊、停止，以及独立 Review 和最终验收记录。退出码 0 只表示进程正常结束，不代表任务已经验收。

## 环境与配置

面向 Windows，使用 Node.js 标准库，无需 npm install。使用现代 Node.js（本副本验证环境为 Node.js 24），并在 ZCode 桌面版完成 Coding Plan 配置。

启动 MCP server 时通过环境变量 ZCODE_BRIDGE_CLI 指定官方 CLI 的绝对路径，即安装目录下 resources/glm/zcode.cjs。未指定时尝试 %ProgramFiles%/ZCode/resources/glm/zcode.cjs；这是默认候选位置，不保证适用于所有安装方式。

客户端配置示例（替换为实际路径；不同客户端的格式可能不同）：

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

凭据在运行时读取 ~/.zcode/v2/config.json；不要把凭据放入仓库或上述示例。先调用 zcode_doctor，它不请求模型；确认正常后再派发任务。

## 九个工具

- zcode_doctor：检查 Node、CLI、凭据和模型配置，不请求模型。
- zcode_start：创建后台任务；project_dir 为绝对路径，prompt 与 prompt_file 二选一，audit 必填。
- zcode_wait：等待，单次最长 60 秒；timeout_ms=0 返回快照。
- zcode_status：查询任务或列表。
- zcode_result：读取结果。
- zcode_followup：续聊，默认沿用模型；需要已有 session 和上一轮 Review。
- zcode_stop：停止进程，不回滚文件。
- zcode_record_review：记录独立检查、问题和文件证据。
- zcode_finalize：记录最终结论并生成报告。

默认模型 GLM-5.3-Flash；可显式选择已配置的 GLM-5.3。模式仅支持 edit 和 plan。start 返回只代表已提交，应继续 wait、检查真实产物、record_review，最后 finalize。需要运行终端命令时由总控执行。

每阶段默认最多三次 repair；phase 切换要求上一阶段 PASS。字段详见 [审计协议](docs/AUDIT_PROTOCOL.md)，以 tools/list 返回的 schema 为准。

## 数据与隐私

目标项目的 .zcode-mcp/ 保存任务正文、结果及日志镜像。主机基础目录默认为 %LOCALAPPDATA%/zcode-mcp-bridge，控制与审计数据在其 control/ 和 audits/ 下。运行时模型请求会把任务及 CLI 读取的相关上下文发送到已配置的模型服务。

项目内镜像不能决定 CLI、模型、模式、超时、session、instruction 或 cwd。执行参数和任务正文来自项目外权威快照。控制区不保存 API Key，并对当前密钥进行输出脱敏；这不是对其他个人信息的自动匿名化。使用者仍需检查任务、日志和报告。

新项目 CLI runtime 使用主机配置根；存在会话库时优先使用配置根，再考虑旧默认根。ZCODE_BRIDGE_RUNTIME_ROOT 可覆盖基础目录。默认根中的 authority-location.json 可配置绝对 root，用于不支持原子重命名等情况。主机配置不应从目标项目内读取。迁移已有库应在无活动 worker 时一致性备份并校验，避免丢失新进展。

这是数据来源隔离，不是同一操作系统用户之间的权限隔离。guard 失败会尽力留结果；磁盘故障和强制终止仍可能阻止落盘。status 拒绝项目外 Junction。

自动报告 docs/ZCODE_EXPERIENCE_LOG.md、docs/ZCODE_EXPERIENCE_STATS.json 可能包含真实使用记录，已加入 .gitignore。不要强制加入 Git，也不要上传会话数据库、原始日志、凭据或整个运行目录。

## 验证

    node tests/run_tests.mjs

32 场景、160 断言，全部使用 fake CLI，不请求真实模型。主机定位测试使用临时 LOCALAPPDATA 和 authority-location.json，不读取使用者的主机定位配置。结果见 [测试输出](tests/validation.txt)。

覆盖控制镜像篡改、guard 失败、Junction、停止与超时、会话、并发续聊、审计和报告等列出的路径。测试通过不代表覆盖所有未来 CLI 或文件系统行为。更新代码后需新 MCP server 进程加载，已运行的连接不会热更新。

旧 zcode-agent Skill 已停用。本发布副本不附带旧 Skill、个人历史导入脚本或真实模型测试驱动。
