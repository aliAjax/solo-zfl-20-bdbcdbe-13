"use strict";

// HTTP 跨版本混用回归：
//   新副本（tombstones 能力）与旧副本（legacy，不识别墓碑协议）通过真实 HTTP 同步。
//   - 旧副本 pull 不带 capabilities -> 新副本只给安全前缀，旧端不会因墓碑整包失败；
//   - /sync/status、pull/push 响应带 protocol 与 capabilities，可识别对端能力；
//   - 未知协议标记发给新副本 -> 409 且已落盘状态不变；
//   - 旧副本“升级”为新版后再全量同步，墓碑与后继补齐，最终收敛一致。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { rm } = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");

const tmpRoot = path.join(os.tmpdir(), `rubbing_xver_${process.pid}`);
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
const patch = (s, p, b) => api(s, "PATCH", p, b);

// 直接向某副本注入“坏后继先隔离再补前序”，制造一个墓碑
async function plantTombstone(svc) {
  const x2 = {
    opId: "x:2",
    site: "x",
    seq: 2,
    type: "field.update",
    payload: { entity: "damages", entityId: "damage_x_ghost", fields: { status: "repaired" } },
    vclock: { seed: 3, x: 1 },
    causes: ["x:1"],
    at: "t"
  };
  const x1 = {
    opId: "x:1",
    site: "x",
    seq: 1,
    type: "rubbing.create",
    payload: { id: "rubbing_x", fields: { code: "CV", source: "s", paperSize: "1x1", note: "", createdAt: "t" } },
    vclock: { seed: 3 },
    causes: ["seed:3"],
    at: "t"
  };
  const x3 = {
    opId: "x:3",
    site: "x",
    seq: 3,
    type: "field.update",
    payload: { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "X3后继" } },
    vclock: { seed: 3, x: 2 },
    causes: ["x:2"],
    at: "t"
  };
  await post(svc, "/sync/push", { site: "feeder", ops: [x2] });
  await post(svc, "/sync/push", { site: "feeder", ops: [x1] }); // x2 -> 墓碑
  await post(svc, "/sync/push", { site: "feeder", ops: [x3] });
  return { x1, x2, x3 };
}

before(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});
after(async () => {
  await Promise.all(live.map((s) => s.close().catch(() => {})));
  await rm(tmpRoot, { recursive: true, force: true });
});

test("状态/同步信封声明 protocol 与 capabilities", async () => {
  const modern = await start("mStatus");
  const old = await start("oStatus", { legacy: true });
  const m = (await get(modern, "/sync/status")).body.data;
  const o = (await get(old, "/sync/status")).body.data;
  assert.equal(m.protocol, 3);
  assert.equal(m.capabilities.tombstones, true);
  assert.equal(o.protocol, 2, "旧副本上报其真实协议版本");
  assert.equal(o.capabilities.tombstones, false);

  const pull = await post(modern, "/sync/pull", { site: "probe", vclock: { seed: 3 }, capabilities: { tombstones: true } });
  assert.equal(pull.body.protocol, 3);
  assert.equal(pull.body.capabilities.tombstones, true);
});

test("旧副本从不带能力的 pull 中只拿到安全前缀，消费不整包失败", async () => {
  const modern = await start("mPull");
  await plantTombstone(modern);
  assert.equal((await get(modern, "/sync/status")).body.data.invalid.map((i) => i.opId)[0], "x:2");

  const old = await start("oPull", { legacy: true });

  // 模拟真实旧副本：pull 请求不带 capabilities 字段
  const legacyPull = await post(modern, "/sync/pull", { site: "oPull", vclock: { seed: 3 } });
  assert.equal(legacyPull.status, 200);
  const ops = legacyPull.body.ops;
  assert.deepEqual(ops.map((o) => o.opId), ["x:1"], "旧端只能看到墓碑前的连续前缀");
  assert.equal(ops.some((o) => o.__invalid), false, "旧端不得收到墓碑标记");

  // 旧副本 push 这份数据必须成功（旧缺陷场景：拿到墓碑会当普通操作执行而整包失败）
  const pushed = await post(old, "/sync/push", { site: "mPull", ops });
  assert.equal(pushed.status, 200, `旧副本应用安全前缀失败：${JSON.stringify(pushed.body)}`);
  assert.deepEqual(pushed.body.data.rejected, []);
  assert.equal((await get(old, "/rubbings")).body.data.some((r) => r.id === "rubbing_x"), true);
  assert.equal((await get(old, "/quarantine")).body.count, 0, "旧端不应被坏操作卡住");
});

test("未知协议标记发给新副本：409 且不改任何已落盘状态", async () => {
  const modern = await start("mFail");
  const before = (await get(modern, "/sync/status")).body.data.stateHash;

  const future = {
    opId: "z:1",
    site: "z",
    seq: 1,
    type: "field.update",
    payload: { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "未来协议" } },
    vclock: { seed: 3 },
    causes: ["seed:3"],
    at: "t",
    __newFeatureV9: { algorithm: "unknown" }
  };
  const res = await post(modern, "/sync/push", { site: "future", ops: [future] });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /无法识别的协议字段：__newFeatureV9/);

  const after = (await get(modern, "/sync/status")).body.data;
  assert.equal(after.stateHash, before, "fail-closed 不得改变已落盘状态");
  assert.equal(after.applied, 3, "只有种子操作生效");
  assert.equal((await get(modern, "/damages")).body.data.find((d) => d.id === "damage_demo_1").repairNote, "");
});

