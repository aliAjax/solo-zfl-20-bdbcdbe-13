"use strict";

// 古籍拓片缺损修补 API —— 多馆离线协作版
//
// 旧接口（路径/方法/响应结构）完全保持不变；新增 /sync/*、/conflicts、/inspections。
// 每个馆是一个完整副本：SITE 指定馆号，DATA_DIR 指定各自的数据目录。
// 离线期间全部登记照常落盘；联网后用 POST /sync/exchange 或 scripts/sync-once.js 双向同步。

const http = require("http");
const path = require("path");
const { Replica } = require("./lib/replica");
const { EngineError } = require("./lib/engine");
const { exchange, makeHttpClient } = require("./lib/sync");

const PORT = Number(process.env.PORT || 3020);
const SITE = process.env.SITE || "local";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FAIL_WRITES = Number(process.env.FAIL_WRITES || 0);

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  // —— 多馆协作新增 ——
  "GET /inspections?damageId=&batchId=&result=",
  "POST /inspections",
  "GET /sync/status",
  "POST /sync/pull",
  "POST /sync/push",
  "POST /sync/exchange",
  "GET /conflicts",
  "POST /conflicts/resolve",
  "GET /quarantine",
  "GET /versions?entity=&id="
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new EngineError("请求体必须是合法JSON", 400);
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw new EngineError(`缺少字段：${missing.join(", ")}`, 400);
}

