/**
 * zcode-bridge 本地全套测试：通过 stdio 驱动 server.mjs + fake_cli.mjs，
 * 覆盖正常路径与已列出的异常路径，零模型消耗。
 * 用法：node tests/run_tests.mjs
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, "server.mjs");
const FAKE_CLI = path.join(ROOT, "tests", "fake_cli.mjs");
const TMP = path.join(ROOT, "tests", ".tmp");
const AUDIT_META={task_name:"fake-test",task_type:"test",delegation_reason:"zero model verification",scope:["fixture"],acceptance_criteria:["assertions"],validation_plan:["fake CLI"],risk_level:"low",high_risk_operations:[]};
const FAKE_SECRET = "SUPER-SECRET-SENTINEL-123";

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// 假 v2 配置（含两个模型与哨兵密钥）
const fakeV2 = path.join(TMP, "fake-v2-config.json");
fs.writeFileSync(fakeV2, JSON.stringify({
  provider: {
    "builtin:bigmodel-coding-plan": {
      enabled: true,
      options: { apiKey: FAKE_SECRET, baseURL: "https://fake.bigmodel.local/api/anthropic" },
      models: { "GLM-5.3-Flash": { id: "GLM-5.3-Flash" }, "GLM-5.3": { id: "GLM-5.3" } },
    },
  },
}, null, 2));

const fakeV2NoBase = path.join(TMP, "fake-v2-no-baseurl.json");
fs.writeFileSync(fakeV2NoBase, JSON.stringify({
  provider: {
    "builtin:bigmodel-coding-plan": {
      enabled: true,
      options: { apiKey: FAKE_SECRET },
      models: { "GLM-5.3-Flash": { id: "GLM-5.3-Flash" } },
    },
  },
}));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (detail ? ` —— ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " —— " + detail : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkServer(envExtra = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      ZCODE_BRIDGE_CLI: FAKE_CLI,
      ZCODE_BRIDGE_V2_CONFIG: fakeV2,
      ZCODE_BRIDGE_MIN_TIMEOUT_SEC: "1",
      ZCODE_BRIDGE_RUNTIME_ROOT: path.join(TMP, "runtimes"),
      ZBRIDGE_TEST_LEAK: "SHOULD-NOT-PASS",
      ...envExtra,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch { /* 坏帧忽略 */ }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + " 超时")); } }, 90000);
  });
  const tool = async (name, args) => {
    if(name==="zcode_start"&&!args.audit)args={...args,audit:AUDIT_META};
    if(name==="zcode_followup"){
      try {const audit=await import("../audit.mjs");const previousEnv=process.env.ZCODE_BRIDGE_RUNTIME_ROOT;process.env.ZCODE_BRIDGE_RUNTIME_ROOT=path.join(TMP,"runtimes");
        let log;try{log=audit.readAudit(args.project_dir,args.task_id);}finally{if(previousEnv===undefined)delete process.env.ZCODE_BRIDGE_RUNTIME_ROOT;else process.env.ZCODE_BRIDGE_RUNTIME_ROOT=previousEnv;}
        const run=log.events.filter(e=>["run_started","followup_started"].includes(e.type)).at(-1);
        if(!log.events.some(e=>e.type==="review_recorded"&&e.data.run_id===run.data.run_id))await call("tools/call",{name:"zcode_record_review",arguments:{project_dir:args.project_dir,task_id:args.task_id,run_id:run.data.run_id,round:run.data.round,verdict:"PASS",executor:"zcode",findings:[],validation_files:[path.join(args.project_dir,".zcode-mcp","runs",run.data.run_id,"result.json")]}});
      }catch{}
    }
    const r = await call("tools/call", { name, arguments: args });
    return { isError: Boolean(r.isError), text: r.content && r.content[0] ? r.content[0].text : "", sc: r.structuredContent };
  };
  const init = () => call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tests", version: "0" } })
    .then((r) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n") && r);
  return { proc, call, tool, init, kill: () => proc.kill() };
}

