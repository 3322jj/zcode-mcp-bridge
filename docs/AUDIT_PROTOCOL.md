# 委派审计协议 v1.4

## 生命周期

doctor → start(audit) → wait/result → 独立 Review/测试 → record_review → followup 或 finalize。
每阶段首次实现后默认允许三次 repair。followup_kind=phase 需要上阶段 PASS、无未解决 VERIFIED P0/P1，新的阶段不消耗旧阶段修复次数。
超过三次 repair 需要 override_authorization 文本，并产生 repair_limit_overridden 事件。该字段是总控转交的授权证据；本地服务不能独立认证用户身份。

## start.audit（必填）

task_name、task_type、delegation_reason 是非空字符串。
scope、acceptance_criteria、validation_plan 是非空字符串数组。
risk_level 为 low/medium/high；high_risk_operations 为字符串数组，可空。
原任务书经过当前 API Key 脱敏后记录。CLI、model、mode、run_id、日期由服务器记录。

## record_review

project_dir、task_id、run_id、round 必须匹配当前已终态运行。verdict 为 PASS/NEEDS_FIX/BLOCKED。
executor 必填：zcode/codex/human/unknown，表示实际实现者，不是 Reviewer。codex/human 自动记录一次介入事件。
findings 是数组，可空。每项字段：finding_key、title、assessment、priority、category、status，以及证据。

- assessment：VERIFIED/LIKELY/DESIGN/FALSE_POSITIVE。
- priority：P0/P1/P2/P3；只有 VERIFIED 进入真实错误的优先级统计。
- category：requirement_miss/logic_bug/api_error/hallucinated_api/security/regression/edge_case/test_gap/overengineering/performance/other。
- status：open/fixed/not_fixed/regression。
- VERIFIED 的 evidence 必须包含 description 和 files（项目内绝对路径数组）。服务器读取并记录文件大小和 SHA-256，不保存内容。验证结论仍由 Reviewer 负责。
- validation_files 是可选客观验证文件路径数组。

每个 run 只允许一次 Review，不能修改过去的 Review；修正结论应在后续轮次使用同一个 finding_key 追加。未在新 Review 提及的旧问题保留其状态，不能靠省略消除阻塞。
同一 task+finding_key 去重；LIKELY/DESIGN 不算 ZCode 真实错误；FALSE_POSITIVE 单列为 Codex 误报。
自主修复需要先有未修复 VERIFIED 记录，再有 executor=zcode 的固定证据。报告分母为非历史任务的去重 VERIFIED 总数；未确认的修复不进入分子。

## finalize

输入 final_status=PASS/PARTIAL/FAIL、acceptance_met 布尔值。
build_result/test_result/runtime_result 各为 {status, summary}，未运行填 NOT_RUN 或 N/A，明确说明。
manual_interventions 是此次新增的介入描述数组；不要重复填写 record_review 已记录的接手。
good_performance、exposed_problems、model_observations、agent_observations、product_observations、mcp_observations、requirement_observations、zhipu_feedback 是字符串数组，可空。
validation_files 为可选文件路径数组。统计总数由事件计算，不使用调用方提交的 totals/statistics。

PASS 要求最近 run 的 PASS Review、没有未解决 VERIFIED P0/P1、acceptance_met=true，且 finalize 或最近 Review 有文件验证证据。
这里校验的是证据存在性与记录一致性，不自动证明业务成功。状态或测试结论不可只从模型的完成声明推导。
finalize 不可覆盖，完成后不能继续该任务。报告生成失败会明确返回 report_generated=false；最终审计仍保留，可重新运行生成脚本。

## 存储与恢复

基础根目录选择：ZCODE_BRIDGE_RUNTIME_ROOT → 主机 %LOCALAPPDATA%/zcode-mcp-bridge/authority-location.json.root → 默认目录。
control/<project-hash>/tasks 和 runs 保存执行权威；audits/<project-hash>/<taskId> 保存审计。
task.json 保存创建快照；events.jsonl 是追加式权威事件；rounds/round-NN.json 与 review-NN.json 为不可覆盖的每轮快照；final.json 为最终快照。
事件具有连续序号和 SHA-256 链，用于发现损坏；没有外部签名，不能防同用户攻击者重算链。目标项目中的镜像和生成报告均非权威来源。

写入使用任务锁、追加并 fsync，快照采用原子替换或独占创建。崩溃后遗留锁时失败关闭：先确认进程已退出，再人工移除该任务 .lock；不自动抢占未知所有者。单任务事件损坏会在报告 corrupted 中列出，其余任务继续统计。
磁盘耗尽、进程强杀或快照生成失败不能保证多文件事务完整；events.jsonl 是恢复依据。请不要把跨文件写入宣传成数据库事务。

v1.3.1 有权威 state 的终态任务可用 record_review.migration_audit 显式建立审计。迁移只记录当前轮，缺少的历史 UNKNOWN，不自动补造先前轮次。v1.3.0 仅有项目镜像的任务不能据此恢复执行。

## 报告和历史

node scripts/generate_experience_report.mjs <project_dir> [YYYY-MM]
无月份参数生成全部；按任务审计创建月份过滤。输出不含生成时刻，相同数据重复生成相同内容。
历史/迁移任务单列，不进入首次通过率、自主修复率等过程指标。手工历史导入必须标记 historical，证据不足填 UNKNOWN/null。

更新 server.mjs 后必须让新 MCP 进程重新 initialize/tools/list。当前已加载的连接不能热更新；本次测试用新进程验证九工具 schema 与调用链，未修改 Codex 配置。
