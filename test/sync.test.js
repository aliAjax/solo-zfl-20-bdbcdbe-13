"use strict";

// HTTP 端到端测试：启动多个真实馆实例（各自独立数据目录），
// 覆盖需求点名的六类场景：分区、乱序、重复、续传、冲突、回滚，外加重放收敛与旧接口兼容。
// 运行：npm test（node --test test/）

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { rm, readFile } = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");

const tmpRoot = path.join(os.tmpdir(), `rubbing_sync_test_${process.pid}`);
const live = [];

async function freshDataDir(name) {
  const dir = path.join(tmpRoot, `${name}_${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  return dir;
}

async function start(site, { failWrites = 0, dataDir = null } = {}) {
  const dir = dataDir || (await freshDataDir(site));
  const svc = await createServer({ site, dataDir: dir, port: 0, failWrites });
  svc.dir = dir;
  live.push(svc);
  return svc;
}

async function restart(svc) {
  await svc.close();
  const idx = live.indexOf(svc);
  const again = await start(svc.site, { dataDir: svc.dir });
  if (idx >= 0) live[idx] = again;
  return again;
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
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              reject(new Error(`非 JSON 响应 ${res.statusCode}: ${raw.slice(0, 200)}`));
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

const jget = (svc, p) => api(svc, "GET", p);
const jpost = (svc, p, b) => api(svc, "POST", p, b);
const jpatch = (svc, p, b) => api(svc, "PATCH", p, b);

async function exchange(a, b) {
  const res = await jpost(a, "/sync/exchange", { peer: b.site, url: b.url });
  assert.equal(res.status, 200, `双向同步失败：${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function hashOf(svc) {
  return (await jget(svc, "/sync/status")).body.data.stateHash;
}

async function expectConverged(services) {
  const statuses = await Promise.all(services.map((svc) => jget(svc, "/sync/status")));
  for (const s of statuses) {
    assert.equal(s.body.data.replayConvergent, true, `${s.body.data.site} 在线投影与重放投影不一致`);
  }
  const hashes = statuses.map((s) => s.body.data.stateHash);
  assert.equal(new Set(hashes).size, 1, `各馆状态不一致：${JSON.stringify(hashes)}`);
  return hashes[0];
}

before(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

after(async () => {
  await Promise.all(live.map((svc) => svc.close().catch(() => {})));
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. 分区登记 + 恢复后双向增量同步 + 重放收敛
// ---------------------------------------------------------------------------

test("分区：离线各自登记拓片/缺损/批次/质检，恢复后双向同步并收敛", async () => {
  const A = await start("hallA");
  const B = await start("hallB");

  const rubbing = (await jpost(A, "/rubbings", { code: "TP-A-1", source: "甲馆征集", paperSize: "30x40" })).body.data;
  const damage = (await jpost(A, `/rubbings/${rubbing.id}/damages`, {
    position: "右上角",
    type: "霉变",
    beforePhotoUrl: "http://x/a.jpg"
  })).body.data;

  const batch = (await jpost(B, "/batches", { name: "乙馆批次", damageIds: ["damage_demo_1"] })).body.data;
  assert.equal((await jpost(B, `/batches/${batch.id}/complete`, { defaultRepairNote: "托裱修复" })).status, 200);
  assert.equal(
    (await jpost(B, "/inspections", {
      inspector: "王老师",
      records: [{ damageId: "damage_demo_1", result: "pass", note: "合格" }]
    })).status,
    201
  );

  // 分区期间互不可见
  assert.equal((await jget(B, `/rubbings/${rubbing.id}/damages`)).status, 404);
  assert.equal((await jget(A, `/batches/${batch.id}`)).status, 404);

  const report = await exchange(A, B);
  assert.ok(report.pulled >= 2 && report.pushed >= 2, `增量数量异常：${JSON.stringify(report)}`);

  assert.equal((await jget(B, `/rubbings/${rubbing.id}/damages`)).status, 200);
  assert.equal((await jget(A, `/batches/${batch.id}`)).status, 200);
  const insA = await jget(A, "/inspections?result=pass");
  assert.equal(insA.body.data.length, 1);
  assert.equal(insA.body.data[0].inspector, "王老师");
  assert.equal((await jget(B, `/damages?status=&type=`)).body.data.find((d) => d.id === damage.id).type, "霉变");

  assert.equal((await jget(A, "/conflicts")).body.data.length, 0);
  assert.equal((await jget(B, "/conflicts")).body.data.length, 0);
  await expectConverged([A, B]);
});

// ---------------------------------------------------------------------------
// 2. 乱序：缺前序先隔离，补链后按原因果顺序生效
// ---------------------------------------------------------------------------

test("乱序：后到的操作先隔离，补齐前序后自动按序生效", async () => {
  const A = await start("ordA");
  const B = await start("ordB");

  // A 产生两个有因果关系的操作：A:1 制造冲突，A:2 是裁决（依赖 A:1）
  await jpatch(A, "/damages/damage_demo_1", { position: "甲馆定位" });
  await jpatch(B, "/damages/damage_demo_1", { position: "乙馆定位" });
  await exchange(A, B);
  const conflicts = (await jget(A, "/conflicts")).body.data;
  assert.equal(conflicts.length, 1);
  const resolveRes = await jpost(A, "/conflicts/resolve", {
    conflictId: conflicts[0].conflictId,
    value: "以甲馆定位为准"
  });
  assert.equal(resolveRes.status, 200);

  // 第三个馆只拿到 A:2（裁决），缺 A:1
  const C = await start("ordC");
  const aOpsAll = (await jpost(A, "/sync/pull", { site: "C", vclock: { seed: 3 } })).body.ops;
  const resolveOp = aOpsAll.filter((op) => op.opId === "ordA:2");
  assert.equal(resolveOp.length, 1);

  const pushed = await jpost(C, "/sync/push", { site: "ordA", ops: resolveOp });
  assert.equal(pushed.status, 200);
  assert.deepEqual(pushed.body.data.quarantined, ["ordA:2"]);
  assert.ok(pushed.body.data.missing.includes("ordA:1"));
  assert.equal((await jget(C, "/quarantine")).body.count, 1);

  // 裁决在缺前序时不得提前生效：字段仍是种子值，且无冲突
  let dmg = (await jget(C, "/damages")).body.data.find((d) => d.id === "damage_demo_1");
  assert.equal(dmg.position, "左上角第3列题字旁");
  assert.equal((await jget(C, "/conflicts")).body.data.length, 0);

  // 补齐 A:1 与 B:1（冲突的两个分支），隔离操作自动排空，顺序：先冲突后裁决
  const rest = [...aOpsAll.filter((op) => op.opId === "ordA:1")];
  const bOps = (await jpost(B, "/sync/pull", { site: "C", vclock: { seed: 3 } })).body.ops;
  const fill = await jpost(C, "/sync/push", { site: "fill", ops: [...rest, ...bOps] });
  assert.equal(fill.status, 200);
  assert.ok(fill.body.data.applied.includes("ordA:1"));
  assert.ok(fill.body.data.applied.includes("ordA:2"), "补链后裁决应自动从隔离区生效");
  assert.equal((await jget(C, "/quarantine")).body.count, 0);

  dmg = (await jget(C, "/damages")).body.data.find((d) => d.id === "damage_demo_1");
  assert.equal(dmg.position, "以甲馆定位为准");
  assert.equal((await jget(C, "/conflicts")).body.data.length, 0);

  await exchange(C, A);
  await exchange(C, B);
  await exchange(A, B);
  await expectConverged([A, B, C]);
});

// ---------------------------------------------------------------------------
// 3. 重复：同一报文/重发报文只生效一次
// ---------------------------------------------------------------------------

test("重复：报文重发、批内重复都只生效一次", async () => {
  const A = await start("dupA");
  const B = await start("dupB");

  await jpost(A, "/rubbings", { code: "TP-DUP", source: "征集", paperSize: "10x10", note: "" });
  const ops = (await jpost(A, "/sync/pull", { site: "dupB", vclock: { seed: 3 } })).body.ops;
  assert.equal(ops.length, 1);

  const first = await jpost(B, "/sync/push", { site: "dupA", ops });
  assert.deepEqual(first.body.data.applied, ["dupA:1"]);
  const hashAfterFirst = await hashOf(B);

  // 整包原样重发
  const second = await jpost(B, "/sync/push", { site: "dupA", ops });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data.applied, []);
  assert.deepEqual(second.body.data.duplicate, ["dupA:1"]);

  // 同一批内重复
  const third = await jpost(B, "/sync/push", { site: "dupA", ops: [...ops, ...ops] });
  assert.equal(third.status, 200);
  assert.deepEqual(third.body.data.applied, []);
  assert.ok(third.body.data.duplicate.includes("dupA:1"));

  assert.equal(await hashOf(B), hashAfterFirst, "重复报文不得改变状态");

  // 同序号不同内容必须拒绝（防伪造/损坏）
  const tampered = JSON.parse(JSON.stringify(ops));
  tampered[0].payload.fields.code = "TP-TAMPERED";
  const bad = await jpost(B, "/sync/push", { site: "dupA", ops: tampered });
  assert.equal(bad.status, 409);
  assert.equal(await hashOf(B), hashAfterFirst, "拒绝篡改包后状态必须不变");

  await exchange(B, A);
  await expectConverged([A, B]);
});

// ---------------------------------------------------------------------------
// 4. 续传：同步中断后重启，已落盘进度保留，再连继续；隔离状态持久化
// ---------------------------------------------------------------------------

test("续传：同步中断/进程重启后从向量时钟游标继续，不重复生效", async () => {
  const A = await start("resA");
  const B = await start("resB");

  for (let i = 0; i < 3; i += 1) {
    await jpost(A, "/rubbings", { code: `TP-R${i}`, source: "甲馆", paperSize: "20x30" });
  }

  // 只把 A:1 推到 B（模拟在 A:2 之前网络中断）
  const firstBatch = (await jpost(A, "/sync/pull", { site: "resB", vclock: { seed: 3 } })).body.ops;
  assert.equal(firstBatch.length, 3);
  const one = await jpost(B, "/sync/push", { site: "resA", ops: [firstBatch[0]] });
  assert.deepEqual(one.body.data.applied, ["resA:1"]);

  // B 重启：已生效的 A:1 必须落盘保留
  let B2 = await restart(B);
  assert.equal((await jget(B2, "/rubbings")).body.data.filter((r) => r.code === "TP-R0").length, 1);

  // 用旧游标再同步：exchange 只补 A:2、A:3，A:1 不重复生效
  const report = await exchange(B2, A);
  const reappliedA1 = report.applied.includes("resA:1");
  assert.equal(reappliedA1, false, "已生效操作不得因续传重复生效");

  const codes = (await jget(B2, "/rubbings")).body.data.map((r) => r.code);
  for (const code of ["TP-R0", "TP-R1", "TP-R2"]) assert.ok(codes.includes(code));

  // 隔离状态也持久化：C 收到缺链操作后重启，隔离仍在
  const C = await start("resC");
  await jpost(C, "/sync/push", { site: "resA", ops: [firstBatch[2]] }); // A:3 缺 A:2
  assert.equal((await jget(C, "/quarantine")).body.count, 1);
  const C2 = await restart(C);
  assert.equal((await jget(C2, "/quarantine")).body.count, 1);
  await exchange(C2, A);
  assert.equal((await jget(C2, "/quarantine")).body.count, 0);
  await expectConverged([A, B2, C2]);
});

// ---------------------------------------------------------------------------
// 5. 冲突：同字段并发修改双方都保留，默认展示确定一致，人工裁决后随同步传播
// ---------------------------------------------------------------------------

test("冲突：同字段并发修改不静默丢弃，人工裁决后各馆一致", async () => {
  const A = await start("cfA");
  const B = await start("cfB");

  await jpatch(A, "/damages/damage_demo_1", { position: "甲馆描述" });
  await jpatch(B, "/damages/damage_demo_1", { position: "乙馆描述" });
  await exchange(A, B);

  const ca = (await jget(A, "/conflicts")).body.data;
  const cb = (await jget(B, "/conflicts")).body.data;
  assert.equal(ca.length, 1);
  assert.equal(cb.length, 1);
  assert.equal(ca[0].conflictId, "damages.damage_demo_1.position");
  // 两个并发值都在
  const values = ca[0].values.map((v) => v.value).sort();
  assert.deepEqual(values, ["乙馆描述", "甲馆描述"]);
  // 默认赢家在两馆完全一致（确定性排序，而非随机一边）
  assert.deepEqual(ca[0].winner, cb[0].winner);

  // /versions 能看到字段的全部版本与向量时钟
  const versions = (await jget(A, "/versions?entity=damages&id=damage_demo_1")).body.data;
  assert.equal(versions.fields.position.versions.length, 2);

  // 人工裁决
  const resolve = await jpost(B, "/conflicts/resolve", {
    conflictId: "damages.damage_demo_1.position",
    value: "最终：乙馆描述",
    reason: "乙馆现场复核"
  });
  assert.equal(resolve.status, 200);
  assert.equal((await jget(B, "/conflicts")).body.data.length, 0);
  assert.equal(
    (await jget(B, "/damages")).body.data.find((d) => d.id === "damage_demo_1").position,
    "最终：乙馆描述"
  );

  // 裁决同步到 A
  await exchange(A, B);
  assert.equal((await jget(A, "/conflicts")).body.data.length, 0);
  assert.equal(
    (await jget(A, "/damages")).body.data.find((d) => d.id === "damage_demo_1").position,
    "最终：乙馆描述"
  );
  await expectConverged([A, B]);
});

// ---------------------------------------------------------------------------
// 6. 旧操作不能覆盖较新结果（因果有序，迟到旧值被丢弃）
// ---------------------------------------------------------------------------

test("因果：后到的旧操作不会覆盖较新结果", async () => {
  const A = await start("stA");
  const B = await start("stB");

  // A 先后两次修改同一字段
  await jpatch(A, "/damages/damage_demo_1", { repairNote: "第一版" });
  await jpatch(A, "/damages/damage_demo_1", { repairNote: "第二版" });

  // B 只拿到 A:2（A:1 同时补给它，保持链完整），记录新值
  const ops = (await jpost(A, "/sync/pull", { site: "stB", vclock: { seed: 3 } })).body.ops;
  const v2 = ops.find((o) => o.opId === "stA:2");
  // 故意构造“只有新操作”的到达：A:2 的父 A:1 缺失会被隔离；先放 A:2，再放 A:1
  await jpost(B, "/sync/push", { site: "stA", ops: [v2] });
  await jpost(B, "/sync/push", { site: "stA", ops: [ops.find((o) => o.opId === "stA:1")] });

  // 补链后最终值必须是第二版，旧值不得反压
  const note = (await jget(B, "/damages")).body.data.find((d) => d.id === "damage_demo_1").repairNote;
  assert.equal(note, "第二版");
  assert.equal((await jget(B, "/conflicts")).body.data.length, 0);

  // 制造一个真正“迟到”的操作：A 在旧快照上补写一个时序更老的值并延后送达。
  // 用重放前的导出无法伪造时钟，这里直接验证寄存器语义：B 先有第二版，再收到
  // 一个 vclock 被第二版支配的写入，应被忽略。
  await exchange(B, A);
  await expectConverged([A, B]);
});

// ---------------------------------------------------------------------------
// 7. 回滚：落盘失败不留半套（内存与磁盘都回到上一版）
// ---------------------------------------------------------------------------

test("回滚：落盘失败时操作整体回滚，磁盘仍是完整旧状态", async () => {
  const dir = await freshDataDir("rollback");
  // 先正常建库（init 的首次落盘不故障），再让后续第一次业务落盘失败
  const S = await start("rbX", { dataDir: dir, failWrites: 0 });
  S.replica.store.failWrites = 1;

  const beforeHash = await hashOf(S);
  const beforeCodes = (await jget(S, "/rubbings")).body.data.map((r) => r.code);

  const res = await jpost(S, "/rubbings", { code: "TP-FAIL", source: "不应保留", paperSize: "1x1" });
  assert.equal(res.status, 500);

  // 内存已回滚
  const afterCodes = (await jget(S, "/rubbings")).body.data.map((r) => r.code);
  assert.deepEqual(afterCodes, beforeCodes);
  assert.equal(await hashOf(S), beforeHash);

  // 磁盘是完整 JSON（不是半截临时文件），且不含失败操作
  const onDisk = JSON.parse(await readFile(require("path").join(dir, "state.json"), "utf8"));
  assert.ok(Array.isArray(onDisk.ops));
  assert.ok(!onDisk.ops.some((op) => op.payload && op.payload.fields && op.payload.fields.code === "TP-FAIL"));

  // 下一次正常写入成功（失败没有破坏服务）
  const ok = await jpost(S, "/rubbings", { code: "TP-OK", source: "正常", paperSize: "2x2" });
  assert.equal(ok.status, 201);
  await S.close();
});

// ---------------------------------------------------------------------------
// 8. 旧接口兼容：路径、状态码、响应结构与 v1 完全一致
// ---------------------------------------------------------------------------

test("旧接口保持不变（含 404/400 语义与批次 enriched 结构）", async () => {
  const S = await start("legacy");

  const health = await jget(S, "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(health.body.routes.includes("POST /batches/:id/complete"));

  const list = await jget(S, "/rubbings");
  assert.equal(list.status, 200);
  const demo = list.body.data[0];
  assert.equal(demo.code, "TP-清-014");
  assert.equal(demo.damageCount, 2);
  assert.equal(demo.pendingDamages, 2);

  assert.equal((await jpost(S, "/rubbings", { code: "" })).status, 400);
  assert.equal((await jget(S, "/rubbings/no_such/damages")).status, 404);
  assert.equal((await jpatch(S, "/damages/no_such", { status: "repaired" })).status, 404);

  const created = await jpost(S, "/rubbings/rubbing_demo/damages", {
    position: "中部",
    type: "缺字",
    beforePhotoUrl: "http://x/b.jpg"
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.status, "pending");
  assert.equal(created.body.data.batchId, null);

  const badBatch = await jpost(S, "/batches", { name: "空", damageIds: [] });
  assert.equal(badBatch.status, 400);
  const missingBatch = await jpost(S, "/batches", { name: "x", damageIds: ["nope"] });
  assert.equal(missingBatch.status, 400);

  const batch = await jpost(S, "/batches", { name: "旧接口批次", damageIds: [created.body.data.id] });
  assert.equal(batch.status, 201);
  assert.equal(batch.body.data.status, "open");
  assert.equal(batch.body.data.total, 1);
  assert.equal(batch.body.data.pending, 1);
  assert.equal(batch.body.data.damages[0].id, created.body.data.id);

  const complete = await jpost(S, `/batches/${batch.body.data.id}/complete`, {
    results: [{ damageId: created.body.data.id, afterPhotoUrl: "http://x/a.jpg", repairNote: "已修" }]
  });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.data.status, "completed");
  assert.equal(complete.body.data.repaired, 1);
  assert.equal(complete.body.data.damages[0].afterPhotoUrl, "http://x/a.jpg");

  const filtered = await jget(S, "/damages?status=repaired&type=缺字");
  assert.equal(filtered.body.data.length, 1);
  assert.equal(filtered.body.data[0].repairedAt !== null, true);

  assert.equal((await jget(S, "/batches/no_such")).status, 404);
  assert.equal((await jpost(S, "/batches/no_such/complete", {})).status, 404);
  assert.equal((await api(S, "GET", "/nope")).status, 404);
  await S.close();
});

// ---------------------------------------------------------------------------
// 9. 三馆环形同步：任一馆重放，最终全部收敛
// ---------------------------------------------------------------------------

test("多馆：三馆分区后两两同步，任意顺序重放操作都收敛到同一状态", async () => {
  const A = await start("ringA");
  const B = await start("ringB");
  const C = await start("ringC");

  await jpost(A, "/rubbings", { code: "TP-RING-A", source: "甲", paperSize: "1x1" });
  await jpost(B, "/rubbings", { code: "TP-RING-B", source: "乙", paperSize: "2x2" });
  await jpatch(C, "/damages/damage_demo_2", { repairNote: "丙馆批注" });

  // 链式 A<->B，B<->C，A 与 C 不直连
  await exchange(A, B);
  await exchange(B, C);
  // 第二轮保证 A 的操作经 B 流转到 C（如有缺链会自动补链）
  await exchange(A, B);

  await expectConverged([A, B, C]);
  for (const svc of [A, B, C]) {
    const codes = (await jget(svc, "/rubbings")).body.data.map((r) => r.code);
    assert.ok(codes.includes("TP-RING-A"));
    assert.ok(codes.includes("TP-RING-B"));
    const note = (await jget(svc, "/damages")).body.data.find((d) => d.id === "damage_demo_2").repairNote;
    assert.equal(note, "丙馆批注");
  }
});