function projDir(name) {
  const p = path.join(TMP, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function ctl(project,kind,id,file) {
 const hash=createHash("sha256").update(path.resolve(project).toLowerCase()).digest("hex").slice(0,16);
 return path.join(TMP,"runtimes","control",hash,kind,id,file);
}
function stateOf(project, taskId) {
  return JSON.parse(fs.readFileSync(ctl(project,"tasks",taskId,"state.json"), "utf8"));
}
function resultFileOf(project, runId) {
  return JSON.parse(fs.readFileSync(path.join(project, ".zcode-mcp", "runs", runId, "result.json"), "utf8"));
}

async function waitTerminal(s, project, taskId, maxMs = 60000) {
  const deadline = Date.now() + maxMs;
  let last;
  while (Date.now() < deadline) {
    const r = await s.tool("zcode_wait", { project_dir: project, task_id: taskId, timeout_ms: 3000 });
    last = r;
    if (!r.isError && r.sc && r.sc.still_running === false) return r.sc;
    if (r.isError) throw new Error("wait 报错: " + r.text);
    await sleep(300);
  }
  throw new Error("等待终态超时: " + JSON.stringify(last && last.sc));
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// ---------------------------------------------------------------- 场景

async function scenario_handshake() {
  console.log("\n[1] 握手 / instructions / annotations / schema");
  const s = mkServer();
  const init = await s.init();
  check("initialize 返回 instructions 且含核心规则", typeof init.instructions === "string" && init.instructions.includes("核心规则"));
  check("instructions 前 512 字符包含关键规则", init.instructions.slice(0, 512).includes("退出码 0 不代表业务成功"));
  const tools = (await s.call("tools/list")).tools;
  check("9 个工具（原七个 + 审计两个）", tools.length === 9);
  const start = tools.find((t) => t.name === "zcode_start");
  check("start schema 无 anyOf", !JSON.stringify(start.inputSchema).includes("anyOf"));
  const ro = ["zcode_doctor", "zcode_status", "zcode_wait", "zcode_result"];
  check("四个只读工具带 readOnlyHint", ro.every((n) => tools.find((t) => t.name === n)?.annotations?.readOnlyHint === true));
  check("start 为写入型 open-world", start.annotations.readOnlyHint === false && start.annotations.openWorldHint === true);
  check("stop 带 destructiveHint", tools.find((t) => t.name === "zcode_stop")?.annotations?.destructiveHint === true);
  const doc = await s.tool("zcode_doctor", {});
  check("doctor 通过（假配置）", !doc.isError && doc.sc.ok === true);
  s.kill();
}

async function scenario_normal() {
  console.log("\n[2] 正常返回 + 结果落盘");
  const s = mkServer();
  await s.init();
  const p = projDir("normal");
  const r = await s.tool("zcode_start", { project_dir: p, mode: "plan", prompt: "@fake:mode=ok,session=sess_A 链路自检" });
  check("start 秒回 queued", !r.isError && r.sc.status === "queued");
  const w = await waitTerminal(s, p, r.sc.task_id);
  check("终态 returned", w.status === "returned");
  check("response 为 fake-ok", w.result.response === "fake-ok");
  check("session_id 为 sess_A", w.result.session_id === "sess_A");
  const st = stateOf(p, r.sc.task_id);
  check("state.session_id 正确", st.session_id === "sess_A");
  check("result.json 存在且结构化", resultFileOf(p, r.sc.run_id).process_ok === true);
  check("brief.md 已写", fs.existsSync(path.join(p, ".zcode-mcp", "tasks", r.sc.task_id, "brief.md")));
  const res = await s.tool("zcode_result", { project_dir: p, task_id: r.sc.task_id });
  check("zcode_result 全文一致", !res.isError && res.sc.result.response === "fake-ok");
  s.kill();
}

async function scenario_delay_stop() {
  console.log("\n[3] 延迟与停止（stop_requested 可见，终态 stopped）");
  const s = mkServer();
  await s.init();
  const p = projDir("delaystop");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=delay,ms=20000 长任务" });
  const w1 = await s.tool("zcode_wait", { project_dir: p, task_id: r.sc.task_id, timeout_ms: 1500 });
  check("等待中 still_running=true", !w1.isError && w1.sc.still_running === true);
  const st = await s.tool("zcode_stop", { project_dir: p, task_id: r.sc.task_id });
  check("stop 返回 stop_requested", !st.isError && st.sc.stop_requested === true);
  const w2 = await waitTerminal(s, p, r.sc.task_id);
  check("终态 stopped", w2.status === "stopped");
  check("exit_code=130", w2.result.exit_code === 130);
  s.kill();
}

async function scenario_timeout() {
  console.log("\n[4] 整轮超时（timed_out / 124）");
  const s = mkServer();
  await s.init();
  const p = projDir("timeout");
  const r = await s.tool("zcode_start", { project_dir: p, timeout_seconds: 1, prompt: "@fake:mode=delay,ms=15000 慢任务" });
  const w = await waitTerminal(s, p, r.sc.task_id);
  check("终态 timed_out", w.status === "timed_out");
  check("exit_code=124", w.result.exit_code === 124);
  s.kill();
}

async function scenario_spawnfail() {
  console.log("\n[5] spawn 失败（CLI 路径不存在：start 快速失败 + worker 自验兜底）");
  const s = mkServer({ ZCODE_BRIDGE_CLI: path.join(TMP, "nonexistent-cli.cjs") });
  await s.init();
  const doc = await s.tool("zcode_doctor", {});
  check("doctor 报 cli_is_file=false", !doc.isError && doc.sc.ok === false && doc.sc.checks.cli_is_file === false);
  const p = projDir("spawnfail");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "任意任务" });
  check("start 快速失败并提及 CLI", r.isError && r.text.includes("CLI"));
  s.kill();
}

async function scenario_nonjson() {
  console.log("\n[6] 非 JSON 输出（包成 response）");
  const s = mkServer();
  await s.init();
  const p = projDir("nonjson");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=nonjson 乱输出" });
  const w = await waitTerminal(s, p, r.sc.task_id);
  check("returned 且原文保留", w.status === "returned" && w.result.response.includes("PLAIN-TEXT"));
  s.kill();
}

async function scenario_huge() {
  console.log("\n[7] 巨大输出（payload 截断、日志完整）");
  const s = mkServer();
  await s.init();
  const p = projDir("huge");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=huge 巨量输出" });
  const w = await waitTerminal(s, p, r.sc.task_id, 90000);
  check("returned", w.status === "returned");
  const full = resultFileOf(p, r.sc.run_id);
  check("result.response 已截断", typeof full.result.response === "string" && full.result.response.length <= 100100 && full.result.response.includes("[已截断"));
  const log = fs.readFileSync(path.join(p, ".zcode-mcp", "runs", r.sc.run_id, "stdout.log"), "utf8");
  check("stdout.log 保留完整原文", log.length >= 3000000);
  s.kill();
}

async function scenario_secret() {
  console.log("\n[8] 密钥出现在 stderr（全链路脱敏）");
  const s = mkServer();
  await s.init();
  const p = projDir("secret");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=secret 泄密场景" });
  const w = await waitTerminal(s, p, r.sc.task_id);
  check("终态 failed（exit 3）", w.status === "failed" && w.result.exit_code === 3);
  const rdir = path.join(p, ".zcode-mcp", "runs", r.sc.run_id);
  const errLog = fs.readFileSync(path.join(rdir, "stderr.log"), "utf8");
  check("stderr.log 不含密钥且已替换", !errLog.includes(FAKE_SECRET) && errLog.includes("[REDACTED]"));
  const reportStr = fs.readFileSync(path.join(rdir, "result.json"), "utf8");
  check("result.json 不含密钥", !reportStr.includes(FAKE_SECRET));
  const stdoutLog = fs.readFileSync(path.join(rdir, "stdout.log"), "utf8");
  check("stdout.log 不含密钥", !stdoutLog.includes(FAKE_SECRET));
  s.kill();
}

async function scenario_mismatch() {
  console.log("\n[9] sessionId 不一致（保留旧会话，新值只进报告）");
  const s = mkServer();
  await s.init();
  const p = projDir("mismatch");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=ok,session=sess_A 首轮" });
  await waitTerminal(s, p, r.sc.task_id);
  const f = await s.tool("zcode_followup", { project_dir: p, task_id: r.sc.task_id, prompt: "@fake:mode=mismatch 续聊" });
  check("followup 接受", !f.isError);
  const w = await waitTerminal(s, p, r.sc.task_id);
  check("续聊终态 failed", w.status === "failed");
  check("exit_code=2（会话不一致）", w.result.exit_code === 2);
  const full = await s.tool("zcode_result", { project_dir: p, task_id: r.sc.task_id });
  check("不一致提示", full.text.includes("sessionId 不一致"));
  const st = stateOf(p, r.sc.task_id);
  check("state 保留旧会话 sess_A", st.session_id === "sess_A");
  const report = resultFileOf(p, st.run_id);
  check("新 sessionId 只进报告", report.session_id_returned === "sess_mismatch_NEW");
  s.kill();
}

async function scenario_orphan() {
  console.log("\n[10] 孤儿 child（worker 被硬杀 → interrupted → stop 回收）");
  const s = mkServer();
  await s.init();
  const p = projDir("orphan");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=delay,ms=60000 孤儿场景" });
  // 等 child 起来
  let childPid = null, workerPid = null;
  for (let i = 0; i < 40 && !childPid; i++) {
    await sleep(250);
    try {
      const st = stateOf(p, r.sc.task_id);
      childPid = st.child_pid;
      workerPid = st.worker_pid;
    } catch { /* 状态未就绪 */ }
  }
  check("child 已启动", Boolean(childPid));
  // 硬杀 worker（不带 /T；Windows job 语义下 child 可能随之自清，也可能存活为孤儿——两种都合法）
  const { spawnSync } = await import("node:child_process");
  spawnSync("taskkill", ["/PID", String(workerPid), "/F"], { windowsHide: true });
  await sleep(800);
  const stv = await s.tool("zcode_status", { project_dir: p, task_id: r.sc.task_id });
  check("状态变为 interrupted", !stv.isError && stv.sc.status === "interrupted");
  check("提示包含 zcode_stop", (stv.sc.note || "").includes("zcode_stop"));
  const fu = await s.tool("zcode_followup", { project_dir: p, task_id: r.sc.task_id, prompt: "此时不许续聊" });
  check("interrupted 时拒绝续聊", fu.isError);
  const childWasAlive = alive(childPid);
  console.log(`    （worker 被杀后 child ${childWasAlive ? "存活为孤儿" : "已随 Windows job 自清"}）`);
  const st = await s.tool("zcode_stop", { project_dir: p, task_id: r.sc.task_id });
  check("stop 走孤儿回收分支", !st.isError && st.sc.stop_requested === true && st.sc.recovered_orphan === true);
  await sleep(500);
  check("child 已被回收", !alive(childPid));
  const final = await s.tool("zcode_status", { project_dir: p, task_id: r.sc.task_id });
  check("终态 stopped", final.sc.status === "stopped");
  s.kill();
}

async function scenario_ids_paths() {
  console.log("\n[11] 非法 ID / 越界路径 / 参数互斥 / 状态篡改");
  const s = mkServer();
  await s.init();
  const p = projDir("ids");
  const bad1 = await s.tool("zcode_start", { project_dir: p, task_id: "a/../b", prompt: "x" });
  check("task_id 含路径分隔符被拒", bad1.isError);
  const bad2 = await s.tool("zcode_start", { project_dir: p, task_id: "with space", prompt: "x" });
  check("task_id 含空格被拒", bad2.isError);
  const bad3 = await s.tool("zcode_wait", { project_dir: p, task_id: "bad!id", timeout_ms: 1 });
  check("非法 task_id 查询被拒", bad3.isError);
  const bad4 = await s.tool("zcode_start", { project_dir: "relative/path", prompt: "x" });
  check("相对路径 project_dir 被拒", bad4.isError);
  const bad5 = await s.tool("zcode_start", { project_dir: path.join(TMP, "definitely-missing-xyz"), prompt: "x" });
  check("不存在的 project_dir 被拒", bad5.isError);
  const bad6 = await s.tool("zcode_start", { project_dir: p, prompt: "a", prompt_file: "b.txt" });
  check("prompt 与 prompt_file 同时提供被拒", bad6.isError);
  const bad7 = await s.tool("zcode_start", { project_dir: p });
  check("两者都不提供被拒", bad7.isError);
  const bad8 = await s.tool("zcode_start", { project_dir: p, prompt_file: path.join(TMP, "no-such-brief.md") });
  check("prompt_file 不存在被拒", bad8.isError);
  const bad9 = await s.tool("zcode_start", { project_dir: p, mode: "yolo", prompt: "x" });
  check("yolo 模式被拒", bad9.isError);
  const bad12 = await s.tool("zcode_start", { project_dir: p, prompt_file: "relative/brief.md" });
  check("相对路径 prompt_file 被拒", bad12.isError);
  const bad13 = await s.tool("zcode_start", { project_dir: p, prompt_file: FAKE_CLI });
  check("项目外 prompt_file 被拒（零信任）", bad13.isError && bad13.text.includes("项目"));
  // 状态篡改：把 run_id 改成越界值后查询必须拒绝
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=ok 正常" });
  await waitTerminal(s, p, r.sc.task_id);
  const stFile = ctl(p,"tasks",r.sc.task_id,"state.json");
  const tampered = JSON.parse(fs.readFileSync(stFile, "utf8"));
  tampered.run_id = "../evil";
  tampered.result_path = "C:\\Windows\\system32\\config.json";
  fs.writeFileSync(stFile, JSON.stringify(tampered));
  const bad10 = await s.tool("zcode_status", { project_dir: p, task_id: r.sc.task_id });
  check("篡改 run_id 后 status 标记 corrupted 或拒绝", bad10.isError || bad10.sc.status === "corrupted");
  const bad11 = await s.tool("zcode_result", { project_dir: p, task_id: r.sc.task_id });
  check("篡改后 result 拒绝", bad11.isError);
  s.kill();
}

async function scenario_wait0() {
  console.log("\n[12] wait(0) 立即返回快照");
  const s = mkServer();
  await s.init();
  const p = projDir("wait0");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=delay,ms=15000 慢任务" });
  const t0 = Date.now();
  const w = await s.tool("zcode_wait", { project_dir: p, task_id: r.sc.task_id, timeout_ms: 0 });
  const dt = Date.now() - t0;
  check("立即返回（<2 秒）", dt < 2000);
  check("still_running=true", !w.isError && w.sc.still_running === true);
  await s.tool("zcode_stop", { project_dir: p, task_id: r.sc.task_id });
  await waitTerminal(s, p, r.sc.task_id);
  s.kill();
}

async function scenario_doctor_nobase() {
  console.log("\n[13] 缺 baseURL：doctor 失败、start 快速失败");
  const s = mkServer({ ZCODE_BRIDGE_V2_CONFIG: fakeV2NoBase });
  await s.init();
  const doc = await s.tool("zcode_doctor", {});
  check("doctor ok=false 并给出原因", !doc.isError && doc.sc.ok === false && (doc.sc.checks.credentials_error || "").includes("baseURL"));
  const p = projDir("nobase");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "x" });
  check("start 快速失败且提及 baseURL", r.isError && r.text.includes("baseURL"));
  s.kill();
}

