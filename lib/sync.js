"use strict";

// 馆际同步协议（HTTP JSON，零依赖）。
//
// 双向增量：双方各持对方的向量时钟游标，一次 exchange 互相补齐对方缺的操作；
// 重复报文靠 opId 幂等；缺前序的操作进隔离区，返回 missing；之后自动再来一轮
// “补链”，直到没有新操作生效。同步可在任意一步中断——所有进度都已落盘，
// 重连后从游标继续，不会重复生效。

// 一次双向交换。fetchJson(method, path, body) 负责真正的 HTTP 调用。
// 能力协商：pull 时声明本副本能力，对端按能力裁剪（旧副本收不到墓碑标记）；
// 推送时按对端在 pull 响应中声明的能力裁剪导出，避免把新协议数据发给旧副本。
async function exchange(replica, peerSite, fetchJson, { maxRounds = 32 } = {}) {
  const total = { rounds: 0, pulled: 0, pushed: 0, applied: [], duplicate: [], quarantined: [], rejected: [], missing: [] };
  const localCaps = replica.capabilities ? replica.capabilities() : { tombstones: true };
  let peerCaps = null; // 首轮未知，pull 后得知

  for (let round = 0; round < maxRounds; round += 1) {
    total.rounds += 1;

    // 1) 拉：声明本方时钟与能力，取增量
    const pull = await fetchJson("POST", "/sync/pull", {
      site: replica.site,
      vclock: replica.meta().vclock,
      capabilities: localCaps
    });
    const incoming = pull.ops || [];
    if (pull.capabilities) peerCaps = pull.capabilities;

    // 2) 生效（幂等；缺链的会被隔离；无法识别的协议字段 fail-closed）
    let report = { applied: [], duplicate: [], quarantined: [], rejected: [], missing: [] };
    if (incoming.length) {
      report = await replica.applyRemote(incoming, peerSite);
    }
    total.pulled += incoming.length;
    mergeReport(total, report);

    // 3) 推：按对端能力裁剪（旧副本拿不到墓碑及因果后继）
    const exportOpts = { capabilities: peerCaps || { tombstones: false } };
    const outgoing = replica.since(pull.peerVclock || {}, exportOpts);
    if (outgoing.length) {
      const ack = await fetchJson("POST", "/sync/push", {
        site: replica.site,
        ops: outgoing,
        capabilities: localCaps
      });
      total.pushed += outgoing.length;
      if (ack.capabilities) peerCaps = ack.capabilities;
      // 对端可能隔离了本批，把它缺的前序纳入下一轮补链
      for (const opId of (ack.data && ack.data.missing) || ack.missing || []) {
        if (!total.missing.includes(opId)) total.missing.push(opId);
      }
      // 记录对端已确认收到的位置（游标由对端在 push 响应中回传）
      if (ack.peerVclock) markPeerCursor(replica, peerSite, ack.peerVclock);
    }

    // 4) 终止条件：这一轮既没有新操作到达、也没有操作可发
    if (!incoming.length && !outgoing.length) break;
    if (round === maxRounds - 1) {
      total.truncated = true;
    }
  }

  total.equalHashes = undefined;
  total.meta = replica.meta();
  total.peerCapabilities = peerCaps;
  return total;
}

function mergeReport(total, report) {
  for (const key of ["applied", "duplicate", "quarantined", "rejected"]) {
    for (const id of report[key] || []) if (!total[key].includes(id)) total[key].push(id);
  }
  for (const id of report.missing || []) if (!total.missing.includes(id)) total.missing.push(id);
}

// 推方失败重试后，对端可能已收到；游标只用于增量裁剪，真正确认靠对端响应。
function markPeerCursor(replica, peerSite, vclock) {
  replica.engine.recordPeer(peerSite, vclock);
}

// 极简 HTTP JSON 客户端，供 CLI 和测试使用
function makeHttpClient(baseUrl, { timeoutMs = 10000 } = {}) {
  return async (method, urlPath, body) => {
    const url = new URL(urlPath, baseUrl);
    const result = await new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? require("https") : require("http");
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = lib.request(
        url,
        {
          method,
          headers: payload
            ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length }
            : {},
          timeout: timeoutMs
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => {
            let parsed = {};
            if (raw) {
              try {
                parsed = JSON.parse(raw);
              } catch {
                reject(new Error(`对端返回非 JSON（${res.statusCode}）`));
                return;
              }
            }
            if (res.statusCode >= 400) {
              const error = new Error(parsed.error || `同步失败：HTTP ${res.statusCode}`);
              error.status = res.statusCode;
              error.body = parsed;
              reject(error);
              return;
            }
            resolve(parsed);
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("同步请求超时")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    return result;
  };
}

module.exports = { exchange, makeHttpClient, mergeReport };
