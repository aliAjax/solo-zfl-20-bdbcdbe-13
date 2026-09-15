"use strict";

// 回归测试（针对两处多馆同步缺陷）：
//   缺陷一：同一组操作只改投递顺序，在线/重放状态或冲突集合可能不同，甚至丢冲突。
//   缺陷二：同步入口收到“合法 + 非法字段”混合操作时，响应拒绝但合法字段已写入。
//
// 修复后：任意投递顺序得到同一状态哈希与同一冲突集合，在线==重放；被拒操作整包不生效。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { rm } = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");

const tmpRoot = path.join(os.tmpdir(), `rubbing_regression_${process.pid}`);
const live = [];

async function start(site, dataDir = null) {
  const dir = dataDir || path.join(tmpRoot, `${site}_${Math.random().toString(36).slice(2, 8)}`);
  await rm(dir, { recursive: true, force: true });
  const svc = await createServer({ site, dataDir: dir, port: 0 });
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

// 确定性洗牌
function shuffled(arr, seed) {
  const a = [...arr];
  let x = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function signature(svc) {
  return get(svc, "/sync/status").then((r) => {
    const d = r.body.data;
    return { hash: d.stateHash, replay: d.replayHash, convergent: d.replayConvergent, conflicts: d.conflicts };
  });
}

async function conflictSet(svc) {
  const r = await get(svc, "/conflicts");
  return r.body.data
    .map((c) => `${c.conflictId}={${c.values.map((v) => v.value).sort().join("|")}}`)
    .sort();
}

before(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

after(async () => {
  await Promise.all(live.map((s) => s.close().catch(() => {})));
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 缺陷一回归：两个并发分支 + 裁决 + 裁决后又一条并发分支；
// 同一组操作，改变投递顺序与分批，结果（状态哈希、冲突集合、在线==重放）必须完全一致。
// ---------------------------------------------------------------------------

test("回归一：任意投递顺序/分批 -> 同一状态、同一冲突集合、在线==重放", async () => {
  // 用两个产生方构造操作全集
  const P = await start("regP");
  const Q = await start("regQ");

  // 冲突双方
  await patch(P, "/damages/damage_demo_1", { position: "P方位置" });
  await patch(Q, "/damages/damage_demo_1", { position: "Q方位置" });
  // 先互相同步，让 P 能基于双方做裁决，Q 再在裁决上下文之外补一条并发写
  await post(P, "/sync/exchange", { peer: "regQ", url: Q.url });
  const c0 = (await get(P, "/conflicts")).body.data;
  assert.equal(c0.length, 1);
  await post(P, "/conflicts/resolve", { conflictId: c0[0].conflictId, value: "裁决位置" });
  // Q 拉到裁决前，先基于旧认知再改一次（与裁决并发）
  await patch(Q, "/damages/damage_demo_1", { position: "Q方后续位置" });

  // 收集操作全集（去重）
  const pull = (s, vclock) => post(s, "/sync/pull", { site: "collector", vclock });
  const fromP = (await pull(P, { seed: 3 })).body.ops;
  const fromQ = (await pull(Q, { seed: 3 })).body.ops;
  const all = [];
  const seen = new Set();
  for (const op of [...fromP, ...fromQ]) {
    if (!seen.has(op.opId)) {
      seen.add(op.opId);
      all.push(op);
    }
  }
  assert.ok(all.length >= 4, `操作全集异常：${all.map((o) => o.opId).join(",")}`);

  // 用多种顺序/分批投递到互相独立的空馆
  const plans = [
    { name: "原序单批", chunks: [all] },
    { name: "倒序单批", chunks: [shuffled(all, 999983).reverse()] },
    { name: "乱序单批a", chunks: [shuffled(all, 7)] },
    { name: "乱序单批b", chunks: [shuffled(all, 4242)] },
    { name: "乱序逐条", chunks: shuffled(all, 131).map((op) => [op]) },
    {
      name: "乱序每2条一批",
      chunks: (() => {
        const order = shuffled(all, 2026);
        const out = [];
        for (let i = 0; i < order.length; i += 2) out.push(order.slice(i, i + 2));
        return out;
      })()
    },
    {
      name: "裁决先到再补分支",
      chunks: (() => {
        const resolve = all.filter((o) => o.type === "conflict.resolve");
        const rest = all.filter((o) => o.type !== "conflict.resolve");
        // 第一批只送裁决（缺前序应被隔离），之后乱序补齐
        return [resolve, ...shuffled(rest, 555).map((op) => [op])];
      })()
    }
  ];

  const baselines = [];
  for (const plan of plans) {
    const viewer = await start(`v_${plan.name}`.replace(/[^a-zA-Z0-9_]/g, "_"));
    for (const chunk of plan.chunks) {
      const res = await post(viewer, "/sync/push", { site: "feeder", ops: chunk });
      // 单个 chunk 内可能因缺前序而隔离（200），但绝不应出现“合法被部分写入”的 409，
      // 因为本计划里的操作在因果合法顺序下都应可应用。
      assert.equal(res.status, 200, `${plan.name} 推送异常：${JSON.stringify(res.body)}`);
    }
    const sig = await signature(viewer);
    const conflicts = await conflictSet(viewer);
    assert.equal(sig.convergent, true, `${plan.name}：在线与重放不一致`);
    assert.equal(sig.hash, sig.replay, `${plan.name}：stateHash != replayHash`);
    baselines.push({ name: plan.name, sig, conflicts });
  }

  // 所有投递方式的最终状态哈希与冲突集合必须完全一致
  const baseHash = baselines[0].sig.hash;
  const baseConflicts = JSON.stringify(baselines[0].conflicts);
  for (const b of baselines) {
    assert.equal(b.sig.hash, baseHash, `状态随投递顺序变化：${b.name}`);
    assert.equal(JSON.stringify(b.conflicts), baseConflicts, `冲突集合随投递顺序变化：${b.name} -> ${b.conflicts}`);
  }
  // 本场景终态：裁决与 Q 的后续并发写形成且仅形成一个双值冲突（冲突没被顺序吃掉）
  const finalConflicts = baselines[0].conflicts;
  assert.equal(finalConflicts.length, 1, `终态冲突数异常：${JSON.stringify(finalConflicts)}`);
  assert.match(finalConflicts[0], /裁决位置/);
  assert.match(finalConflicts[0], /Q方后续位置/);
});

// ---------------------------------------------------------------------------
// 缺陷二回归：同一报文含合法操作与非法字段操作 -> 整包 409，合法操作也不落地；
// 去掉非法项重发 -> 成功且只生效一次。
// ---------------------------------------------------------------------------

test("回归二：合法+非法混合报文整包不生效，重发合法包成功且幂等", async () => {
  const S = await start("atom");

  // 从一个产生方取一条真实合法操作，再构造一条同包非法操作（合法字段 + 非法字段）
  await post(S, "/rubbings", { code: "TP-X", source: "s", paperSize: "1x1" }).catch(() => {});
  // 直接在同步入口构造混合包：
  const legal = {
    opId: "extA:1",
    site: "extA",
    seq: 1,
    type: "rubbing.create",
    payload: { id: "rubbing_legal", fields: { code: "TP-LEGAL", source: "s", paperSize: "1x1", note: "", createdAt: "t" } },
    vclock: { seed: 3 },
    causes: ["seed:3"],
    at: "t"
  };
  const illegal = {
    opId: "extA:2",
    site: "extA",
    seq: 2,
    type: "field.update",
    payload: {
      entity: "damages",
      entityId: "damage_demo_1",
      fields: { repairNote: "同包的合法字段", notARealField: "非法字段" }
    },
    vclock: { seed: 3, extA: 1 },
    causes: ["extA:1"],
    at: "t"
  };

  const before = (await get(S, "/sync/status")).body.data.stateHash;
  const rejected = await post(S, "/sync/push", { site: "extA", ops: [legal, illegal] });
  assert.equal(rejected.status, 409, `应整包拒绝，实际 ${rejected.status}`);
  assert.match(rejected.body.error, /不可写字段：notARealField/);

  // 合法操作与合法字段都不得落地
  const rubbings = (await get(S, "/rubbings")).body.data;
  assert.equal(rubbings.some((r) => r.id === "rubbing_legal"), false, "合法操作被部分写入");
  const dmg = (await get(S, "/damages")).body.data.find((d) => d.id === "damage_demo_1");
  assert.equal(dmg.repairNote, "", "合法字段被部分写入");
  assert.equal(dmg.notARealField, undefined);
  assert.equal((await get(S, "/sync/status")).body.data.stateHash, before, "状态哈希被失败报文改变");

  // 去掉非法项重发：成功，且重复再发只生效一次
  const ok = await post(S, "/sync/push", { site: "extA", ops: [legal] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data.applied, ["extA:1"]);
  const again = await post(S, "/sync/push", { site: "extA", ops: [legal] });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.data.applied, []);
  assert.deepEqual(again.body.data.duplicate, ["extA:1"]);
  assert.equal((await get(S, "/rubbings")).body.data.some((r) => r.id === "rubbing_legal"), true);

  // 在线==重放
  const st = (await get(S, "/sync/status")).body.data;
  assert.equal(st.replayConvergent, true);
});

// ---------------------------------------------------------------------------
// 缺陷二补充：单条操作内部多字段，非法字段不得让同条的合法字段落地（PATCH 路径不受影响）
// ---------------------------------------------------------------------------

test("回归二补充：旧 PATCH 接口只接受白名单字段，行为不变", async () => {
  const S = await start("atomlegacy");
  const res = await patch(S, "/damages/damage_demo_1", { repairNote: "正常修改", isAdmin: true });
  assert.equal(res.status, 200);
  const dmg = res.body.data;
  assert.equal(dmg.repairNote, "正常修改");
  assert.equal(dmg.isAdmin, undefined, "非白名单字段不得写入");
});
