#!/usr/bin/env node
"use strict";

// 一次性双向增量同步：让本馆（--local 指向的运行实例）与一个对端交换操作。
// 可放进 cron / systemd timer 周期执行；断网时非零退出，重连后自动续传，不丢不重。
//
// 用法：
//   node scripts/sync-once.js --local http://127.0.0.1:3020 --peer hallB \
//     --url http://127.0.0.1:3021 [--retries 3]
// 也可省略 --url，由本馆进程的 SYNC_PEERS 环境变量按馆号解析。
//
// 退出码：0 成功（含本轮没有新操作）；2 参数/配置错误；3 重试用尽仍失败（进度已保留）。

const { makeHttpClient } = require("../lib/sync");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "true";
      args[key] = value;
    }
  }
  return args;
}

function postJson(baseUrl, pathName, body) {
  const client = makeHttpClient(baseUrl);
  return client("POST", pathName, body);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv);
  if (!args.local || !args.peer) {
    console.error("用法：node scripts/sync-once.js --local <本馆地址> --peer <对端馆号> [--url <对端地址>] [--retries 3]");
    process.exit(2);
  }
  const retries = Math.max(1, Number(args.retries || 3));

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const payload = { peer: args.peer };
      if (args.url !== "true") payload.url = args.url;
      const report = await postJson(args.local, "/sync/exchange", payload);
      const d = report.data || {};
      // 同步后查一次状态，报告待人工处理的冲突数
      let conflicts = null;
      let convergent = null;
      try {
        const client = makeHttpClient(args.local);
        const status = await client("GET", "/sync/status");
        conflicts = status.data.conflicts;
        convergent = status.data.replayConvergent;
      } catch {
        // 状态查询失败不影响同步成功的结论
      }
      console.log(
        JSON.stringify(
          {
            ok: true,
            attempt,
            peer: args.peer,
            rounds: d.rounds,
            pulled: d.pulled,
            pushed: d.pushed,
            applied: (d.applied || []).length,
            duplicate: (d.duplicate || []).length,
            quarantined: (d.quarantined || []).length,
            missing: d.missing || [],
            conflictsPending: conflicts,
            replayConvergent: convergent
          },
          null,
          2
        )
      );
      process.exit(0);
    } catch (error) {
      lastError = error;
      console.error(`[${attempt}/${retries}] 同步失败：${error.message}`);
      if (attempt < retries) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    }
  }
  console.error("重试用尽；已生效的增量均已落盘，网络恢复后重跑本脚本即可从断点续传。");
  console.error(`最后错误：${lastError && lastError.message}`);
  process.exit(3);
}

main();