async function scenario_model_preserve() {
  console.log("\n[14] 续聊默认沿用上轮模型 / 显式换模型留痕");
  const s = mkServer();
  await s.init();
  const p = projDir("modelkeep");
  const r = await s.tool("zcode_start", { project_dir: p, model: "GLM-5.3", prompt: "@fake:mode=ok 首轮" });
  const w = await waitTerminal(s, p, r.sc.task_id);
  check("首轮按 GLM-5.3 执行", stateOf(p, r.sc.task_id).model === "GLM-5.3");
  const f = await s.tool("zcode_followup", { project_dir: p, task_id: r.sc.task_id, prompt: "@fake:mode=ok 续聊不指定模型" });
  check("followup 接受", !f.isError);
  await waitTerminal(s, p, r.sc.task_id);
  const st = stateOf(p, r.sc.task_id);
  const req2 = JSON.parse(fs.readFileSync(path.join(p, ".zcode-mcp", "runs", st.run_id, "request.json"), "utf8"));
  check("第二轮模型沿用 GLM-5.3", req2.model === "GLM-5.3" && !req2.model_changed_from);
  const f2 = await s.tool("zcode_followup", { project_dir: p, task_id: r.sc.task_id, prompt: "@fake:mode=ok 显式换模型", model: "GLM-5.3-Flash" });
  check("显式换模型被接受", !f2.isError);
  await waitTerminal(s, p, r.sc.task_id);
  const st2 = stateOf(p, r.sc.task_id);
  const req3 = JSON.parse(fs.readFileSync(path.join(p, ".zcode-mcp", "runs", st2.run_id, "request.json"), "utf8"));
  check("换模型留痕 model_changed_from", req3.model === "GLM-5.3-Flash" && req3.model_changed_from === "GLM-5.3");
  s.kill();
}

