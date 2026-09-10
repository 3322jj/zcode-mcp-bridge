#!/usr/bin/env node
/**
 * 测试用假 ZCode CLI：不发起任何模型请求，行为由任务书里的 @fake: 指令驱动。
 * 指令来源：instruction 文本本身（续聊的“本次补充”）或 brief 文件内容（首轮任务）。
 * 指令格式：@fake:mode=<ok|delay|nonjson|huge|secret|mismatch|envdump|fail>[,ms=毫秒][,session=sess_x]
 * 无指令时默认 ok。
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const promptIdx = args.indexOf("--prompt");
const instruction = promptIdx >= 0 ? String(args[promptIdx + 1] || "") : "";

// 新任务：instruction 含"任务文件 <绝对路径>"；续聊：补充在 followup.md（instruction 含其路径）
let source = instruction;
const briefMatch = instruction.match(/任务文件[：\s]*([A-Za-z]:\\[^\s，。]+)/);
if (briefMatch) {
  try { source += "\n" + fs.readFileSync(briefMatch[1], "utf8"); } catch { /* 读不到就用 instruction 本身 */ }
}
const followupMatch = instruction.match(/补充在文件[：\s]*([A-Za-z]:\\[^\s，。]+)/);
if (followupMatch) {
  try { source += "\n" + fs.readFileSync(followupMatch[1], "utf8"); } catch { /* 读不到就忽略 */ }
}

const params = {};
// 多个 @fake: 时后者覆盖前者：续聊 followup.md > 首轮 brief > instruction 本身
const matches = source.match(/@fake:([a-z0-9_=,.-]+)/gi);
const m = matches ? [matches[matches.length - 1]] : [];
if (m.length) {
  for (const pair of m[0].replace(/^@fake:/i, "").split(",")) {
    const [k, v] = pair.split("=");
    params[k] = v;
  }
}
const mode = params.mode || "ok";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

switch (mode) {
 case "inspect":
   emit({sessionId:"sess_fake_ok",response:JSON.stringify({storage:process.env.ZCODE_STORAGE_DIR,instruction,model:process.env.ZCODE_MODEL,mode:args[args.indexOf("--mode")+1],resume:args[args.indexOf("--resume")+1],cwd:process.cwd()})});process.exit(0);
  case "ok":
  default:
    emit({ sessionId: params.session || "sess_fake_ok", response: "fake-ok", usage: { totalTokens: 123 } });
    process.exit(0);
  case "delay": {
    const ms = Number(params.ms) || 5000;
    setTimeout(() => {
      emit({ sessionId: params.session || "sess_fake_ok", response: "fake-ok", usage: { totalTokens: 123 } });
      process.exit(0);
    }, ms);
    break;
  }
  case "nonjson":
    process.stdout.write("PLAIN-TEXT 这不是 JSON，fallback 文本 exit 0");
    process.exit(0);
  case "huge": {
    const big = "A".repeat(3000000);
    emit({ sessionId: "sess_fake_huge", response: big, usage: { totalTokens: 1 } });
    process.exit(0);
  }
  case "hugeover": {
    // 超过服务器 stdout 上限（20MB）：流式分块写出，触发"输出超上限"终止
    const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1MB of 'A'
    process.stdout.write('{"sessionId":"sess_fake_over","response":"');
    for (let i = 0; i < 30; i++) process.stdout.write(chunk); // 30MB
    process.stdout.write('"}');
    process.exit(0);
  }
  case "secret":
    process.stderr.write("boom SUPER-SECRET-SENTINEL-123 出现在 stderr 的敏感轨迹\n");
    process.exit(3);
  case "mismatch":
    emit({ sessionId: "sess_mismatch_NEW", response: "wrong-session" });
    process.exit(0);
  case "envdump": {
    const info = {
      hasLeak: process.env.ZBRIDGE_TEST_LEAK !== undefined,
      systemRoot: process.env.SystemRoot !== undefined,
      keyCount: Object.keys(process.env).length,
    };
    emit({ sessionId: "sess_fake_env", response: "ENVDUMP " + JSON.stringify(info) });
    process.exit(0);
  }
  case "fail":
    process.stderr.write("fake hard failure exit 7\n");
    process.exit(7);
}
