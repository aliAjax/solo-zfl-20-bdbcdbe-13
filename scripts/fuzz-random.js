"use strict";
// 随机模糊：多馆产生交叉操作（含冲突、裁决、建实体、质检），收集全量操作后，
// 用多种随机顺序/分批喂给新引擎，要求：在线==重放、状态哈希与冲突集合全部一致；
// 含非法字段的混合报文必须整包不生效。

const { Engine } = require("../lib/engine");

function mulberry(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildHistory(seed) {
  const rnd = mulberry(seed);
  const sites = ["s1", "s2", "s3"];
  const halls = Object.fromEntries(sites.map((s) => [s, new Engine(s).seed()]));
  const knownRubbing = "rubbing_demo";
  const rubbings = [knownRubbing];
  const damages = ["damage_demo_1", "damage_demo_2"];

  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const clock0 = () => JSON.parse(JSON.stringify(halls.s1.rt.vclock));

  // 每轮随机选一个馆，基于它当前的认知做一个操作；偶尔让馆之间同步（制造因果/并发混合）
  for (let round = 0; round < 24; round += 1) {
    if (round > 0 && round % 4 === 0) {
      const [a, b] = shuffle(sites, rnd).slice(0, 2);
      const opsA = halls[a].opsSince({});
      const opsB = halls[b].opsSince({});
      // 只推部分（模拟分片到达）
      halls[a].ingest(shuffle(opsB, rnd).slice(0, Math.ceil(opsB.length / 2)));
      halls[b].ingest(shuffle(opsA, rnd).slice(0, Math.ceil(opsA.length / 2)));
      continue;
    }
    const site = pick(sites);
    const h = halls[site];
    const kind = rnd();
    const commit = (type, payload) => {
      const op = h.nextOp(type, payload);
      try {
        h.commitLocal(op);
      } catch {
        // 本地非法：不应产生操作
      }
    };
    if (kind < 0.25) {
      const id = `rub_${site}_${round}`;
      commit("rubbing.create", { id, fields: { code: `C${round}`, source: "x", paperSize: "1x1", note: "", createdAt: "t" } });
      rubbings.push(id);
    } else if (kind < 0.45 && rubbings.length) {
      const rid = pick(rubbings);
      // 拓片可能这个馆还没见过 -> 拒绝，正常
      commit("damage.create", {
        id: `dmg_${site}_${round}`,
        fields: { rubbingId: rid, position: `p${round}`, type: "t", beforePhotoUrl: "u", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "t", repairedAt: null }
      });
      // 乐观加入候选，未见过则后续自然失败
      damages.push(`dmg_${site}_${round}`);
    } else if (kind < 0.65 && damages.length) {
      const did = pick(damages);
      commit("field.update", { entity: "damages", entityId: did, fields: { position: `${site}-${round}`, repairNote: `n${round}` } });
    } else if (kind < 0.8 && damages.length) {
      const did = pick(damages);
      commit("inspection.create", { inspector: site, batchId: null, records: [{ damageId: did, result: pick(["pass", "fail", "rework"]), note: "", at: "t" }] });
    } else {
      // 偶尔裁决一个已有冲突
      const conflicts = h.listConflicts();
      if (conflicts.length) {
        const c = pick(conflicts);
        commit("conflict.resolve", { entity: c.entity, entityId: c.entityId, field: c.field, value: `resolved-${round}` });
      }
    }
  }

  // 汇总所有馆的操作全集
  let all = [];
  const seen = new Set();
  for (const s of sites) {
    for (const op of halls[s].opsSince({})) {
      if (!seen.has(op.opId)) {
        seen.add(op.opId);
        all.push(op);
      }
    }
  }
  return all;
}

function deliver(ops, order, rnd) {
  const e = new Engine("viewer").seed();
  let i = 0;
  let n = 0;
  while (i < order.length) {
    n += 1;
    const size = 1 + Math.floor(rnd() * 3);
    const chunk = order.slice(i, i + size).map((idx) => JSON.parse(JSON.stringify(ops[idx])));
    e.ingest(chunk);
    i += size;
  }
  return e;
}

let totalSeeds = 0;
let failSeeds = 0;
for (let seed = 1; seed <= 40; seed += 1) {
  const ops = buildHistory(seed);
  const rnd = mulberry(seed * 7919 + 13);
  const outcomes = [];
  for (let variant = 0; variant < 8; variant += 1) {
    const order = shuffle(ops.map((_, i) => i), rnd);
    const e = deliver(ops, order, rnd);
    outcomes.push({
      online: e.stateHash(false),
      replay: e.stateHash(true),
      conflicts: e.listConflicts()
        .map((c) => `${c.conflictId}:${c.values.map((v) => v.value).sort().join("|")}`)
        .sort(),
      q: e.meta().quarantined.length
    });
  }
  const base = outcomes[0];
  for (const o of outcomes) {
    totalSeeds += 1;
    const bad =
      o.online !== base.online ||
      o.replay !== o.online ||
      JSON.stringify(o.conflicts) !== JSON.stringify(base.conflicts) ||
      o.q !== 0;
    if (bad) {
      failSeeds += 1;
      console.log(`seed=${seed} MISMATCH online=${o.online === base.online} replay=${o.replay === o.online} cf=${JSON.stringify(o.conflicts) === JSON.stringify(base.conflicts)} q=${o.q}`);
      break;
    }
  }
}
console.log(`随机模糊：${totalSeeds - failSeeds}/${totalSeeds} 个(种子,投递)组合顺序无关且在线==重放`);
process.exit(failSeeds ? 1 : 0);
