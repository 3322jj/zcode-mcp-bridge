#!/usr/bin/env node
/**
 * zcode-bridge: stdio MCP + bounded background worker.
 * v1.3.1: execution state/request/brief snapshots are outside the project.
 * Project files are evidence mirrors, not execution authority.
 * This is not an OS security boundary against same-user processes.
 */
import * as audit from "./audit.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const VERSION = "1.4.1";
const SELF = fileURLToPath(import.meta.url);
const NODE_EXE = process.execPath;
const PROVIDER = "builtin:bigmodel-coding-plan";
const DEFAULT_MODEL = "GLM-5.3-Flash";
const DEFAULT_CLI = process.env.ZCODE_BRIDGE_CLI || path.join(process.env.ProgramFiles || "C:\\Program Files", "ZCode", "resources", "glm", "zcode.cjs");
const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 3600;
const MIN_TIMEOUT_SEC = Number(process.env.ZCODE_BRIDGE_MIN_TIMEOUT_SEC) || 60;
const MAX_WAIT_MS = 60000;
const ACTIVE = new Set(["queued", "running", "stop_requested"]);
const TERMINAL = new Set(["returned", "failed", "stopped", "timed_out"]);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MODES = new Set(["edit", "plan"]);
const WORKER_START_GRACE_MS = 15000;
const RESPONSE_CAP = 100000;
const STDOUT_LIMIT = 20 * 1024 * 1024;
const STDERR_LIMIT = 2 * 1024 * 1024;
const ENV_WHITELIST = [
  "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "PATH", "windir", "OS",
  "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
  "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "NO_COLOR", "LANG", "TZ",
];
const INSTRUCTION_SUFFIX =
  "不要重复尝试需要审批的工具；需要执行终端命令时返回命令和目的，由 Codex 接手。" +
  "最后简要列出完成情况、改动文件、验证结果和阻塞问题。";

// ---------------------------------------------------------------- 基础工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function newId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0];
  return `${stamp}Z-${randomUUID().slice(0, 8)}`;
}

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    for (let i = 0; i < 10; i++) {
      try { fs.renameSync(tmp, file); return; } catch { /* 重试 */ }
      syncSleep(50);
    }
    fs.rmSync(tmp, { force: true });
    throw new Error(`无法写入状态文件 ${file}`);
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function redact(text, secret) {
  return secret ? String(text).split(secret).join("[REDACTED]") : String(text);
}

function deepRedact(value, secret) {
  if (!secret) return value;
  return JSON.parse(JSON.stringify(value).split(secret).join("[REDACTED]"));
}

function killTree(pid) {
  if (!alive(pid)) return;
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000 });
  } catch { /* 进程可能已退出 */ }
}

// ---------------------------------------------------------------- 路径与凭据

function resolveProject(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error("project_dir 必须是绝对路径");
  }
  const p = path.resolve(dir);
  let st;
  try { st = fs.statSync(p); }
  catch { throw new Error(`项目目录不存在：${p}`); }
  if (!st.isDirectory()) throw new Error(`project_dir 不是目录：${p}`);
  return p;
}

function storeRoot(project) { return path.join(project, ".zcode-mcp"); }

// ZCode CLI 的 runtime（会话库/缓存）出项目：按项目路径哈希分目录（v1.2）
function runtimeRoot(project) {
  const base = process.env.ZCODE_BRIDGE_RUNTIME_ROOT
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
                 "zcode-mcp-bridge");
  const hash = createHash("sha256").update(path.resolve(project).toLowerCase()).digest("hex").slice(0, 16);
  const legacy = path.join(base, hash);
  if (process.env.ZCODE_BRIDGE_RUNTIME_ROOT) return legacy;
  const preferred = path.join(audit.baseRoot(), hash);
  // 新项目使用已配置、支持原子写入的主机根；已有会话保持原目录。
  if (fs.existsSync(path.join(preferred, "sessions.sqlite"))) return preferred;
  if (fs.existsSync(path.join(legacy, "sessions.sqlite"))) return legacy;
  return preferred;
}

// 解析 dir 的真实绝对路径：沿最近存在的祖先做 realpath，再拼回不存在的尾巴。
// 这样"目标尚未创建"时也能发现父目录被 junction 指向项目外的穿越。
function realTarget(dir) {
  let cur = path.resolve(dir);
  const tail = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const real = fs.realpathSync(cur);
  return tail.length ? path.join(real, ...tail) : real;
}

// target 的真实位置必须仍在 root（root 本身必须存在）之内
function withinReal(root, target) {
  const r = fs.realpathSync(root);
  const t = realTarget(target);
  return t === r || t.startsWith(r + path.sep);
}

function taskDir(project, taskId) {
  if (!ID_RE.test(taskId || "")) {
    throw new Error("无效任务 ID（只允许字母、数字、连字符、下划线，长度 ≤80）");
  }
  const dir = path.join(storeRoot(project), "tasks", taskId);
  if (!withinReal(project, dir)) throw new Error("任务目录越界（含 junction 穿越），已拒绝");
  return dir;
}

function runDir(project, runId) {
  if (!ID_RE.test(runId || "")) {
    throw new Error("无效 run ID（只允许字母、数字、连字符、下划线，长度 ≤80）");
  }
  const dir = path.join(storeRoot(project), "runs", runId);
  if (!withinReal(project, dir)) throw new Error("运行目录越界（含 junction 穿越），已拒绝");
  return dir;
}


function controlPath(project, kind, id, file) {
  if (!ID_RE.test(id || "")) throw new Error("无效控制 ID");
  const runtime = runtimeRoot(project);
  const root = path.join(audit.baseRoot(), "control", path.basename(runtime));
  const target = path.join(root, kind, id, file);
  if (withinReal(project, root)) throw new Error("权威控制区必须位于项目外");
  if (realTarget(target) !== path.join(realTarget(root), kind, id, file)) throw new Error("控制路径链接越界");
  return target;
}
function controlState(project, id) { return controlPath(project, "tasks", id, "state.json"); }
function writeState(project, id, state) {
  const file = controlState(project, id);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  writeJsonAtomic(file, state);
  try { writeJsonAtomic(path.join(taskDir(project,id), "state.json"), state); } catch { /* 镜像非权威 */ }
}
function executionState(project, id) { return readJson(controlState(project,id)); }