async function scenario_env_whitelist() {
  console.log("\n[15] 子进程环境白名单（不透传 MCP 环境变量）");
  const s = mkServer();
  await s.init();
  const p = projDir("envwl");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=envdump 检查环境" });
  const w = await waitTerminal(s, p, r.sc.task_id);
  check("returned", w.status === "returned");
  check("子进程看不到 MCP 注入变量", w.result.response.includes('"hasLeak":false'));
  check("SystemRoot 保留（node 必需）", w.result.response.includes('"systemRoot":true'));
  s.kill();
}

async function scenario_overflow() {
  console.log("\n[16] 输出超上限（流式计数 → 终止 + 明确错误，不撑爆内存）");
  const s = mkServer();
  await s.init();
  const p = projDir("overflow");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=hugeover 巨量倾泻" });
  const w = await waitTerminal(s, p, r.sc.task_id, 90000);
  check("终态 failed", w.status === "failed");
  check("exit_code=125（输出超限）", w.result.exit_code === 125);
  const full = await s.tool("zcode_result", { project_dir: p, task_id: r.sc.task_id });
  check("错误说明明确", full.text.includes("输出超过上限"));
  const rdir = path.join(p, ".zcode-mcp", "runs", r.sc.run_id);
  check("stdout.log 保留已产生部分", fs.existsSync(path.join(rdir, "stdout.log")) && fs.statSync(path.join(rdir, "stdout.log")).size > 1024 * 1024);
  check("raw 临时文件已清理", !fs.existsSync(path.join(rdir, "stdout.raw")));
  s.kill();
}