function parsePeerMap() {
  // SYNC_PEERS="B=http://127.0.0.1:3021,C=http://127.0.0.1:3022"
  const map = {};
  for (const pair of (process.env.SYNC_PEERS || "").split(",")) {
    const [site, url] = pair.split("=").map((part) => part && part.trim());
    if (site && url) map[site] = url.replace(/\/$/, "");
  }
  return map;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

async function createServer({ site = SITE, dataDir = DATA_DIR, port = 0, failWrites = FAIL_WRITES, legacy = false } = {}) {
  const replica = new Replica(site, dataDir, { failWrites, legacy });
  await replica.init();
  const peers = parsePeerMap();

  const handle = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const db = () => replica.project();

    // ---------------- 基础接口（与旧版一致） ----------------

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "rubbing-repair-api", site, routes });
    }

    if (req.method === "GET" && pathname === "/rubbings") {
      const data = db().rubbings.map((rubbing) => {
        const damages = db().damages.filter((item) => item.rubbingId === rubbing.id);
        return {
          ...rubbing,
          damageCount: damages.length,
          pendingDamages: damages.filter((item) => item.status !== "repaired").length
        };
      });
      return send(res, 200, { data });
    }

    if (req.method === "POST" && pathname === "/rubbings") {
      const body = await parseBody(req);
      required(body, ["code", "source", "paperSize"]);
      const op = await replica.mutate((engine, ctx) => ({
        type: "rubbing.create",
        payload: {
          id: ctx.makeId("rubbing"),
          fields: {
            code: body.code,
            source: body.source,
            paperSize: body.paperSize,
            note: body.note || "",
            createdAt: ctx.now
          }
        }
      }));
      const rubbing = replica.project().rubbings.find((item) => item.id === op.payload.id);
      return send(res, 201, { data: rubbing });
    }

    const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
    if (rubbingDamagesMatch && req.method === "GET") {
      const rubbingId = rubbingDamagesMatch[1];
      if (!db().rubbings.some((item) => item.id === rubbingId)) {
        return send(res, 404, { error: "拓片不存在" });
      }
      return send(res, 200, { data: db().damages.filter((item) => item.rubbingId === rubbingId) });
    }

    if (rubbingDamagesMatch && req.method === "POST") {
      const rubbingId = rubbingDamagesMatch[1];
      if (!db().rubbings.some((item) => item.id === rubbingId)) {
        return send(res, 404, { error: "拓片不存在" });
      }
      const body = await parseBody(req);
      required(body, ["position", "type", "beforePhotoUrl"]);
      const op = await replica.mutate((engine, ctx) => ({
        type: "damage.create",
        payload: {
          id: ctx.makeId("damage"),
          fields: {
            rubbingId,
            position: body.position,
            type: body.type,
            beforePhotoUrl: body.beforePhotoUrl,
            afterPhotoUrl: "",
            status: "pending",
            repairNote: "",
            batchId: null,
            createdAt: ctx.now,
            repairedAt: null
          }
        }
      }));
      const damage = replica.project().damages.find((item) => item.id === op.payload.id);
      return send(res, 201, { data: damage });
    }

    if (req.method === "GET" && pathname === "/damages") {
      const status = url.searchParams.get("status");
      const type = url.searchParams.get("type");
      const data = db().damages.filter(
        (item) => (!status || item.status === status) && (!type || item.type === type)
      );
      return send(res, 200, { data });
    }

    const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
    if (damagePatchMatch && req.method === "PATCH") {
      const damageId = damagePatchMatch[1];
      if (!db().damages.some((item) => item.id === damageId)) {
        return send(res, 404, { error: "缺损项不存在" });
      }
      const body = await parseBody(req);
      const allowed = ["position", "type", "beforePhotoUrl", "afterPhotoUrl", "status", "repairNote"];
      const fields = {};
      for (const field of allowed) if (body[field] !== undefined) fields[field] = body[field];
      await replica.mutate((engine, ctx) => {
        const current = engine.project().damages.find((item) => item.id === damageId);
        const nextStatus = fields.status ?? current.status;
        if (nextStatus === "repaired") fields.repairedAt = ctx.now;
        return { type: "field.update", payload: { entity: "damages", entityId: damageId, fields } };
      });
      return send(res, 200, { data: replica.project().damages.find((item) => item.id === damageId) });
    }

    if (req.method === "GET" && pathname === "/batches") {
      return send(res, 200, { data: db().batches.map((batch) => enrichBatch(db(), batch)) });
    }

    if (req.method === "POST" && pathname === "/batches") {
      const body = await parseBody(req);
      required(body, ["name", "damageIds"]);
      if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
        return send(res, 400, { error: "damageIds必须是非空数组" });
      }
      const current = db();
      const invalid = body.damageIds.filter((id) => !current.damages.find((damage) => damage.id === id));
      if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
      const op = await replica.mutate((engine, ctx) => ({
        type: "batch.create",
        payload: { id: ctx.makeId("batch"), name: body.name, damageIds: body.damageIds, note: body.note || "" }
      }));
      const batch = replica.project().batches.find((item) => item.id === op.payload.id);
      return send(res, 201, { data: enrichBatch(replica.project(), batch) });
    }

    const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
    if (batchMatch && req.method === "GET") {
      const batch = db().batches.find((item) => item.id === batchMatch[1]);
      if (!batch) return send(res, 404, { error: "修补批次不存在" });
      return send(res, 200, { data: enrichBatch(db(), batch) });
    }

    const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
    if (completeMatch && req.method === "POST") {
      const batchId = completeMatch[1];
      if (!db().batches.some((item) => item.id === batchId)) {
        return send(res, 404, { error: "修补批次不存在" });
      }
      const body = await parseBody(req);
      const results = Array.isArray(body.results) ? body.results : [];
      await replica.mutate(() => ({
        type: "batch.complete",
        payload: {
          id: batchId,
          results,
          defaultAfterPhotoUrl: body.defaultAfterPhotoUrl,
          defaultRepairNote: body.defaultRepairNote,
          note: body.note
        }
      }));
      return send(res, 200, { data: enrichBatch(replica.project(), replica.project().batches.find((b) => b.id === batchId)) });
    }

    // ---------------- 质检（离线可登记，随操作同步） ----------------

    if (req.method === "GET" && pathname === "/inspections") {
      const damageId = url.searchParams.get("damageId");
      const batchId = url.searchParams.get("batchId");
      const result = url.searchParams.get("result");
      const data = db().inspections.filter(
        (item) =>
          (!damageId || item.damageId === damageId) &&
          (!batchId || item.batchId === batchId) &&
          (!result || item.result === result)
      );
      return send(res, 200, { data });
    }

    if (req.method === "POST" && pathname === "/inspections") {
      const body = await parseBody(req);
      required(body, ["records"]);
      if (!Array.isArray(body.records) || body.records.length === 0) {
        return send(res, 400, { error: "records必须是非空数组" });
      }
      for (const [index, record] of body.records.entries()) {
        if (!record.result) return send(res, 400, { error: `第${index + 1}条质检缺少 result（pass/fail/rework）` });
        if (record.damageId && !db().damages.some((item) => item.id === record.damageId)) {
          return send(res, 400, { error: `质检缺损项不存在：${record.damageId}` });
        }
      }
      const op = await replica.mutate((engine, ctx) => ({
        type: "inspection.create",
        payload: {
          inspector: body.inspector || "",
          batchId: body.batchId || null,
          records: body.records.map((record) => ({
            damageId: record.damageId || null,
            batchId: record.batchId || null,
            inspector: record.inspector || "",
            result: record.result,
            note: record.note || "",
            at: record.at || ctx.now
          }))
        }
      }));
      const created = db().inspections.filter((item) =>
        op.payload.records.some((_, index) => item.id === `inspection_${op.site}_${op.seq}_${index}`)
      );
      return send(res, 201, { data: created, opId: op.opId });
    }

    // ---------------- 多馆同步 ----------------

    if (req.method === "GET" && pathname === "/sync/status") {
      const meta = replica.meta();
      const stateHash = replica.stateHash();
      const replayHash = replica.stateHash(true);
      return send(res, 200, {
        data: {
          ...meta,
          peers: { ...peers, ...meta.peers },
          conflicts: replica.conflicts().length,
          stateHash,
          replayHash,
          replayConvergent: stateHash === replayHash,
          protocol: replica.protocolVersion(),
          capabilities: replica.capabilities()
        }
      });
    }

    // 对端拉取增量：{ site, vclock, capabilities? } -> { ops, peerVclock, protocol, capabilities }
    // 请求方声明能力，导出方据此裁剪（旧副本拿不到墓碑标记）。
    if (req.method === "POST" && pathname === "/sync/pull") {
      const body = await parseBody(req);
      const vclock = body.vclock && typeof body.vclock === "object" ? body.vclock : {};
      const requesterCaps = body.capabilities && typeof body.capabilities === "object" ? body.capabilities : null;
      // 未声明能力 = 旧副本，按最保守（无墓碑）裁剪，保证旧端不会收到无法识别的协议数据。
      const caps = requesterCaps || { tombstones: false };
      const ops = replica.since(vclock, { capabilities: caps });
      return send(res, 200, {
        ops,
        peerVclock: replica.meta().vclock,
        protocol: replica.protocolVersion(),
        capabilities: replica.capabilities()
      });
    }

    // 对端推送增量：{ site, ops, capabilities? } -> { report, peerVclock, ... }，整包幂等
    if (req.method === "POST" && pathname === "/sync/push") {
      const body = await parseBody(req);
      if (!Array.isArray(body.ops)) return send(res, 400, { error: "ops必须是数组" });
      try {
        const report = await replica.applyRemote(body.ops, body.site || "unknown");
        return send(res, 200, {
          data: report,
          peerVclock: replica.meta().vclock,
          protocol: replica.protocolVersion(),
          capabilities: replica.capabilities()
        });
      } catch (error) {
        // 整包校验失败（含无法识别的协议字段）时无任何操作生效，对端可原样重发
        const status = error.status === 400 ? 409 : error.status || 409;
        return send(res, status, { error: error.message, retryable: true, protocol: replica.protocolVersion(), capabilities: replica.capabilities() });
      }
    }

    // 由本馆主动向对端发起一次双向增量交换（对端地址取自 SYNC_PEERS）
    if (req.method === "POST" && pathname === "/sync/exchange") {
      const body = await parseBody(req);
      required(body, ["peer"]);
      const baseUrl = body.url || peers[body.peer];
      if (!baseUrl) return send(res, 400, { error: `未知对端：${body.peer}，请在 SYNC_PEERS 中配置或传 url` });
      try {
        const report = await exchange(replica, body.peer, makeHttpClient(baseUrl));
        return send(res, 200, { data: report });
      } catch (error) {
        // 中断不回滚已生效进度；下次交换从向量时钟游标续传
        return send(502, {
          error: `同步中断：${error.message}（已保留进度，重连后自动续传）`,
          partial: replica.meta(),
          retryable: true
        });
      }
    }

    // ---------------- 冲突与版本 ----------------

    if (req.method === "GET" && pathname === "/conflicts") {
      return send(res, 200, { data: replica.conflicts() });
    }

    if (req.method === "POST" && pathname === "/conflicts/resolve") {
      const body = await parseBody(req);
      const loc = body.conflictId ? parseConflictId(body.conflictId) : body;
      if (!loc || !loc.entity || !loc.entityId || !loc.field || !Object.prototype.hasOwnProperty.call(body, "value")) {
        return send(res, 400, { error: "需要 conflictId（或 entity/entityId/field）与 value" });
      }
      if (!replica.fieldVersion(loc.entity, loc.entityId)) {
        return send(res, 404, { error: "实体不存在" });
      }
      // 人工接口即时守卫：只能裁决当前确实存在的字段冲突。
      // 引擎层裁决是纯因果写入（不做此顺序相关判断），保证同步/重放顺序无关；
      // 这里仅服务人工调用，重复裁决或裁决已解决字段返回 409。
      const exists = replica
        .conflicts()
        .some((c) => c.entity === loc.entity && c.entityId === loc.entityId && c.field === loc.field);
      if (!exists) {
        return send(res, 409, { error: "该字段当前不存在冲突（可能已被裁决）" });
      }
      try {
        const op = await replica.mutate(() => ({
          type: "conflict.resolve",
          payload: { entity: loc.entity, entityId: loc.entityId, field: loc.field, value: body.value, reason: body.reason || "" }
        }));
        return send(res, 200, { data: { resolved: parseConflictId(`${loc.entity}.${loc.entityId}.${loc.field}`), opId: op.opId } });
      } catch (error) {
        return send(error.status || 409, { error: error.message });
      }
    }

    if (req.method === "GET" && pathname === "/quarantine") {
      const meta = replica.meta();
      return send(res, 200, {
        data: meta.quarantined.map((opId) => ({ opId, state: "隔离中：等待前序操作补链后自动按序生效" })),
        count: meta.quarantined.length
      });
    }

    if (req.method === "GET" && pathname === "/versions") {
      const entity = url.searchParams.get("entity");
      const id = url.searchParams.get("id");
      if (!entity || !id) return send(res, 400, { error: "需要 entity 与 id 查询参数" });
      const versions = replica.fieldVersion(entity, id);
      if (!versions) return send(res, 404, { error: "实体不存在" });
      return send(res, 200, { data: versions });
    }

    return send(res, 404, { error: "接口不存在", routes });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      send(res, error.status || 500, { error: error.message || "服务器错误" });
    });
  });

  await new Promise((resolve) => server.listen(port, resolve));
  const address = server.address();
  return {
    server,
    replica,
    site,
    url: `http://127.0.0.1:${typeof address === "object" ? address.port : port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

function parseConflictId(conflictId) {
  // 形如 damages.damage_xxx.position —— 实体 id 内部不含点号（makeId 只用字母数字下划线短横）
  const parts = conflictId.split(".");
  if (parts.length !== 3) return null;
  return { entity: parts[0], entityId: parts[1], field: parts[2] };
}

if (require.main === module) {
  createServer({ site: SITE, dataDir: DATA_DIR, port: PORT, failWrites: FAIL_WRITES })
    .then(({ url, site }) => {
      console.log(`拓片修补API 馆号=${site} 运行于 ${url}，数据目录 ${DATA_DIR}`);
    })
    .catch((error) => {
      console.error("启动失败：", error.message);
      process.exit(1);
    });
}

module.exports = { createServer };
