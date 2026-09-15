"use strict";
// 临时模糊脚本：同一组操作、不同投递顺序/分块，比较各引擎在线状态、重放状态与冲突集合。
const { Engine } = require("../lib/engine");

function shuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deliver(site, ops, order) {
  const e = new Engine(site).seed();
  // 按 order 给出的下标序列投递，每 1~3 条切一批
  let i = 0;
  let step = 0;
  while (i < order.length) {
    step += 1;
    const n = 1 + (step % 3);
    const chunk = order.slice(i, i + n).map((idx) => ops[idx]);
    e.ingest(chunk);
    i += n;
  }
  e.ingest([]); // drain
  return e;
}

function runScenario(name, ops) {
  const orders = [];
  for (let seed = 1; seed <= 12; seed += 1) orders.push(shuffle(ops.map((_, i) => i), seed));
  orders.push([...ops.keys()]);
  const results = orders.map((order, i) => {
    const e = deliver(`R${i}`, ops, order);
    return {
      order,
      online: e.stateHash(false),
      replay: e.stateHash(true),
      conflicts: JSON.stringify(e.listConflicts().map((c) => `${c.conflictId}=${c.values.length}`)),
      quarantine: e.meta().quarantined.length
    };
  });
  const baseOnline = results[0].online;
  const baseConflicts = results[0].conflicts;
  let bad = 0;
  for (const r of results) {
    const probs = [];
    if (r.online !== baseOnline) probs.push("online-diff");
    if (r.replay !== r.online) probs.push("replay!=online");
    if (r.conflicts !== baseConflicts) probs.push("conflict-diff");
    if (r.quarantine !== 0) probs.push("still-quarantined");
    if (probs.length) {
      bad += 1;
      console.log(`[${name}] order=${r.order.join(",")} -> ${probs.join(",")} q=${r.quarantine} cf=${r.conflicts}`);
    }
  }
  console.log(`[${name}] ${results.length - bad}/${results.length} consistent, conflicts=${baseConflicts}`);
}

// 场景 A：两馆并发改同字段 + 裁决 + 后续并发再写
function scenarioA() {
  const A = new Engine("A").seed();
  const B = new Engine("B").seed();
  A.commitLocal(A.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { position: "A1" } }));
  B.commitLocal(B.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { position: "B1" } }));
  A.ingest(B.opsSince({}));
  B.ingest(A.opsSince({}));
  A.commitLocal(A.nextOp("conflict.resolve", { entity: "damages", entityId: "damage_demo_1", field: "position", value: "R" }));
  B.commitLocal(B.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { position: "B2" } }));
  const all = [...A.opsSince({}), ...B.opsSince({})];
  return all;
}

// 场景 B：建拓片/缺损/批次/完工 交织
function scenarioB() {
  const A = new Engine("A").seed();
  const B = new Engine("B").seed();
  let op;
  op = A.nextOp("rubbing.create", { id: "rA", fields: { code: "cA", source: "s", paperSize: "p", note: "", createdAt: "t" } });
  A.commitLocal(op);
  op = A.nextOp("damage.create", { id: "dA", fields: { rubbingId: "rA", position: "p", type: "t", beforePhotoUrl: "u", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "t", repairedAt: null } });
  A.commitLocal(op);
  op = B.nextOp("field.update", { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "Bn", status: "in_repair" } });
  B.commitLocal(op);
  // B 同步到 rA/dA 后建批次
  B.ingest(A.opsSince({}));
  op = B.nextOp("batch.create", { id: "bB", name: "bb", damageIds: ["dA", "damage_demo_1"], note: "" });
  B.commitLocal(op);
  op = B.nextOp("batch.complete", { id: "bB", results: [{ damageId: "dA", repairNote: "done" }], note: "" });
  B.commitLocal(op);
  op = A.nextOp("field.update", { entity: "damages", entityId: "dA", fields: { repairNote: "An" } });
  A.commitLocal(op);
  return [...A.opsSince({}), ...B.opsSince({})];
}

runScenario("A: 冲突+裁决+并发再写", scenarioA());
runScenario("B: 实体交织建批完工", scenarioB());