function resultPathOf(project, runId) {
  return path.join(runDir(project, runId), "result.json");
}

// prompt_file 必须绝对路径、存在、realpath 后位于项目内（v1.2 收口）
function resolvePromptFile(project, file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw new Error("prompt_file 必须是绝对路径且位于项目目录内");
  }
  let real;
  try { real = fs.realpathSync(file); }
  catch { throw new Error(`无法读取 prompt_file：${file}`); }
  if (!withinReal(project, real)) {
    throw new Error("prompt_file 必须位于项目目录内（越界已拒绝）");
  }
  const text = fs.readFileSync(real, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("prompt_file 内容为空");
  return text;
}

function readState(dir) {
  try {
    const project = path.dirname(path.dirname(path.dirname(dir)));
    const id = path.basename(dir);
    const authority = controlState(project,id);
    // 老任务只读兼容；已存在控制任务目录时不能回退到镜像。
    return readJson(fs.existsSync(path.dirname(authority)) ? authority : path.join(dir,"state.json"));
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("任务不存在；先用 zcode_status 查看本项目任务");
    throw e;
  }
}

function credentials(model) {
  const cfgPath = process.env.ZCODE_BRIDGE_V2_CONFIG
    || path.join(os.homedir(), ".zcode", "v2", "config.json");
  let cfg;
  try { cfg = readJson(cfgPath); }
  catch { throw new Error(`无法读取桌面版配置 ${cfgPath}；请确认 ZCode 桌面版已登录`); }
  const provider = (cfg.provider || {})[PROVIDER];
  if (!provider || provider.enabled === false) {
    throw new Error("BigModel Coding Plan 未启用；请先在 ZCode 桌面版登录并启用");
  }
  const opts = provider.options || {};
  const apiKey = typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";
  if (!apiKey) throw new Error("桌面版 Coding Plan 未配置密钥");
  const baseURL = typeof opts.baseURL === "string" ? opts.baseURL.trim() : "";
  if (!baseURL) throw new Error("桌面版配置缺少 baseURL");
  const models = provider.models || {};
  const target = model || DEFAULT_MODEL;
  if (!(target in models)) {
    throw new Error(`模型 ${target} 不在 Coding Plan 配置中；可用：${Object.keys(models).join(", ")}`);
  }
  return { apiKey, baseURL, model: target };
}

// v1.2：正文全部走文件，命令行只传固定短句 + 路径
function buildInstruction(briefPath, isFollowup, followupPath) {
  return isFollowup
    ? `继续当前会话。原任务文件：${briefPath}。本次补充在文件：${followupPath} 中，请先读取该文件再执行。\n${INSTRUCTION_SUFFIX}`
    : `请读取任务文件 ${briefPath}，按其中的目标、范围和验收要求执行。\n${INSTRUCTION_SUFFIX}`;
}

function stateView(state) {
  const view = { ...state };
  if (view.run_id !== undefined && view.run_id !== null && !ID_RE.test(String(view.run_id))) {
    view.status = "corrupted";
    view.note = "状态文件损坏（run_id 非法）；不要续聊或重发，请人工检查 .zcode-mcp 数据。";
    return view;
  }
  if (ACTIVE.has(state.status)) {
    const workerLive = Number.isInteger(state.worker_pid) && state.worker_pid > 0;
    if (workerLive && !alive(state.worker_pid)) {
      const childLive = Number.isInteger(state.child_pid) && alive(state.child_pid);
      view.status = "interrupted";
      view.note = childLive
        ? "后台 worker 已退出，但 ZCode 子进程仍在运行；先用 zcode_stop 回收孤儿进程，再检查日志，不要续聊。"
        : "后台进程已退出；先用 zcode_stop 收尾并查看 run_dir 日志，不要盲目重发。";
    } else if (!workerLive && Date.now() - (state.started_epoch || 0) > WORKER_START_GRACE_MS) {
      view.status = "interrupted";
      view.note = "worker 未能在宽限期内启动；请用 zcode_doctor 检查环境后重试，或 zcode_stop 收尾。";
    }
  }
  view.elapsed_seconds = ACTIVE.has(view.status)
    ? Math.round((Date.now() - (state.started_epoch || Date.now())) / 100) / 10
    : (state.elapsed_seconds ?? null);
  return view;
}

function summarizeResult(project, view) {
  if (!view.run_id) return null;
  const file = resultPathOf(project, view.run_id);
  if (!fs.existsSync(file)) return null;
  try {
    const report = readJson(file);
    const r = report.result || {};
    return {
      response: typeof r.response === "string" ? r.response.slice(0, 6000) : r.response,
      session_id: r.sessionId || null,
      usage: r.usage || null,
      exit_code: report.exit_code,
      process_ok: report.process_ok,
      task_verified: report.task_verified,
    };
  } catch { return null; }
}

// 结构化收尾 helper：写 result.json + 终态（仅当 state 仍指向本轮 run 时才改状态）。
// onlyIfActive=true 时：state 非本轮或非活动态则完全不写（防止覆盖已完成轮次的结果），
// 仅记录日志——request 校验失败路径使用。
function writeTerminalResult(project, taskId, runId, { status, exitCode, message, extra = {}, onlyIfActive = false }) {
  const rdir = runDir(project, runId);
  fs.mkdirSync(rdir, { recursive: true });
  const resultFile = resultPathOf(project, runId);
  // 重入已有结果时保留原结果；独立记录 guard 失败证据。
  const report = {
    task_id: taskId, run_id: runId, status,
    process_ok: exitCode === 0, exit_code: exitCode, task_verified:false,
    project_dir:project, run_dir:rdir, resumed_session:null,
    result:{response:""}, stderr_tail:message, ...extra,
  };
  writeJsonAtomic(fs.existsSync(resultFile) ? path.join(rdir, "guard-failure-" + randomUUID() + ".json") : resultFile, report);
  try {
    const st=executionState(project,taskId);
    if(st.run_id===runId && ACTIVE.has(st.status)) {
      Object.assign(st,{status,updated_at:nowIso(),worker_pid:null,child_pid:null});
      writeState(project,taskId,st);
    }
  } catch { /* 当前 run 的结果不依赖 task state 可写 */ }
  try { fs.appendFileSync(path.join(rdir,"worker.log"),message+"\n"); } catch {}
  audit.terminal(project,taskId,runId,status,[resultFile,path.join(rdir,"worker.log")]);
}