async function scenario_list_tolerant() {
  console.log("\n[17] 损坏状态不拖垮任务列表");
  const s = mkServer();
  await s.init();
  const p = projDir("listok");
  const a = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=ok 任务A" });
  await waitTerminal(s, p, a.sc.task_id);
  const b = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=ok 任务B" });
  await waitTerminal(s, p, b.sc.task_id);
  fs.writeFileSync(ctl(p,"tasks",b.sc.task_id,"state.json"), "{ 这是非法 JSON", "utf8");
  const list = await s.tool("zcode_status", { project_dir: p });
  check("列表仍可返回", !list.isError && list.sc.tasks.length === 2);
  const bad = list.sc.tasks.find((t) => t.status === "corrupted");
  const good = list.sc.tasks.find((t) => t.status === "returned");
  check("坏任务显示 corrupted", Boolean(bad));
  check("好任务不受影响", Boolean(good));
  s.kill();
}

async function scenario_runtime_location() {
  console.log("\n[18] runtime 出项目（%RUNTIME_ROOT%\\<project-hash>）");
  const s = mkServer();
  await s.init();
  const p = projDir("rtloc");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=ok 检查runtime" });
  await waitTerminal(s, p, r.sc.task_id);
  check("项目内不再有 runtime 目录", !fs.existsSync(path.join(p, ".zcode-mcp", "runtime")));
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(path.resolve(p).toLowerCase()).digest("hex").slice(0, 16);
  const rt = path.join(TMP, "runtimes", hash);
  check("runtime 位于项目外哈希目录", fs.existsSync(rt) && fs.statSync(rt).isDirectory());
  check("命令行不含正文（instruction 只有路径）", (() => {
    const req = JSON.parse(fs.readFileSync(path.join(p, ".zcode-mcp", "runs", r.sc.run_id, "request.json"), "utf8"));
    return req.instruction.length < 300 && !req.instruction.includes("检查runtime");
  })());
  s.kill();
}

