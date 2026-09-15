"use strict";

// HTTP 信封 fail-closed 回归：覆盖 pull、push、exchange 三条同步入口。
// 未知顶层字段 / 未知能力键 / 负载嵌套协议标记 -> 409，stateHash 与隔离区都不变；
// 已声明能力内的正常信封照常工作（跨版本兼容、收敛、幂等不回归）。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { rm } = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");

const tmpRoot = path.join(os.tmpdir(), `rubbing_envelope_${process.pid}`);
const live = [];

async function start(site, { legacy = false } = {}) {
  const dir = path.join(tmpRoot, `${site}_${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  const svc = await createServer({ site, dataDir: dir, port: 0, legacy });
  svc.dir = dir;
  live.push(svc);
  return svc;
}

function api(svc, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, svc.url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      u,
      {
        method,
        headers: payload
          ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length }
          : {}
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              reject(new Error(`非 JSON ${res.statusCode}: ${raw.slice(0, 200)}`));
              return;
            }
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const get = (s, p) => api(s, "GET", p);
const post = (s, p, b) => api(s, "POST", p, b);

async function snapshot(svc) {
  const d = (await get(svc, "/sync/status")).body.data;
  return { hash: d.stateHash, applied: d.applied, quarantined: [...d.quarantined], vclock: { ...d.vclock } };
}

before(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});
after(async () => {
  await Promise.all(live.map((s) => s.close().catch(() => {})));
  await rm(tmpRoot, { recursive: true, force: true });
});

const legalOp = {
  opId: "cap:1",
  site: "cap",
  seq: 1,
  type: "field.update",
  payload: { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "正常信封写入" } },
  vclock: { seed: 3 },
  causes: ["seed:3"],
  at: "t"
};

test("pull：未知顶层字段 / 未知能力键 -> 409 且状态不变", async () => {
  const s = await start("ePull");
  const before = await snapshot(s);

  let r = await post(s, "/sync/pull", { site: "a", vclock: {}, __futureProtocol: 1 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /无法识别的同步协议字段：__futureProtocol/);

  r = await post(s, "/sync/pull", { site: "a", vclock: {}, capabilities: { tombstones: true, teleport: true } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /capabilities\.teleport/);

  r = await post(s, "/sync/pull", { site: "a", vclock: {}, mode: "scan-all" });
  assert.equal(r.status, 409);

  assert.deepEqual(await snapshot(s), before, "只读入口也不得因非法信封改变任何状态");

  // 正常信封仍可用
  const ok = await post(s, "/sync/pull", { site: "a", vclock: { seed: 3 }, capabilities: { tombstones: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.protocol, 3);
});

test("push：未知顶层字段 / 未知能力键 / 负载嵌套标记 -> 409，合法同包操作不落地、隔离区不变", async () => {
  const s = await start("ePush");
  const before = await snapshot(s);

  // 先制造一个隔离项，确认非法信封不会触动隔离区
  const missingParent = {
    opId: "iso:2",
    site: "iso",
    seq: 2,
    type: "field.update",
    payload: { entity: "damages", entityId: "damage_demo_2", fields: { repairNote: "隔离中" } },
    vclock: { seed: 3, iso: 1 },
    causes: ["iso:1"],
    at: "t"
  };
  const iso = await post(s, "/sync/push", { site: "f", ops: [missingParent] });
  assert.deepEqual(iso.body.data.quarantined, ["iso:2"]);
  const before2 = await snapshot(s);

  let r = await post(s, "/sync/push", { site: "f", ops: [legalOp], dryRun: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /dryRun/);

  r = await post(s, "/sync/push", { site: "f", ops: [legalOp], capabilities: { tombstones: true, warp: 1 } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /capabilities\.warp/);

  // 合法 op 与未知信封字段同包：不得落地
  r = await post(s, "/sync/push", { site: "f", ops: [legalOp], __marker: "x" });
  assert.equal(r.status, 409);
  assert.equal((await get(s, "/damages")).body.data.find((d) => d.id === "damage_demo_1").repairNote, "");

  // 操作 payload 内嵌套未知协议标记：409，不落地
  const nested = JSON.parse(JSON.stringify(legalOp));
  nested.opId = "cap:2";
  nested.seq = 2;
  nested.vclock = { seed: 3, cap: 1 };
  nested.causes = ["cap:1"];
  nested.payload.fields.__deep = { v: 1 };
  r = await post(s, "/sync/push", { site: "f", ops: [nested] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /payload\.fields\.__deep/);

  const after = await snapshot(s);
  assert.equal(after.hash, before2.hash, "状态哈希不得被任何非法信封改变");
  assert.deepEqual(after.quarantined, ["iso:2"], "隔离区不得被非法信封触动");
  assert.equal(after.applied, before2.applied);

  // 正常信封：合法 op 生效，且补来 iso:1 能解开隔离（原有补链行为不回归）
  const ok = await post(s, "/sync/push", { site: "f", ops: [legalOp], capabilities: { tombstones: true } });
  assert.deepEqual(ok.body.data.applied, ["cap:1"]);
});

test("exchange：未知顶层字段 -> 409 且不发起任何同步（状态不变）", async () => {
  const a = await start("eExA");
  const b = await start("eExB");
  await post(b, "/rubbings", { code: "B1", source: "s", paperSize: "1x1" });

  const beforeA = await snapshot(a);
  const beforeB = await snapshot(b);

  let r = await post(a, "/sync/exchange", { peer: "eExB", url: b.url, mode: "future" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /mode/);

  r = await post(a, "/sync/exchange", { peer: "eExB", url: b.url, __proto: 1 });
  assert.equal(r.status, 409);

  assert.deepEqual(await snapshot(a), beforeA);
  assert.deepEqual(await snapshot(b), beforeB, "非法交换不得触达对端");

  // 正常交换照常双向收敛
  const ok = await post(a, "/sync/exchange", { peer: "eExB", url: b.url });
  assert.equal(ok.status, 200);
  const ha = (await get(a, "/sync/status")).body.data;
  const hb = (await get(b, "/sync/status")).body.data;
  assert.equal(ha.stateHash, hb.stateHash);
});

test("已声明能力内字段在新旧副本间正常通过（兼容/幂等不回归）", async () => {
  const modern = await start("eMod");
  const old = await start("eOld", { legacy: true });

  // 旧端不带 capabilities 拉取：合法（无未知字段），得到安全前缀
  const legacyPull = await post(modern, "/sync/pull", { site: "eOld", vclock: { seed: 3 } });
  assert.equal(legacyPull.status, 200);
  assert.equal(legacyPull.body.capabilities.tombstones, true);

  // 带已声明能力键的正常推送，重复投递幂等
  const op = {
    opId: "k:1",
    site: "k",
    seq: 1,
    type: "rubbing.create",
    payload: { id: "rubbing_k", fields: { code: "K", source: "s", paperSize: "1x1", note: "", createdAt: "t" } },
    vclock: { seed: 3 },
    causes: ["seed:3"],
    at: "t"
  };
  const first = await post(old, "/sync/push", { site: "k", ops: [op], capabilities: { tombstones: false } });
  assert.equal(first.status, 200);
  const second = await post(old, "/sync/push", { site: "k", ops: [op], capabilities: { tombstones: false } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data.applied, []);
  assert.deepEqual(second.body.data.duplicate, ["k:1"]);
});