// ---------------------------------------------------------------- 派发任务

function gitIgnoreHint(project) {
  try {
    if (!fs.existsSync(path.join(project, ".git"))) return "";
    const candidates = [path.join(project, ".gitignore"), path.join(project, ".git", "info", "exclude")];
    const covered = candidates.some((f) => {
      try { return (fs.readFileSync(f, "utf8") || "").includes(".zcode-mcp"); } catch { return false; }
    });
    return covered ? "" : "；建议把 .zcode-mcp/ 加入 .git/info/exclude，避免任务数据进入版本库";
  } catch { return ""; }
}

function startTask(a, isFollowup) {
  const project = resolveProject(a.project_dir);
  let phase=1;
  if(!isFollowup) audit.validateMetadata(a.audit);
  else phase=audit.preflight(project,a.task_id,a.followup_kind||"repair",a.override_authorization);

  const hasPrompt = typeof a.prompt === "string" && a.prompt.trim().length > 0;
  const hasFile = typeof a.prompt_file === "string" && a.prompt_file.trim().length > 0;
  if (hasPrompt === hasFile) {
    throw new Error("prompt 与 prompt_file 必须且只能提供一个（非空）");
  }
  const text = hasFile ? resolvePromptFile(project, a.prompt_file) : a.prompt;

  const store = storeRoot(project);
  // v1.3：junction 校验前移——在任何 mkdir 之前先验证三层路径的真实位置，
  // 否则 mkdir 会顺着恶意 junction 在项目外创建目录
  for (const seg of [store, path.join(store, "tasks"), path.join(store, "runs")]) {
    if (!withinReal(project, seg)) {
      throw new Error("数据目录越界（含 junction 穿越），已拒绝；请人工检查 .zcode-mcp 是否为指向项目外的链接。");
    }
  }
  fs.mkdirSync(path.join(store, "runs"), { recursive: true });
  fs.mkdirSync(path.join(store, "tasks"), { recursive: true });

  const taskId = a.task_id === undefined || a.task_id === null || a.task_id === ""
    ? newId()
    : a.task_id;
  if (!ID_RE.test(taskId)) {
    throw new Error("无效任务 ID（只允许字母、数字、连字符、下划线，长度 ≤80）");
  }
  const dir = taskDir(project, taskId);
  let prevState = null;
  if (isFollowup) {
    prevState = executionState(project, taskId);
    const prevView = stateView(prevState);
    if (!TERMINAL.has(prevView.status)) {
      throw new Error(`该任务当前状态为 ${prevView.status}，未到可续聊的终态；` +
        (prevView.status === "interrupted" ? "interrupted 任务请先 zcode_stop 回收或人工处理。" : "请先 zcode_wait 或 zcode_stop。"));
    }
    if (!prevState.session_id || typeof prevState.session_id !== "string") {
      throw new Error("任务没有可恢复的 sessionId；请检查上一轮失败原因");
    }
  } else if (fs.existsSync(dir)) {
    const prev = readState(dir);
    if (!TERMINAL.has(stateView(prev).status)) throw new Error("任务 ID 已存在且仍在执行");
    throw new Error("任务 ID 已存在；请换一个 ID，或用 zcode_followup 续聊");
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  let model;
  let modelChangedFrom;
  if (isFollowup) {
    model = typeof a.model === "string" && a.model.trim() ? a.model.trim() : (prevState.model || DEFAULT_MODEL);
    if (prevState.model && model !== prevState.model) modelChangedFrom = prevState.model;
  } else {
    model = typeof a.model === "string" && a.model.trim() ? a.model.trim() : DEFAULT_MODEL;
  }
  const creds = credentials(model);

  let cliStat = null;
  try { cliStat = fs.statSync(DEFAULT_CLI); } catch { /* 不存在 */ }
  if (!cliStat || !cliStat.isFile()) {
    throw new Error(`ZCode CLI 文件不存在：${DEFAULT_CLI}；可用环境变量 ZCODE_BRIDGE_CLI 指定正确路径`);
  }

  const mode = a.mode || (isFollowup ? prevState.mode : null) || "edit";
  if (!MODES.has(mode)) {
    throw new Error(`模式只允许 edit 或 plan（收到 ${a.mode}；yolo/build 已在代码层拒绝）`);
  }
  const timeoutSec = Math.min(Math.max(Number(a.timeout_seconds) || DEFAULT_TIMEOUT_SEC, MIN_TIMEOUT_SEC), MAX_TIMEOUT_SEC);

  const safeText = redact(text, creds.apiKey);
  const briefPath = path.join(dir, "brief.md");
  if (!isFollowup) fs.writeFileSync(briefPath, safeText + "\n", "utf8");

  const rid = newId();
  const rdir = runDir(project, rid);
  fs.mkdirSync(rdir, { recursive: true });
  // v1.2：续聊补充写入本轮 followup.md，命令行不携带正文
  let followupPath = null;
  let instruction;
  if (isFollowup) {
    followupPath = path.join(rdir, "followup.md");
    fs.writeFileSync(followupPath, safeText + "\n", "utf8");
    instruction = buildInstruction(briefPath, true, followupPath);
  } else {
    instruction = buildInstruction(briefPath, false, null);
  }
  const request = {
    task_id: taskId, run_id: rid, project_dir: project,
    instruction, brief_path: briefPath,
    ...(followupPath ? { followup_path: followupPath } : {}),
    model, mode, cli: DEFAULT_CLI,
    timeout_sec: timeoutSec, resume_session: isFollowup ? prevState.session_id : null,
    ...(modelChangedFrom ? { model_changed_from: modelChangedFrom } : {}),
    created_at: nowIso(), phase, followup_kind:isFollowup?(a.followup_kind||"repair"):"initial",
    ...(a.override_authorization?{override_authorization:redact(a.override_authorization,creds.apiKey)}:{}),
  };
  const authorityRequest = controlPath(project,"runs",rid,"request.json");
  fs.mkdirSync(path.dirname(authorityRequest),{recursive:true});
  const authorityBrief = controlPath(project,"tasks",taskId,"brief.md");
  fs.mkdirSync(path.dirname(authorityBrief),{recursive:true});
  if(!isFollowup) fs.writeFileSync(authorityBrief,safeText+"\n");
  if(isFollowup) fs.writeFileSync(controlPath(project,"runs",rid,"followup.md"),safeText+"\n");
  writeJsonAtomic(authorityRequest,request);
  writeJsonAtomic(path.join(rdir, "request.json"), request);

  const state = {
    task_id: taskId, run_id: rid, status: "queued", project_dir: project,
    brief_path: briefPath, run_dir: rdir, session_id: request.resume_session,
    model, mode, timeout_sec: timeoutSec,
    created_at: nowIso(), updated_at: nowIso(), started_epoch: Date.now(),
    worker_pid: 0, child_pid: null,
  };
  const stateFile = controlState(project, taskId);
  audit.begin(project,taskId,request,deepRedact(a.audit||null,creds.apiKey),safeText);
  writeState(project, taskId, state);
  let worker;
  try {
    worker = spawn(NODE_EXE, [SELF, "_worker", "--project", project, "--task", taskId, "--run-id", rid],
      { detached: true, stdio: "ignore", windowsHide: true });
  } catch (e) {
    writeTerminalResult(project, taskId, rid, { status: "failed", exitCode: 1, message: `worker 启动失败：${e.message}` });
    throw new Error(`worker 启动失败：${e.message}`);
  }
  worker.on("error", (e) => writeTerminalResult(project, taskId, rid, { status: "failed", exitCode: 1, message: `worker 启动失败：${e.message}` }));
  worker.unref();
  state.worker_pid = worker.pid;
  writeState(project, taskId, state);

  return {
    task_id: taskId, run_id: rid, status: "queued",
    mode, model, ...(modelChangedFrom ? { model_changed_from: modelChangedFrom } : {}),
    timeout_sec: timeoutSec, session_resumed: Boolean(request.resume_session),
    hint: "已提交后台执行（不代表完成）。用 zcode_wait 等待（单次 ≤60 秒，timeout_ms=0 立即返回快照），结束后验收文件产物" + gitIgnoreHint(project) + "。",
  };
}

async function waitTask(a) {
  const project = resolveProject(a.project_dir);
  const dir = taskDir(project, a.task_id);
  let view = stateView(readState(dir));
  const timeoutMs = a.timeout_ms === undefined
    ? 30000
    : Math.min(Math.max(Number(a.timeout_ms) || 0, 0), MAX_WAIT_MS);
  const deadline = Date.now() + timeoutMs;
  while (ACTIVE.has(view.status) && Date.now() < deadline) {
    await sleep(400);
    view = stateView(readState(dir));
  }
  const { started_epoch, worker_pid, child_pid, ...out } = view;
  if (!ACTIVE.has(view.status)) {
    return { still_running: false, ...out, result: summarizeResult(project, view) };
  }
  return { still_running: true, ...out, hint: "仍在执行；可再次 zcode_wait，或先做其他事稍后回来。" };
}

function statusTask(a) {
  const project = resolveProject(a.project_dir);
  if (!a.task_id) {
    const tasksDir = path.join(storeRoot(project), "tasks");
    for(const p of [storeRoot(project),tasksDir]) if(!withinReal(project,p)) throw new Error("数据目录越界（junction），拒绝读取");
    let entries = [];
    try {
      entries = fs.readdirSync(tasksDir)
        .filter((name) => ID_RE.test(name) && withinReal(project,path.join(tasksDir,name,"state.json")))
        .map((name) => ({ name, file: path.join(tasksDir, name, "state.json") }))
        .filter((e) => fs.existsSync(e.file))
        .sort((x, y) => fs.statSync(y.file).mtimeMs - fs.statSync(x.file).mtimeMs)
        .slice(0, 10);
    } catch { /* 目录还没有任务 */ }
    // v1.2：逐项容错——单个损坏状态只显示 corrupted，不拖垮整个列表
    const tasks = entries.map((e) => {
      try {
        const v = stateView(readState(path.dirname(e.file)));
        return { task_id: v.task_id, status: v.status, mode: v.mode, model: v.model,
                 elapsed_seconds: v.elapsed_seconds, session_id: v.session_id || null, updated_at: v.updated_at };
      } catch {
        return { task_id: e.name, status: "corrupted", note: "state.json 无法解析；不影响其他任务。" };
      }
    });
    return { project_dir: project, tasks };
  }
  const view = stateView(readState(taskDir(project, a.task_id)));
  const { started_epoch, worker_pid, child_pid, ...out } = view;
  return out;
}

function resultTask(a) {
  const project = resolveProject(a.project_dir);
  const view = stateView(readState(taskDir(project, a.task_id)));
  const file = view.run_id ? resultPathOf(project, view.run_id) : null;
  if (!file || !fs.existsSync(file)) {
    const { started_epoch, worker_pid, child_pid, ...out } = view;
    return { ...out, note: "本轮尚无结果文件（可能仍在执行或从未返回）。" };
  }
  try { return readJson(file); }
  catch (e) { throw new Error(`读取结果失败：${e.message}`); }
}

function stopTask(a) {
  const project = resolveProject(a.project_dir);
  const raw = executionState(project, a.task_id);
  const view = stateView(raw);
  if (!ACTIVE.has(raw.status)) {
    return { task_id: a.task_id, already_finished: true, status: view.status };
  }
  const rdir = runDir(project, raw.run_id);
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, "stop.request"), nowIso() + "\n", "utf8");

  // v1.2：worker 已死，或 pid 未落但已过宽限期（启动即中断）→ 直接终态收尾并补 result
  const workerDead = Number.isInteger(raw.worker_pid) && raw.worker_pid > 0 && !alive(raw.worker_pid);
  const startExpired = (!Number.isInteger(raw.worker_pid) || raw.worker_pid <= 0)
    && Date.now() - (raw.started_epoch || 0) > WORKER_START_GRACE_MS;
  if (workerDead || startExpired) {
    if (Number.isInteger(raw.child_pid) && alive(raw.child_pid)) killTree(raw.child_pid);
    writeTerminalResult(project, a.task_id, raw.run_id, {
      status: "stopped", exitCode: 130,
      message: "worker 已退出或未能在宽限期启动；由 zcode_stop 收尾，孤儿子进程已回收，已写出的文件不回滚。",
    });
    return { task_id: a.task_id, stop_requested: true, recovered_orphan: true,
             hint: "已回收并将任务置为 stopped（含结构化结果）。" };
  }

  try {
    const stateFile = controlState(project, a.task_id);
    const st = readJson(stateFile);
    if (st.run_id === raw.run_id && ACTIVE.has(st.status)) {
      st.status = "stop_requested";
      st.updated_at = nowIso();
      writeState(project, a.task_id, st);
    }
  } catch { /* 并发写入冲突时以 worker 的终态为准 */ }
  return { task_id: a.task_id, stop_requested: true, status: "stop_requested",
           hint: "已请求停止；几秒后用 zcode_wait / zcode_status 确认变为 stopped。已写出的文件不会被回滚。" };
}