async function scenario_worker_reentry() {
  console.log("\n[19] worker 重入不污染终态（guard 让位/结构化失败）");
  const s = mkServer();
  await s.init();
  const p = projDir("reentry");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=ok 正常完成" });
  const w = await waitTerminal(s, p, r.sc.task_id);
  check("首轮 returned", w.status === "returned");
  const { spawnSync } = await import("node:child_process");
  const workerEnv = { ...process.env, ZCODE_BRIDGE_CLI: FAKE_CLI, ZCODE_BRIDGE_V2_CONFIG: fakeV2, ZCODE_BRIDGE_RUNTIME_ROOT:path.join(TMP,"runtimes") };
  const again = spawnSync(process.execPath, [SERVER, "_worker", "--project", p, "--task", r.sc.task_id, "--run-id", r.sc.run_id],
    { encoding: "utf8", timeout: 30000, env: workerEnv });
  check("重入进程退出码 3", again.status === 3);
  const stAfter = stateOf(p, r.sc.task_id);
  check("终态未被污染（仍 returned）", stAfter.status === "returned");
  const reportAfter = resultFileOf(p, r.sc.run_id);
  check("已完成轮次的 result 未被覆盖", reportAfter.status === "returned" && reportAfter.result.response === "fake-ok");
  const wlog = fs.readFileSync(path.join(p, ".zcode-mcp", "runs", r.sc.run_id, "worker.log"), "utf8");
  check("让位原因已记录", wlog.includes("校验失败"));
  s.kill();
}

async function scenario_cli_tamper() {
  console.log("\n[20] request.cli 篡改 → 拒绝执行（严格相等，不接受任意存在文件）");
  const s = mkServer();
  await s.init();
  const p = projDir("clitamper");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=ok 首轮" });
  await waitTerminal(s, p, r.sc.task_id);
  // 手工构造第二轮（queued、无主），篡改 cli 为另一个“存在的文件”
  const { spawnSync } = await import("node:child_process");
  const rid2 = "clitamper-run2";
  const tdir = path.join(p, ".zcode-mcp", "tasks", r.sc.task_id);
  const rdir2 = path.join(p, ".zcode-mcp", "runs", rid2);
  fs.mkdirSync(rdir2, { recursive: true });
  const req = JSON.parse(fs.readFileSync(path.join(p, ".zcode-mcp", "runs", r.sc.run_id, "request.json"), "utf8"));
  req.run_id = rid2;
  req.cli = SERVER; // 一个绝对存在、但不是允许 CLI 的文件
  fs.writeFileSync(path.join(rdir2, "request.json"), JSON.stringify(req, null, 2));
  const st = stateOf(p, r.sc.task_id);
  st.run_id = rid2;
  st.status = "queued";
  st.worker_pid = 0;
  fs.writeFileSync(ctl(p,"tasks",r.sc.task_id,"state.json"), JSON.stringify(st,null,2));
  fs.mkdirSync(path.dirname(ctl(p,"runs",rid2,"request.json")),{recursive:true});
  fs.writeFileSync(ctl(p,"runs",rid2,"request.json"),JSON.stringify(req));
  const re = spawnSync(process.execPath, [SERVER, "_worker", "--project", p, "--task", r.sc.task_id, "--run-id", rid2],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, ZCODE_BRIDGE_CLI: FAKE_CLI, ZCODE_BRIDGE_V2_CONFIG: fakeV2, ZCODE_BRIDGE_RUNTIME_ROOT:path.join(TMP,"runtimes") } });
  check("worker 退出码 3", re.status === 3);
  const reportPath = path.join(rdir2, "result.json");
  check("落了结构化 failed result", fs.existsSync(reportPath));
  if (fs.existsSync(reportPath)) {
    const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    check("失败原因指明 cli 不符", (rep.stderr_tail || "").includes("不符"));
  }
  s.kill();
}

