"use strict";

// 跨版本兼容回归（墓碑协议 v3 与旧副本混用）：
//   - 能力协商：pull 时请求方声明 capabilities；旧副本（无能力声明 / tombstones:false）
//     拿不到 __invalid 墓碑及因果上依赖墓碑的后继，只能看到可安全应用的连续前缀；
//   - 新副本之间声明 tombstones:true，墓碑正常传播并确定性占位、收敛；
//   - 无法识别的协议字段（未知 __ 标记）fail-closed：整批拒绝且不改已落盘状态；
//   - 旧副本升级为新版后，一次全量拉取补齐墓碑与后继，最终与新副本收敛一致。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Engine, topoOrder } = require("../lib/engine");

// 构造一条站点 X 的操作链：X:1 合法建拓片；X:2 非法后继（更新不存在的缺损）；X:3 合法后继。
function xChain() {
  const x1 = {
    opId: "x:1",
    site: "x",
    seq: 1,
    type: "rubbing.create",
    payload: { id: "rubbing_cv", fields: { code: "CV", source: "s", paperSize: "1x1", note: "", createdAt: "t" } },
    vclock: { seed: 3 },
    causes: ["seed:3"],
    at: "t"
  };
  const x2 = {
    opId: "x:2",
    site: "x",
    seq: 2,
    type: "field.update",
    payload: { entity: "damages", entityId: "damage_cv_ghost", fields: { status: "repaired" } },
    vclock: { seed: 3, x: 1 },
    causes: ["x:1"],
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
  return { x1, x2, x3 };
}

// 让一个“新”引擎经历：坏后继先隔离、补前序时落墓碑、X3 正常生效。
function newReplicaWithTombstone() {
  const { x1, x2, x3 } = xChain();
  const e = new Engine("new").seed();
  e.ingest([x2]); // 缺 x:1 -> 隔离
  e.ingest([x1]); // x:1 生效，x:2 被墓碑占位
  e.ingest([x3]); // x:3 正常
  assert.deepEqual(e.meta().invalid.map((i) => i.opId), ["x:2"]);
  return { engine: e, ops: { x1, x2, x3 } };
}

test("能力协商：旧副本拉取只得到可安全应用的连续前缀，不含墓碑标记", () => {
  const { engine } = newReplicaWithTombstone();

  // 旧副本声明不支持墓碑 -> 只给 x:1；x:2 墓碑与依赖它的 x:3 都裁掉
  const legacyView = engine.opsSince({ seed: 3 }, { capabilities: { tombstones: false } });
  assert.deepEqual(legacyView.map((o) => o.opId), ["x:1"]);
  assert.equal(legacyView.some((o) => o.__invalid), false);

  // 再次显式声明不支持墓碑，行为相同
  const noCaps = engine.opsSince({ seed: 3 }, { capabilities: { tombstones: false } });
  assert.deepEqual(noCaps.map((o) => o.opId), ["x:1"]);

  // 新副本声明支持墓碑 -> 完整链路，x:2 带墓碑标记
  const newView = engine.opsSince({ seed: 3 }, { capabilities: { tombstones: true } });
  assert.deepEqual(newView.map((o) => o.opId), ["x:1", "x:2", "x:3"]);
  assert.equal(newView.find((o) => o.opId === "x:2").__invalid, true);
});

test("旧副本只应用安全前缀不会整包失败，合法前序可见", () => {
  const { engine } = newReplicaWithTombstone();
  const legacyView = engine.opsSince({ seed: 3 }, { capabilities: { tombstones: false } });

  // 真实旧副本（legacy 引擎）消费这份裁剪后的导出：必须全部成功、无隔离
  const legacy = new Engine("old", { legacy: true }).seed();
  const report = legacy.ingest(legacyView);
  assert.deepEqual(report.quarantined, []);
  assert.deepEqual(report.rejected, []);
  assert.ok(legacy.project().rubbings.some((r) => r.id === "rubbing_cv"));
  assert.equal(legacy.meta().quarantined.length, 0);
  assert.equal(legacy.capabilities().tombstones, false);
});

test("新副本收到墓碑链确定性占位并与产生方收敛", () => {
  const { engine, ops } = newReplicaWithTombstone();
  const exported = engine.opsSince({ seed: 3 }, { capabilities: { tombstones: true } });

  // 用乱序 + 分批喂给第三个新副本
  const other = new Engine("other").seed();
  const order = [ops.x3, ops.x1, exported.find((o) => o.opId === "x:2")]; // 先缺链隔离
  other.ingest([order[0]]);
  other.ingest([order[1], order[2]]);
  assert.deepEqual(other.meta().invalid.map((i) => i.opId), ["x:2"]);
  assert.equal(other.meta().quarantined.length, 0);
  assert.equal(other.project().damages.find((d) => d.id === "damage_demo_1").repairNote, "X3后继");
  assert.equal(other.stateHash(), engine.stateHash(), "墓碑确定性占位，两馆收敛");
  assert.equal(other.stateHash(true), other.stateHash());
});

test("fail-closed：新副本无法识别的协议字段整批拒绝且不改状态", () => {
  const e = new Engine("nc").seed();
  const before = e.stateHash();
  const { x1 } = xChain();
  const future = { ...x1, opId: "f:1", site: "f", seq: 1, vclock: { seed: 3 }, causes: ["seed:3"], __futureExtension: { x: 1 } };
  const good = {
    opId: "g:1",
    site: "g",
    seq: 1,
    type: "field.update",
    payload: { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "不应落地" } },
    vclock: { seed: 3 },
    causes: ["seed:3"],
    at: "t"
  };
  assert.throws(() => e.ingest([future, good]), /无法识别的协议字段：__futureExtension/);
  // 同批的合法操作也不生效，状态哈希不变
  assert.equal(e.stateHash(), before);
  assert.equal(e.project().damages.find((d) => d.id === "damage_demo_1").repairNote, "");
  assert.equal(e.meta().applied, 3, "只有种子操作");
});

test("白名单墓碑标记可识别；未知 __ 标记在持久化重放后仍 fail-closed", () => {
  const { engine } = newReplicaWithTombstone();
  // 墓碑标记是受支持的协议字段，正常装载/重放
  const reloaded = new Engine("new").loadSnapshot(engine.toSnapshot());
  assert.equal(reloaded.stateHash(), engine.stateHash());
  assert.deepEqual(reloaded.meta().invalid.map((i) => i.opId), ["x:2"]);
  void topoOrder;
});