function doctor() {
  const out = { node: NODE_EXE, node_version: process.version, cli: DEFAULT_CLI, ok: true, checks: {} };
  let st = null;
  try { st = fs.statSync(DEFAULT_CLI); } catch { /* 不存在 */ }
  out.checks.cli_is_file = Boolean(st && st.isFile());
  try {
    const creds = credentials(DEFAULT_MODEL);
    out.checks.v2_config_readable = true;
    out.checks.provider_enabled = true;
    out.checks.api_key_present = true;
    out.checks.base_url_present = true;
    const cfgPath = process.env.ZCODE_BRIDGE_V2_CONFIG
      || path.join(os.homedir(), ".zcode", "v2", "config.json");
    out.checks.available_models = Object.keys(readJson(cfgPath).provider[PROVIDER].models || {});
  } catch (e) {
    out.checks.credentials_error = e.message;
  }
  out.ok = out.checks.cli_is_file && !out.checks.credentials_error;
  if (!out.ok) out.hint = "有检查项未通过：按 credentials_error / cli_is_file 修复后再派发；本检查不发起模型请求。";
  return out;
}

// ---------------------------------------------------------------- 后台 worker

async function runWorker(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const project = resolveProject(get("--project"));
  const taskId = get("--task");
  const rid = get("--run-id");
  const dir = taskDir(project, taskId);
  const rdir = runDir(project, rid);
  const log = (line) => { try { fs.appendFileSync(path.join(rdir, "worker.log"), line + "\n", "utf8"); } catch { /* 尽力而为 */ } };
  const stateFile = controlState(project, taskId);
  const stopFile = path.join(rdir, "stop.request");
  const bail = (message) => {
    log(message);
    process.exit(3);
  };

  // ---- v1.3：request 自验（被篡改的 request——尤其 cli——拒绝执行）。
  // 校验失败只在任务仍处活动态时落盘，避免覆盖已完成轮次的结果。
  const VR = { onlyIfActive: true };
  let request;
  try {
    request = readJson(controlPath(project,"runs",rid,"request.json"));
  } catch (e) {
    writeTerminalResult(project, taskId, rid, { ...VR, status: "failed", exitCode: 1, message: `request.json 无法读取：${e.message}` });
    bail("request.json 无法读取，已落 failed。");
  }
  if (request.task_id !== taskId || request.run_id !== rid ||
      path.resolve(String(request.project_dir)) !== project) {
    writeTerminalResult(project, taskId, rid, { ...VR, status: "failed", exitCode: 1, message: "request 与启动参数不一致，拒绝执行（疑似数据被篡改）。" });
    bail("request 与启动参数不一致，已落 failed。");
  }
  if (!MODES.has(request.mode)) {
    writeTerminalResult(project, taskId, rid, { ...VR, status: "failed", exitCode: 1, message: `request.mode 非法（${request.mode}），拒绝执行。` });
    bail("request.mode 非法，已落 failed。");
  }
  // v1.3：cli 必须与本服务器进程解析出的 DEFAULT_CLI 严格一致（worker 继承
  // server 环境计算出同一值）——"换成另一个存在的文件"同样拒绝，防任意脚本执行
  if (request.cli !== DEFAULT_CLI) {
    writeTerminalResult(project, taskId, rid, { ...VR, status: "failed", exitCode: 1, message: `request.cli 与服务器配置不符（${request.cli} ≠ ${DEFAULT_CLI}），拒绝执行（疑似被篡改）。` });
    bail("request.cli 与服务器配置不符，已落 failed。");
  }
  if (!fs.existsSync(DEFAULT_CLI) || !fs.statSync(DEFAULT_CLI).isFile()) {
    writeTerminalResult(project, taskId, rid, { ...VR, status: "failed", exitCode: 1, message: "request.cli 指向的 CLI 文件不存在或不是文件，拒绝执行。" });
    bail("request.cli 非法，已落 failed。");
  }
  if (!Number.isInteger(request.timeout_sec) || request.timeout_sec < 1 || request.timeout_sec > 86400) {
    writeTerminalResult(project, taskId, rid, { ...VR, status: "failed", exitCode: 1, message: "request.timeout_sec 越界，拒绝执行。" });
    bail("request.timeout_sec 越界，已落 failed。");
  }

  // ---- 防重复启动校验（等待父进程写入真实 worker_pid）
  let guard = null;
  for (let i = 0; i < 50; i++) {
    try { guard = readJson(stateFile); } catch { guard = null; }
    if (guard && Number.isInteger(guard.worker_pid) && guard.worker_pid > 0) break;
    await sleep(100);
  }
  const guardOk = guard && guard.run_id === rid && guard.status === "queued" && guard.worker_pid === process.pid;
  if (!guardOk) {
    // 有别的活 worker 声称了本轮 → 让位（纯日志）；否则说明没人接 → 结构化落盘（v1.3：
    // 覆盖全部活动态 queued/running/stop_requested——running+死 pid 之前会无 result 直接退出）
    const ownerAlive = guard && guard.run_id === rid && ACTIVE.has(guard.status) && guard.worker_pid !== process.pid && Number.isInteger(guard.worker_pid) && alive(guard.worker_pid);
    if (ownerAlive) {
      bail(`worker 校验失败：run_id=${rid} 已由存活 worker(${guard.worker_pid}) 接管，本进程让位退出。`);
    }
    {
      writeTerminalResult(project, taskId, rid, { status: "failed", exitCode: 1, message: `worker 启动校验失败：state 缺失/损坏或 run_id/status/pid 不匹配（${guard?.run_id}, ${guard?.status}, ${guard?.worker_pid}），无其他存活 worker。` });
    }
    bail("worker 校验失败且无存活接管者。");
  }
  guard.status = "running";
  guard.updated_at = nowIso();
  writeState(project, taskId, guard);

  // secret 提升到 try 外：任何出口（含 catch/finally）都能脱敏
  let secret = "";
  let child = null;
  let childPid = null;
  let exitCode = 1, status = "failed";
  let overflowed = false;
  let sessionForState = guard.session_id || null;

  process.on("exit", () => { if (childPid && alive(childPid)) killTree(childPid); });

  // v1.2：流式落盘——不再无限缓存在内存；超限终止并报明确错误
  const rawOutPath = path.join(rdir, "stdout.raw");
  const rawErrPath = path.join(rdir, "stderr.raw");
  let outBytes = 0, errBytes = 0;
  const outStream = fs.createWriteStream(rawOutPath);
  const errStream = fs.createWriteStream(rawErrPath);

  try {
    const creds = credentials(request.model);
    secret = creds.apiKey;
    const runtimeDir = runtimeRoot(project); // v1.2：runtime 在项目外
    fs.mkdirSync(runtimeDir, { recursive: true });
    const env = {};
    for (const key of ENV_WHITELIST) {
      if (typeof process.env[key] === "string") env[key] = process.env[key];
    }
    Object.assign(env, {
      ZCODE_MODEL: `${PROVIDER}/${creds.model}`,
      ZCODE_BASE_URL: creds.baseURL,
      ZCODE_API_KEY: secret,
      ZCODE_STORAGE_DIR: runtimeDir,
      ZCODE_SESSION_DB_PATH: path.join(runtimeDir, "sessions.sqlite"),
    });

    if (fs.existsSync(stopFile)) {
      status = "stopped"; exitCode = 130;
    } else {
      const instruction = buildInstruction(controlPath(project,"tasks",taskId,"brief.md"), Boolean(request.resume_session), controlPath(project,"runs",rid,"followup.md"));
      const args = [DEFAULT_CLI, "--cwd", project, "--mode", request.mode,
                    "--json", "--prompt", instruction];
      if (request.resume_session) args.push("--resume", request.resume_session);
      child = spawn(NODE_EXE, args, {
        cwd: request.project_dir, env,
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      childPid = child.pid;
      let exited = null;
      const secretWriter = (stream) => {
        let pending=""; const decoder=new StringDecoder("utf8");
        return {push(d){pending+=decoder.write(d); const n=Math.max(0,pending.length-secret.length); let cut=n;
          if(secret){const i=pending.lastIndexOf(secret,cut);if(i>=0 && i+secret.length>cut)cut=i;}
          stream.write(redact(pending.slice(0,cut),secret)); pending=pending.slice(cut);
        },flush(){pending+=decoder.end();stream.write(redact(pending,secret));pending="";}};
      };
      const safeOut=secretWriter(outStream), safeErr=secretWriter(errStream);
      child.stdout.on("end",()=>safeOut.flush()); child.stderr.on("end",()=>safeErr.flush());
      child.stdout.on("data", (d) => {
        outBytes += d.length;
        safeOut.push(d);
        if (outBytes > STDOUT_LIMIT) {
          overflowed = true;
          killTree(childPid);
        }
      });
      child.stderr.on("data", (d) => {
        errBytes += d.length;
        safeErr.push(d);
        if (errBytes > STDERR_LIMIT) {
          overflowed = true;
          killTree(childPid);
        }
      });
      child.on("error", (e) => { errStream.write(Buffer.from(String(e) + "\n")); exited = -1; });
      child.on("exit", (c) => { exited = c; });

      const cur = readJson(stateFile);
      cur.child_pid = childPid;
      writeState(project, taskId, cur);

      const deadline = Date.now() + request.timeout_sec * 1000;
      while (exited === null) {
        if (fs.existsSync(stopFile)) break;
        if (Date.now() >= deadline) break;
        await sleep(300);
      }
      if (exited === null) {
        killTree(childPid);
        for (let i = 0; i < 40 && exited === null; i++) await sleep(100);
        status = fs.existsSync(stopFile) ? "stopped" : "timed_out";
        exitCode = status === "stopped" ? 130 : 124;
      } else {
        exitCode = exited;
        status = exitCode === 0 ? "returned" : "failed";
      }
    }
  } catch (e) {
    if (childPid) killTree(childPid);
    status = "failed";
    exitCode = 1;
    errStream.write(Buffer.from("\n" + String((e && e.stack) || e) + "\n"));
  } finally {
    await new Promise((res) => outStream.end(res));
    await new Promise((res) => errStream.end(res));

    // 读回（受上限保护）→ 脱敏 → 正式日志；raw 文件删除
    let stdout = "", stderr = "";
    try { stdout = fs.readFileSync(rawOutPath, "utf8"); } catch { /* 无输出 */ }
    try { stderr = fs.readFileSync(rawErrPath, "utf8"); } catch { /* 无输出 */ }
    try { fs.rmSync(rawOutPath, { force: true }); } catch { /* 尽力而为 */ }
    try { fs.rmSync(rawErrPath, { force: true }); } catch { /* 尽力而为 */ }
    stdout = redact(stdout, secret);
    stderr = redact(stderr, secret);
    try { fs.writeFileSync(path.join(rdir, "stdout.log"), stdout, "utf8"); } catch { /* 尽力而为 */ }
    try { fs.writeFileSync(path.join(rdir, "stderr.log"), stderr, "utf8"); } catch { /* 尽力而为 */ }

    if (overflowed) {
      status = "failed";
      exitCode = 125;
      stderr += `\n输出超过上限（stdout ${STDOUT_LIMIT} / stderr ${STDERR_LIMIT} 字节），子进程已被终止；stdout.log/stderr.log 保留已产生的部分。`;
    }

    let payload;
    if (overflowed) {
      payload = { response: "" };
    } else {
      try { payload = JSON.parse(stdout); } catch { payload = { response: stdout }; }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        payload = { response: payload };
      }
      payload = deepRedact(payload, secret);
      if (typeof payload.response === "string" && payload.response.length > RESPONSE_CAP) {
        payload.response = payload.response.slice(0, RESPONSE_CAP) +
          `\n[已截断：原文 ${payload.response.length} 字符，完整内容见 stdout.log]`;
      }
    }

    let sessionReturned = null;
    if (request.resume_session && exitCode === 0 && payload.sessionId &&
        payload.sessionId !== request.resume_session) {
      status = "failed";
      exitCode = 2;
      sessionReturned = payload.sessionId;
      stderr += "\n续聊返回的 sessionId 不一致，需要人工检查；状态保留原会话。";
    } else if (payload.sessionId && exitCode === 0) {
      sessionForState = payload.sessionId;
    }

    const report = {
      task_id: taskId, run_id: rid, status,
      process_ok: exitCode === 0, exit_code: exitCode, task_verified: false,
      project_dir: request.project_dir, run_dir: rdir,
      resumed_session: request.resume_session,
      ...(sessionReturned ? { session_id_returned: sessionReturned } : {}),
      result: payload,
    };
    if (stderr) report.stderr_tail = stderr.slice(-2000);
    writeJsonAtomic(resultPathOf(project, rid), report);
    try { audit.terminal(project,taskId,rid,status,[resultPathOf(project,rid),path.join(rdir,"stdout.log"),path.join(rdir,"stderr.log")]); }
    catch(e){status="failed";log("审计终态写入失败："+e.message);}
    try {
      const fin = readJson(stateFile);
      if (fin.run_id === rid) {
        fin.status = status;
        fin.updated_at = nowIso();
        fin.elapsed_seconds = Math.round((Date.now() - fin.started_epoch) / 100) / 10;
        fin.child_pid = null;
        fin.worker_pid = null;
        fin.session_id = sessionForState;
        writeState(project, taskId, fin);
      }
    } catch (e) { log(`终态写入失败：${e && e.message}`); }
    log(`worker 结束：status=${status} exit=${exitCode} out=${outBytes}B err=${errBytes}B`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- MCP 工具目录

const RO = { readOnlyHint: true };
const WRITE_OPEN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const INSTRUCTIONS = [
  "每轮终态必须独立 Review 并 zcode_record_review；每阶段默认最多三次修复，最终必须 zcode_finalize。start 必填 audit；新增工具需新 MCP 连接。",
  "核心规则：1) 只把已授权、范围明确、工作量较大的编码/批量修改/文档整理任务派给 ZCode；",
  "简单修改、少量文字调整和问答由 Codex 直接完成——ZCode 每轮有数万 token 固定上下文成本，小任务不值得派发。",
  "2) zcode_start 返回只代表已提交；必须 zcode_wait 等待结束；结束后必须验收文件产物——退出码 0 不代表业务成功。",
  "3) 改文件用 edit，纯分析/审查用 plan；yolo 与 build 被代码层拒绝。",
  "4) 安装依赖、构建、测试等终端操作由 Codex 执行，ZCode 只返回命令与目的。",
  "5) zcode_stop 不回滚已写出的文件。6) 续聊用 zcode_followup，只传本次变化（补充会写入任务文件，不进命令行）。",
  "7) interrupted 状态先 zcode_stop（会回收孤儿子进程）再看日志，不要盲目重发。",
  "详细说明：start 需要 project_dir（绝对路径）和 prompt/prompt_file 二选一（prompt_file 必须位于项目内）；",
  "任务书写清目标、允许修改范围、约束与验收方式。wait 的 timeout_ms=0 立即返回快照；",
  "result 给出完整 response/usage/exit_code；doctor 体检不发起模型请求。",
  "任务数据在 <项目>/.zcode-mcp/（建议加入 git exclude）；每轮 run 的 stdout/stderr/worker 日志都可查。",
].join("\n");

const TOOLS = [
 {name:"zcode_record_review",title:"记录独立 Review",description:"每轮终态后记录一次不可覆盖的 Review。VERIFIED 必须有 evidence.description 和 evidence.files 绝对路径；服务器计算哈希。executor 指实际实现者。迁移 v1.3.1 权威任务时可提供 migration_audit，历史缺失字段 UNKNOWN。",annotations:WRITE_OPEN,inputSchema:{...audit.reviewSchema,properties:{...audit.reviewSchema.properties,migration_audit:audit.metadataSchema}}},
 {name:"zcode_finalize",title:"完成委派审计",description:"最终必须调用。PASS 需要最近轮 PASS Review、无未解决 VERIFIED P0/P1、acceptance_met=true 和客观文件验证。统计由事件计算；validation_files 为证据绝对路径，manual_interventions 是新增介入事件描述，不得重复填已记录事件。",annotations:WRITE_OPEN,inputSchema:audit.finalSchema},
  {
    name: "zcode_start",
    title: "派发 ZCode 后台任务",
    description:
      "给 ZCode 派发一个后台执行任务，毫秒级返回 task_id（只代表已提交，不代表完成）。" +
      "仅用于已授权、范围明确、工作量较大的任务；简单任务自己做——ZCode 每轮有数万 token 固定上下文成本。" +
      "任务书写清：目标、允许修改的文件范围、约束、验收方式。默认 edit 模式（可改项目内文件）；" +
      "纯讨论/审查用 plan。安装依赖、构建、测试等终端操作不交给 ZCode。返回后用 zcode_wait 轮询。",
    annotations: WRITE_OPEN,
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string", description: "项目绝对路径；任务数据写入其下 .zcode-mcp/ 目录" },
        prompt: { type: "string", description: "任务书正文；与 prompt_file 必须且只能提供一个" },
        prompt_file: { type: "string", description: "任务书文件绝对路径（UTF-8，必须位于项目目录内）；与 prompt 必须且只能提供一个" },
        mode: { type: "string", enum: ["edit", "plan"], description: "默认 edit；plan 只读分析" },
        model: { type: "string", description: "默认 GLM-5.3-Flash；需要更强可用 GLM-5.3。续聊默认沿用上一轮模型" },
        timeout_seconds: { type: "integer", minimum: 60, maximum: 3600, description: "整轮超时秒数，默认 600" },
        task_id: { type: "string", description: "自定义任务 ID（可省略，自动生成）" },
        audit: audit.metadataSchema,
      },
      required: ["project_dir", "audit"],
      additionalProperties: false,
    },
  },
  {
    name: "zcode_wait",
    title: "有界等待任务推进",
    description:
      "等待任务推进；单次最长 60 秒后必定返回，timeout_ms=0 立即返回快照。still_running=true 时可再次调用，" +
      "期间可先做其他事；任务结束则直接带回结果摘要。elapsed_seconds 远超预期且多次等待无进展时，" +
      "先 zcode_stop（会回收孤儿进程）再检查 run_dir 日志。",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        task_id: { type: "string" },
        timeout_ms: { type: "integer", minimum: 0, maximum: 60000, description: "本次等待上限毫秒；0=立即返回快照，默认 30000" },
      },
      required: ["project_dir", "task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "zcode_result",
    title: "读取任务完整结果",
    description:
      "读取任务最近一轮完整结果（response 全文、usage、exit_code、stderr_tail）。" +
      "注意：process_ok / 退出码 0 只代表进程正常返回，不代表业务成功；必须检查文件产物或测试结果。",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: { project_dir: { type: "string" }, task_id: { type: "string" } },
      required: ["project_dir", "task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "zcode_followup",
    title: "同会话续聊（只传变化）",
    description:
      "在同一 ZCode 会话上继续既有任务，只传本次变化或补充，不要复述全部背景；需等上一轮到终态。" +
      "补充内容会写入本轮 followup.md（不进进程命令行）。默认沿用上一轮模型；显式换模型会被记录。",
    annotations: WRITE_OPEN,
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        task_id: { type: "string" },
        prompt: { type: "string", description: "本次补充（只写变化）" },
        followup_kind:{type:"string",enum:["repair","phase"],description:"默认 repair；phase 要求上一阶段 PASS，不计修复次数"},
        override_authorization:{type:"string",description:"超过三次修复需明确用户授权文本，记录审计；服务不能独立验证授权来源"},
        mode: { type: "string", enum: ["edit", "plan"] },
        model: { type: "string", description: "默认沿用上一轮模型；显式指定且不同时会记录变更" },
        timeout_seconds: { type: "integer", minimum: 60, maximum: 3600 },
      },
      required: ["project_dir", "task_id", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "zcode_status",
    title: "查看任务状态",
    description:
      "查看任务状态（含 task_id 时）；省略 task_id 则列出项目最近 10 个任务（单个损坏状态显示 corrupted，不影响其余）。" +
      "状态含义：queued 已提交 / running 执行中 / stop_requested 停止中 / returned 进程已返回 / " +
      "failed 调用失败 / stopped 已停止 / timed_out 超时 / interrupted 后台进程异常退出" +
      "（先 zcode_stop 回收孤儿，再看 run_dir 日志）/ corrupted 状态损坏。这些是进程状态，不代表完成百分比。",
    annotations: RO,
    inputSchema: {
      type: "object",
      properties: { project_dir: { type: "string" }, task_id: { type: "string" } },
      required: ["project_dir"],
      additionalProperties: false,
    },
  },
  {
    name: "zcode_stop",
    title: "停止任务（不回滚）",
    description:
      "请求停止正在执行的任务；几秒内状态变为 stopped。worker 已死或未能在宽限期启动时直接终态收尾" +
      "（recovered_orphan，含结构化结果）。已结束的任务返回 already_finished。停止不回滚已写出的文件。",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { project_dir: { type: "string" }, task_id: { type: "string" } },
      required: ["project_dir", "task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "zcode_doctor",
    title: "链路体检（不发起模型请求）",
    description:
      "链路体检：Node、ZCode CLI 文件、桌面版凭据（含 baseURL）、可用模型。与启动共用同一套验证。不发起模型请求。",
    annotations: RO,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function recordReview(a) {
 const project=resolveProject(a.project_dir);
 const clean=deepRedact(a,credentials(DEFAULT_MODEL).apiKey);
 if(!audit.exists(project,a.task_id)&&a.migration_audit){
   const st=executionState(project,a.task_id);
   if(!TERMINAL.has(st.status))throw new Error("迁移需要已终态的权威任务");
   const req=readJson(controlPath(project,"runs",st.run_id,"request.json"));
   audit.begin(project,a.task_id,req,clean.migration_audit,"UNKNOWN: migrated task; original evidence remains in control/project files",{migration:true});
   audit.terminal(project,a.task_id,st.run_id,st.status,[resultPathOf(project,st.run_id)]);
 }
 return audit.review(project,clean);
}
function finalizeAudit(a){
 const project=resolveProject(a.project_dir);const result=audit.finalize(project,deepRedact(a,credentials(DEFAULT_MODEL).apiKey));
 try{audit.writeReport(project);return {...result,report_generated:true};}catch(e){return {...result,report_generated:false,report_error:e.message};}
}

function dispatch(name, args) {
  const a = args || {};
  switch (name) {
    case "zcode_start": return startTask(a, false);
    case "zcode_followup": return startTask(a, true);
    case "zcode_wait": return waitTask(a);
    case "zcode_status": return statusTask(a);
    case "zcode_result": return resultTask(a);
    case "zcode_stop": return stopTask(a);
    case "zcode_doctor": return doctor();
    case "zcode_record_review": return recordReview(a);
    case "zcode_finalize": return finalizeAudit(a);
    default: throw new Error(`未知工具：${name}`);
  }
}

// ---------------------------------------------------------------- MCP stdio 服务

function serve() {
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || msg.id === null) return;
    const method = msg.method;
    if (method === "initialize") {
      write({
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "zcode-bridge", title: "ZCode 子智能体桥（私有）", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      });
    } else if (method === "ping") {
      write({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else if (method === "tools/list") {
      write({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      Promise.resolve()
        .then(() => dispatch(msg.params.name, msg.params.arguments))
        .then((out) => write({
          jsonrpc: "2.0", id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
            structuredContent: out,
          },
        }))
        .catch((e) => write({
          jsonrpc: "2.0", id: msg.id,
          result: { content: [{ type: "text", text: `zcode-bridge 错误：${e.message}` }], isError: true },
        }));
    } else {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `未知方法 ${method}` } });
    }
  });
  rl.on("close", () => process.exit(0));
}

// ---------------------------------------------------------------- 入口

const argv = process.argv.slice(2);
if (argv[0] === "_worker") {
  runWorker(argv).catch((e) => {
    try { console.error("worker 顶层异常：", e); } catch { /* 忽略 */ }
    process.exit(1);
  });
} else {
  serve();
}