async function scenario_guard_running_dead() {
  console.log("\n[21] guard 遇 running+死 pid → 结构化 failed（不再无 result 退出）");
  const s = mkServer();
  await s.init();
  const p = projDir("guarddead");
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "@fake:mode=ok 首轮" });
  await waitTerminal(s, p, r.sc.task_id);
  // 手工构造 running + 确认已死的 pid
  const { spawnSync } = await import("node:child_process");
  const deadProc = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = deadProc.pid; // 已退出的真实 pid
  const rid2 = "guarddead-run2";
  const tdir = path.join(p, ".zcode-mcp", "tasks", r.sc.task_id);
  const rdir2 = path.join(p, ".zcode-mcp", "runs", rid2);
  fs.mkdirSync(rdir2, { recursive: true });
  const req = JSON.parse(fs.readFileSync(path.join(p, ".zcode-mcp", "runs", r.sc.run_id, "request.json"), "utf8"));
  req.run_id = rid2;
  fs.writeFileSync(path.join(rdir2, "request.json"), JSON.stringify(req, null, 2));
  const st = stateOf(p, r.sc.task_id);
  st.run_id = rid2;
  st.status = "running";
  st.worker_pid = deadPid;
  fs.writeFileSync(ctl(p,"tasks",r.sc.task_id,"state.json"), JSON.stringify(st,null,2));
  fs.mkdirSync(path.dirname(ctl(p,"runs",rid2,"request.json")),{recursive:true});
  fs.writeFileSync(ctl(p,"runs",rid2,"request.json"),JSON.stringify(req));
  const re = spawnSync(process.execPath, [SERVER, "_worker", "--project", p, "--task", r.sc.task_id, "--run-id", rid2],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, ZCODE_BRIDGE_CLI: FAKE_CLI, ZCODE_BRIDGE_V2_CONFIG: fakeV2, ZCODE_BRIDGE_RUNTIME_ROOT:path.join(TMP,"runtimes") } });
  check("worker 退出码 3", re.status === 3);
  const reportPath = path.join(rdir2, "result.json");
  check("running+死pid 也落了 failed result", fs.existsSync(reportPath) &&
    JSON.parse(fs.readFileSync(reportPath, "utf8")).status === "failed");
  s.kill();
}