test("新副本间带能力同步，墓碑传播并收敛", async () => {
  const a = await start("mA");
  await plantTombstone(a);
  const b = await start("mB");

  const report = await post(a, "/sync/exchange", { peer: "mB", url: b.url });
  assert.equal(report.status, 200, JSON.stringify(report.body));

  const ha = (await get(a, "/sync/status")).body.data;
  const hb = (await get(b, "/sync/status")).body.data;
  assert.equal(ha.stateHash, hb.stateHash, "新副本带墓碑收敛一致");
  assert.deepEqual(hb.invalid.map((i) => i.opId), ["x:2"]);
  assert.equal(hb.replayConvergent, true);
});

test("旧副本升级为新版后全量补齐，最终与新副本收敛", async () => {
  const modern = await start("mUp");
  await plantTombstone(modern);

  // 升级前：旧副本只拿到安全前缀 x:1
  let old = await start("oUp", { legacy: true });
  const oldDir = old.dir;
  const pre = await post(modern, "/sync/pull", { site: "oUp", vclock: { seed: 3 } });
  assert.deepEqual(pre.body.ops.map((o) => o.opId), ["x:1"]);
  await post(old, "/sync/push", { site: "mUp", ops: pre.body.ops });

  // “升级”：用同一份数据目录以新版（非 legacy）重启
  await old.close();
  const upgraded = await createServer({ site: "oUp", dataDir: oldDir, port: 0, legacy: false });
  live.push(upgraded);

  // 升级后声明 tombstones 能力，一次交换补齐 x:2 墓碑与 x:3 后继
  const report = await post(upgraded, "/sync/exchange", { peer: "mUp", url: modern.url });
  assert.equal(report.status, 200, JSON.stringify(report.body));

  const hm = (await get(modern, "/sync/status")).body.data;
  const hu = (await get(upgraded, "/sync/status")).body.data;
  assert.equal(hu.stateHash, hm.stateHash, "升级并补齐后必须收敛一致");
  assert.deepEqual(hu.invalid.map((i) => i.opId), ["x:2"]);
  assert.equal(
    (await get(upgraded, "/damages")).body.data.find((d) => d.id === "damage_demo_1").repairNote,
    "X3后继"
  );
  assert.equal((await get(upgraded, "/quarantine")).body.count, 0);
});

test("旧业务接口在 legacy 与新副本上都不受协议协商影响", async () => {
  for (const legacy of [true, false]) {
    const s = await start(`biz${legacy ? "Old" : "New"}`, { legacy });
    const created = await post(s, "/rubbings/rubbing_demo/damages", {
      position: "中部",
      type: "缺字",
      beforePhotoUrl: "http://x/b.jpg"
    });
    assert.equal(created.status, 201);
    const batch = await post(s, "/batches", { name: "b", damageIds: [created.body.data.id] });
    assert.equal(batch.status, 201);
    assert.equal(batch.body.data.total, 1);
    const p = await patch(s, `/damages/${created.body.data.id}`, { status: "repaired", repairNote: "ok" });
    assert.equal(p.status, 200);
    assert.equal(p.body.data.status, "repaired");
  }
});

test("新副本经 exchange 主动连旧副本：只推安全前缀，旧端健康不卡死", async () => {
  const modern = await start("mEx");
  await plantTombstone(modern); // 含 x:2 墓碑、x:3 后继
  const old = await start("oEx", { legacy: true });
  // 旧端先有一点自己的合法数据
  await post(old, "/rubbings", { code: "OLD-1", source: "旧馆", paperSize: "9x9" });

  // 新副本作为 exchange 发起方连旧端
  const report = await post(modern, "/sync/exchange", { peer: "oEx", url: old.url });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.data.peerCapabilities.tombstones, false, "应识别对端是旧协议");

  // 旧端只收到 x:1，收不到墓碑 x:2 / 后继 x:3 -> 无隔离、无报错
  assert.equal((await get(old, "/quarantine")).body.count, 0);
  assert.equal((await get(old, "/rubbings")).body.data.some((r) => r.id === "rubbing_x"), true);
  const oldDamages = (await get(old, "/damages")).body.data;
  assert.equal(oldDamages.find((d) => d.id === "damage_demo_1").repairNote, "", "旧端不应收到墓碑后的 x:3");
  const oldStatus = (await get(old, "/sync/status")).body.data;
  assert.deepEqual(oldStatus.invalid, []);
  assert.equal(oldStatus.replayConvergent, true);

  // 新副本收到了旧端的合法数据
  assert.equal((await get(modern, "/rubbings")).body.data.some((r) => r.code === "OLD-1"), true);
});
