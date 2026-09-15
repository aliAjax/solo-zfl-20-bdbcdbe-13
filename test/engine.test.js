"use strict";

// 引擎单元测试：寄存器因果合并、迟到旧值、旧分支冲突保留、拒绝操作的确定性重放、迁移。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Engine, seedOps, vcMerge } = require("../lib/engine");
const { migrateLegacyDb } = require("../lib/store");

function pair() {
  const A = new Engine("A");
  A.seed();
  const B = new Engine("B");
  B.seed();
  return [A, B];
}

function syncBoth(A, B) {
  const fromA = A.opsSince({});
  const fromB = B.opsSince({});
  A.ingest(fromB);
  B.ingest(fromA);
}

test("裁决后旧分支上的新工作不会静默获胜也不会被静默丢弃；旧报文重放不回退结果", () => {
  const [A, B] = pair();

  // 双方并发改同一字段 -> 冲突
  A.commitLocal(A.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "甲" } }));
  B.commitLocal(B.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "乙" } }));
  syncBoth(A, B);
  assert.equal(A.listConflicts().length, 1);

  // B 裁决（B:2，向量时钟支配甲、乙两个分支）
  B.commitLocal(
    B.nextOp("conflict.resolve", {
      entity: "damages",
      entityId: "damage_demo_1",
      field: "repairNote",
      value: "裁决值"
    })
  );
  assert.equal(B.project().damages.find((d) => d.id === "damage_demo_1").repairNote, "裁决值");

  // (a) A 已同步过冲突双方，但在裁决送达前继续在该字段上工作（A:2 与 B:2 并发）
  // -> 必须重新形成冲突，裁决值与新值都保留，等待人工再次定夺
  A.commitLocal(A.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "甲的新补充" } }));
  B.ingest(A.opsSince({ B: 2 }));
  const conflicts = B.listConflicts();
  assert.equal(conflicts.length, 1);
  const values = conflicts[0].values.map((v) => v.value);
  assert.equal(values.length, 2);
  assert.ok(values.includes("裁决值"));
  assert.ok(values.includes("甲的新补充"));

  // (b) 裁决后再重放裁决之前的旧报文（A:1、B:1），结果不得回退
  const before = B.stateHash();
  const replay = B.ingest([...A.opsSince({}), ...B.opsSince({})].filter((op) => ["A:1", "B:1"].includes(op.opId)));
  assert.deepEqual(replay.applied, []);
  assert.equal(B.stateHash(), before);
});

test("线性更新中后到的旧值被支配时直接忽略，不产生冲突", () => {
  const A = new Engine("A");
  A.seed();
  // 两次线性修改：A:2 支配 A:1
  A.commitLocal(A.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "第一版" } }));
  A.commitLocal(A.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "第二版" } }));

  // 对端先收到 A:2（缺链被隔离），补 A:1 后按序生效，最终为第二版
  const C = new Engine("C");
  C.seed();
  const [op1, op2] = A.opsSince({});
  assert.equal(op2.opId, "A:2");
  C.ingest([op2]);
  assert.ok(C.meta().quarantined.includes("A:2"));
  C.ingest([op1]);
  assert.equal(C.project().damages.find((d) => d.id === "damage_demo_1").repairNote, "第二版");
  assert.equal(C.listConflicts().length, 0);
  assert.equal(C.stateHash(true), C.stateHash());
});

test("被业务规则拒绝的操作跨馆重放结果一致（占用序号、不留状态差异）", () => {
  const A = new Engine("A");
  A.seed();
  // 直接构造一个引用不存在拓片的缺损登记（防御路径：对端异常/旧版本客户端）
  const bad = A.nextOp("damage.create", {
    id: "damage_ghost",
    fields: {
      rubbingId: "rubbing_missing",
      position: "x",
      type: "t",
      beforePhotoUrl: "u",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      repairedAt: null
    }
  });
  assert.throws(() => A.commitLocal(bad), /拓片不存在/);
  // 拒绝不占本地序号：下一条仍是 A:1
  const good = A.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "ok" } });
  A.commitLocal(good);
  assert.equal(good.seq, 1);

  // 外来被拒操作：经隔离/直送两种路径，重放哈希都一致
  const C = new Engine("C");
  C.seed();
  const foreignReject = {
    opId: "X:1",
    site: "X",
    seq: 1,
    type: "damage.create",
    payload: {
      id: "damage_ghost2",
      fields: {
        rubbingId: "rubbing_missing",
        position: "x",
        type: "t",
        beforePhotoUrl: "u",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        repairedAt: null
      }
    },
    vclock: { seed: 3 },
    causes: ["seed:3"],
    at: "2026-01-01T00:00:00.000Z"
  };
  const report = C.ingest([foreignReject]);
  assert.deepEqual(report.applied, ["X:1"]); // 已生效（含拒绝标记），不进隔离
  assert.equal(C.project().damages.some((d) => d.id === "damage_ghost2"), false);
  assert.equal(C.stateHash(true), C.stateHash(), "含拒绝操作的重放必须与在线投影一致");
});

test("向量时钟比较正确", () => {
  const { vcLE, vcConcurrent } = require("../lib/engine");
  assert.equal(vcLE({ A: 1 }, { A: 2, B: 1 }), true);
  assert.equal(vcLE({ A: 2 }, { A: 1 }), false);
  assert.equal(vcConcurrent({ A: 1 }, { B: 1 }), true);
  assert.equal(vcConcurrent({ A: 1, B: 1 }, { A: 1 }), false);
});

test("旧版 db.json 迁移结果确定性：同数据两次迁移字节一致", () => {
  const db = {
    rubbings: [{ id: "r2", code: "c", source: "s", paperSize: "p", note: "", createdAt: "t" }],
    damages: [],
    batches: []
  };
  const s1 = JSON.stringify(migrateLegacyDb(db));
  const s2 = JSON.stringify(migrateLegacyDb(db));
  assert.equal(s1, s2);
  // 迁移快照可装载且包含旧数据
  const E = new Engine("newhall");
  E.loadSnapshot(migrateLegacyDb(db));
  assert.ok(E.project().rubbings.some((r) => r.id === "r2"));
  assert.ok(E.project().rubbings.some((r) => r.id === "rubbing_demo"));
  assert.equal(E.stateHash(true), E.stateHash());
});

test("种子操作在全新各馆完全一致，状态哈希相同", () => {
  const a = new Engine("alpha").seed();
  const b = new Engine("beta").seed();
  assert.equal(a.stateHash(), b.stateHash());
  assert.deepEqual(a.opsSince({}), []); // 种子不进同步报文
  void seedOps;
  void vcMerge;
});