async function scenario_junction_escape() {
  console.log("\n[22] junction 穿越（.zcode-mcp 指向项目外）→ 拒绝且不写任何东西");
  const s = mkServer();
  await s.init();
  const p = projDir("junction");
  const evil = path.join(TMP, "junction-evil");
  fs.mkdirSync(evil, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const link = path.join(p, ".zcode-mcp");
  const mk = spawnSync("cmd", ["/c", "mklink", "/J", link, evil], { encoding: "utf8" });
  if (mk.status !== 0) {
    check("junction 创建（环境支持）", false, "mklink 失败：" + (mk.stderr || mk.stdout || ""));
    s.kill();
    return;
  }
  const r = await s.tool("zcode_start", { project_dir: p, prompt: "试图穿越" });
  check("start 被拒绝", r.isError && r.text.includes("越界"));
  check("evil 目录内未被写入任何内容", fs.readdirSync(evil).length === 0);
  // 清理：删除 junction 链接本身（不删目标）
  fs.rmdirSync(link);
  fs.rmSync(evil, { recursive: true, force: true });
  s.kill();
}


async function scenario_authority() {
 console.log("\n[23] 项目镜像篡改不改变实际参数/任务正文");
 const s=mkServer();await s.init();const p=projDir("authority");
 const first=await s.tool("zcode_start",{project_dir:p,prompt:"@fake:mode=ok"});await waitTerminal(s,p,first.sc.task_id);
 const tid=first.sc.task_id,rid="manual-authority";
 const source=JSON.parse(fs.readFileSync(ctl(p,"runs",first.sc.run_id,"request.json")));
 const req={...source,run_id:rid,resume_session:"sess_fake_ok",mode:"plan",model:"GLM-5.3",timeout_sec:3};
 const rd=path.join(p,".zcode-mcp","runs",rid);fs.mkdirSync(rd,{recursive:true});
 fs.mkdirSync(path.dirname(ctl(p,"runs",rid,"request.json")),{recursive:true});
 fs.writeFileSync(ctl(p,"runs",rid,"request.json"),JSON.stringify(req));
 fs.writeFileSync(ctl(p,"runs",rid,"followup.md"),"@fake:mode=inspect");
 fs.writeFileSync(path.join(rd,"request.json"),JSON.stringify({...req,instruction:"EVIL",cli:SERVER,model:"evil",mode:"yolo",timeout_sec:99,resume_session:"evil",project_dir:TMP}));
 fs.writeFileSync(path.join(p,".zcode-mcp","tasks",tid,"brief.md"),"@fake:mode=fail");
 const worker=spawn(process.execPath,[SERVER,"_worker","--project",p,"--task",tid,"--run-id",rid],{env:{...process.env,ZCODE_BRIDGE_CLI:FAKE_CLI,ZCODE_BRIDGE_V2_CONFIG:fakeV2,ZCODE_BRIDGE_RUNTIME_ROOT:path.join(TMP,"runtimes")},stdio:"ignore"});
 fs.writeFileSync(ctl(p,"tasks",tid,"state.json"),JSON.stringify({...stateOf(p,tid),run_id:rid,status:"queued",worker_pid:worker.pid}));
 await new Promise(r=>worker.on("exit",r));
 const report=resultFileOf(p,rid),v=JSON.parse(report.result.response);
 check("实际 instruction 不含镜像注入",!v.instruction.includes("EVIL")&&v.instruction.includes("control"));
 check("model/mode/session 使用权威值",v.model.endsWith("GLM-5.3")&&v.mode==="plan"&&v.resume==="sess_fake_ok");
 check("实际 cwd 使用派发项目",v.cwd===p);
 check("权威数据无 API Key",!fs.readFileSync(ctl(p,"runs",rid,"request.json"),"utf8").includes(FAKE_SECRET));
 const timeoutRid="authority-timeout",tf=ctl(p,"runs",timeoutRid,"request.json");
 fs.mkdirSync(path.dirname(tf),{recursive:true});fs.writeFileSync(tf,JSON.stringify({...req,run_id:timeoutRid,timeout_sec:1}));
 fs.writeFileSync(ctl(p,"runs",timeoutRid,"followup.md"),"@fake:mode=delay,ms=5000");
 const trd=path.join(p,".zcode-mcp","runs",timeoutRid);fs.mkdirSync(trd,{recursive:true});fs.writeFileSync(path.join(trd,"request.json"),JSON.stringify({...req,timeout_sec:99}));
 const tw=spawn(process.execPath,[SERVER,"_worker","--project",p,"--task",tid,"--run-id",timeoutRid],{env:{...process.env,ZCODE_BRIDGE_CLI:FAKE_CLI,ZCODE_BRIDGE_V2_CONFIG:fakeV2,ZCODE_BRIDGE_RUNTIME_ROOT:path.join(TMP,"runtimes")},stdio:"ignore"});
 fs.writeFileSync(ctl(p,"tasks",tid,"state.json"),JSON.stringify({...stateOf(p,tid),run_id:timeoutRid,status:"queued",worker_pid:tw.pid}));await new Promise(r=>tw.on("exit",r));
 check("镜像 timeout 不改变实际超时",resultFileOf(p,timeoutRid).status==="timed_out");
 for(const kind of ["missing","corrupt","mismatch"]) {
  const bad="guard-"+kind;const f=ctl(p,"runs",bad,"request.json");fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify({...req,run_id:bad}));
  const st=ctl(p,"tasks",tid,"state.json");
  if(kind==="missing")fs.rmSync(st);else fs.writeFileSync(st,kind==="corrupt"?"{broken":JSON.stringify({run_id:rid,status:"returned",worker_pid:process.pid}));
  const before=fs.readFileSync(path.join(rd,"result.json"),"utf8");
  const w=spawn(process.execPath,[SERVER,"_worker","--project",p,"--task",tid,"--run-id",bad],{env:{...process.env,ZCODE_BRIDGE_CLI:FAKE_CLI,ZCODE_BRIDGE_V2_CONFIG:fakeV2,ZCODE_BRIDGE_RUNTIME_ROOT:path.join(TMP,"runtimes")},stdio:"ignore"});await new Promise(r=>w.on("exit",r));
  check(kind+" guard 结构化结果",resultFileOf(p,bad).status==="failed");
  check(kind+" 不覆盖其他 run",fs.readFileSync(path.join(rd,"result.json"),"utf8")===before);
 }
 s.kill();
}
async function scenario_status_junction() {
 console.log("\n[24] status 两层 Junction 拒绝且不泄露");const s=mkServer();await s.init();
 for(const segment of [".zcode-mcp","tasks"]) {
  const p=projDir("status-link-"+segment),evil=projDir("evil-"+segment);
  fs.mkdirSync(path.join(evil,"spoof"),{recursive:true});fs.writeFileSync(path.join(evil,"spoof","state.json"),JSON.stringify({task_id:"SECRET-OUTSIDE"}));
  const link=segment==="tasks"?path.join(p,".zcode-mcp","tasks"):path.join(p,".zcode-mcp");fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(evil,link,"junction");
  const r=await s.tool("zcode_status",{project_dir:p});check(segment+" 拒绝",r.isError&&r.text.includes("越界"));check(segment+" 不泄露",!r.text.includes("SECRET-OUTSIDE"));fs.rmdirSync(link);
 }s.kill();
}

// ---------------------------------------------------------------- 执行

const scenarios = [
  scenario_handshake, scenario_normal, scenario_delay_stop, scenario_timeout,
  scenario_spawnfail, scenario_nonjson, scenario_huge, scenario_secret,
  scenario_mismatch, scenario_orphan, scenario_ids_paths, scenario_wait0,
  scenario_doctor_nobase, scenario_model_preserve, scenario_env_whitelist,
  scenario_overflow, scenario_list_tolerant, scenario_runtime_location,
  scenario_worker_reentry, scenario_cli_tamper, scenario_guard_running_dead,
  scenario_junction_escape, scenario_authority, scenario_status_junction,
];

try {
  for (const sc of scenarios) await sc();
  const {auditScenarios}=await import("./audit_tests.mjs"); await auditScenarios({check,mkServer,projDir,TMP,SERVER,AUDIT_META});
} catch (e) {
  failed++;
  failures.push("场景异常中断: " + e.message);
  console.error("场景异常中断：", e);
}

console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`);
if (failures.length) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
