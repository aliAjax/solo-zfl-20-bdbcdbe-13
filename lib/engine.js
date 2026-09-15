"use strict";

// 多馆离线协作的因果版本引擎
//
// 设计要点：
// 1. 所有业务变更都是“操作(op)”，操作带站点号、站内序号、向量时钟 vclock 与直接因果父 causes。
// 2. 实体的每个字段是一个多值寄存器(MV-Register)：并发写入全部保留，旧操作不覆盖新结果，
//    冲突可被派生出来等待人工裁决。
// 3. 缺前序的操作先进隔离区(quarantine)，补链后按因果顺序排空；同序号操作在任一馆
//    都以相同的 (site, seq) 次序生效，因此任意馆重放全部操作都收敛到同一状态。
// 4. 投影状态(rubbings/damages/...)可随时由操作日志完整重建，不单独作为事实来源。

const crypto = require("crypto");

const SITE_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const RESERVED_SITES = new Set(["seed"]);

const FIELDS = {
  rubbings: ["id", "code", "source", "paperSize", "note", "createdAt"],
  damages: [
    "id",
    "rubbingId",
    "position",
    "type",
    "beforePhotoUrl",
    "afterPhotoUrl",
    "status",
    "repairNote",
    "batchId",
    "createdAt",
    "repairedAt"
  ],
  batches: ["id", "name", "status", "damageIds", "note", "createdAt", "completedAt"],
  inspections: ["id", "damageId", "batchId", "inspector", "result", "note", "at"]
};

const ENTITIES = Object.keys(FIELDS);

class EngineError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- 向量时钟 ----------

function vcMerge(a, b) {
  const out = { ...a };
  for (const [site, seq] of Object.entries(b || {})) {
    out[site] = Math.max(out[site] || 0, seq);
  }
  return out;
}

// a 先于或等于 b（a 中每个分量都不大于 b）
function vcLE(a, b) {
  for (const [site, seq] of Object.entries(a)) {
    if (seq > (b[site] || 0)) return false;
  }
  return true;
}

function vcLt(a, b) {
  return vcLE(a, b) && !vcEqual(a, b);
}

function vcEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] || 0) !== (b[key] || 0)) return false;
  }
  return true;
}

// 并发：互不支配
function vcConcurrent(a, b) {
  return !vcLE(a, b) && !vcLE(b, a);
}

// ---------- 初始投影与种子操作 ----------

const SEED_AT = "2026-06-16T00:00:00.000Z";

function seedOps() {
  // 全新部署的公共起点，所有馆完全一致；site 固定为保留名 seed。
  const mk = (seq, type, payload) => {
    const vclock = { seed: seq - 1 };
    return {
      opId: `seed:${seq}`,
      site: "seed",
      seq,
      type,
      payload,
      vclock,
      causes: seq === 1 ? [] : [`seed:${seq - 1}`],
      at: SEED_AT
    };
  };
  return [
    mk(1, "rubbing.create", {
      id: "rubbing_demo",
      fields: {
        code: "TP-清-014",
        source: "地方碑刻残页",
        paperSize: "42x68cm",
        note: "边缘有旧折痕",
        createdAt: SEED_AT
      }
    }),
    mk(2, "damage.create", {
      id: "damage_demo_1",
      fields: {
        rubbingId: "rubbing_demo",
        position: "左上角第3列题字旁",
        type: "虫蛀孔",
        beforePhotoUrl: "https://example.local/before-014-1.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: SEED_AT,
        repairedAt: null
      }
    }),
    mk(3, "damage.create", {
      id: "damage_demo_2",
      fields: {
        rubbingId: "rubbing_demo",
        position: "下边缘中央",
        type: "撕裂",
        beforePhotoUrl: "https://example.local/before-014-2.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: SEED_AT,
        repairedAt: null
      }
    })
  ];
}

function blankRuntime() {
  const registers = {};
  for (const entity of ENTITIES) registers[entity] = new Map();
  return { registers, vclock: {}, heads: [], seq: 0, applied: new Map() };
}

// ---------- 引擎 ----------

class Engine {
  constructor(site, { now = () => new Date().toISOString() } = {}) {
    if (!SITE_RE.test(site) || RESERVED_SITES.has(site)) {
      throw new Error(`非法馆号：${site}（需匹配 ${SITE_RE}，且不能使用保留名 seed）`);
    }
    this.site = site;
    this.now = now;
    this.rt = blankRuntime();
    this.quarantine = new Map(); // opId -> op
    this.peers = new Map(); // peerSite -> { vclock, lastAt }
    this.selfClocks = new WeakMap(); // op -> 该操作自身的向量时钟（父上下文 + 本站点序号）
  }

  // ---- 持久化装载 ----

  loadSnapshot(snap) {
    this.rt = blankRuntime();
    this.quarantine = new Map();
    this.peers = new Map();
    for (const op of snap.ops || []) this._apply(op, {});
    for (const op of snap.quarantine || []) this.quarantine.set(op.opId, op);
    for (const [peer, info] of Object.entries(snap.peers || {})) {
      this.peers.set(peer, info);
    }
    return this;
  }

  seed() {
    for (const op of seedOps()) this._apply(op, {});
    return this;
  }

  toSnapshot() {
    return {
      version: 2,
      site: this.site,
      ops: [...this.rt.applied.values()].map((entry) => cleanOp(entry.op)),
      quarantine: [...this.quarantine.values()].map(cleanOp),
      peers: Object.fromEntries(this.peers)
    };
  }

  // ---- 操作构造（本馆本地业务产生）----

  nextOp(type, payload) {
    const seq = (this.rt.vclock[this.site] || 0) + 1;
    const op = {
      opId: `${this.site}:${seq}`,
      site: this.site,
      seq,
      type,
      payload,
      // vclock 记录“本操作生效前”的因果上下文；自身时钟 = vclock + (site:seq)，存于 WeakMap
      vclock: { ...this.rt.vclock },
      causes: [...this.rt.heads],
      at: this.now()
    };
    this.selfClocks.set(op, { ...this.rt.vclock, [this.site]: seq });
    return op;
  }

  commitLocal(op) {
    // 本地构造的 op 已满足所有前序，直接生效。
    // 任何业务/结构错误都在 _apply 内以硬错误抛出，且本方法整体包在事务里，不留半截变更。
    this._transaction(() => this._apply(op, { selfClock: this.selfClocks.get(op) }));
    return op;
  }

  // ---- 外来操作摄入（同步入口）----
  //
  // 整包事务：先在克隆状态上把本批（含历史隔离区补链排空）全部跑通；
  // 只要有一个操作是“结构/业务非法”（不同于缺前序），整批硬失败，合法操作也绝不生效，
  // 引擎状态（含寄存器与隔离区）恢复到调用前，发送方可原样重发。
  ingest(incoming) {
    if (!Array.isArray(incoming)) throw new EngineError("操作必须以数组形式提交");
    const report = { applied: [], duplicate: [], quarantined: [], rejected: [], missing: [] };

    for (const op of incoming) this._validateEnvelope(op);

    // 同序号不同内容 = 伪造/损坏；报文内同号异容同理。这两类不产生任何效果。
    for (const op of incoming) {
      const appliedEntry = this.rt.applied.get(op.opId);
      const existing = appliedEntry ? appliedEntry.op : this.quarantine.get(op.opId);
      if (existing && !sameOp(existing, op)) {
        throw new EngineError(`操作 ${op.opId} 与已收内容不一致，拒绝摄入`);
      }
      for (const other of incoming) {
        if (other !== op && other.opId === op.opId && !sameOp(other, op)) {
          throw new EngineError(`批次内操作重复且内容不一致：${op.opId}`);
        }
      }
    }

    this._transaction(() => {
      // 报文内同 opId 去重，保留首次出现
      const uniqueIncoming = [];
      const seenInBatch = new Set();
      for (const op of incoming) {
        if (seenInBatch.has(op.opId)) {
          report.duplicate.push(op.opId);
        } else {
          seenInBatch.add(op.opId);
          uniqueIncoming.push(op);
        }
      }

      // 幂等分类。已生效或已隔离的同内容报文只生效一次。
      const pending = [];
      for (const op of uniqueIncoming) {
        if (this.rt.applied.has(op.opId) || this.quarantine.has(op.opId)) {
          report.duplicate.push(op.opId);
        } else {
          pending.push(op);
        }
      }

      // 在“已生效 ∪ 本批待处理”集合内反复解锁因果链，直到不再有进展。
      let frontier = new Set(this.rt.applied.keys());
      const ready = [];
      const blocked = new Map(pending.map((op) => [op.opId, op]));
      let progressed = true;
      while (progressed && blocked.size) {
        progressed = false;
        for (const op of [...blocked.values()]) {
          const missing = this._missingParents(op, frontier);
          if (missing.length === 0) {
            ready.push(op);
            blocked.delete(op.opId);
            frontier.add(op.opId);
            progressed = true;
          }
        }
      }

      // 仍被阻塞的：前序既未生效也不在本批 → 隔离，等补链。
      for (const op of blocked.values()) {
        const missing = this._missingParents(op, new Set([...frontier, ...blocked.keys()]));
        this.quarantine.set(op.opId, op);
        report.quarantined.push(op.opId);
        for (const parent of missing) if (!report.missing.includes(parent)) report.missing.push(parent);
      }

      // 就绪操作按因果确定序生效：先因后果，并发操作按 (site, seq)，
      // 与到达顺序无关，任一馆重放次序都相同。
      // 任一操作非法（含未知类型/非法字段/在因果合法顺序下仍不满足的业务前置），
      // _apply 抛硬错误，_transaction 回滚整批——合法操作也不会留下。
      // 就绪操作按确定性拓扑序生效：先因后果，并发操作按 (site,seq) 决胜，
      // 与到达顺序无关，任一馆重放次序都相同。
      // 任一操作非法（未知类型/非法字段/在合法因果序下仍不满足的业务前置），
      // _apply 抛硬错误，_transaction 回滚整批——合法操作也不会留下。
      for (const op of topoOrder(ready)) {
        this._apply(op, {});
        report.applied.push(op.opId);
      }

      // 新到的链可能解掉历史隔离；排空顺序与上面一致。
      this._drainQuarantine(report);
      report.missing.sort();
    });

    return report;
  }

  // 在克隆状态上执行变更；抛错则整体回滚（寄存器、操作日志、隔离区都不留半成品）
  _transaction(fn) {
    const savedRt = structuredClone(this.rt);
    const savedQ = new Map(this.quarantine);
    try {
      fn();
    } catch (error) {
      this.rt = savedRt;
      this.quarantine = savedQ;
      throw error;
    }
  }

  _missingParents(op, known) {
    const missing = [];
    // 站内严格连续：前一号必须存在（seq=1 除外）
    if (op.seq > 1 && !known.has(`${op.site}:${op.seq - 1}`)) {
      missing.push(`${op.site}:${op.seq - 1}`);
    }
    for (const parent of op.causes || []) {
      if (!known.has(parent)) missing.push(parent);
    }
    return [...new Set(missing)];
  }

  _drainQuarantine(report = null) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const releasable = [...this.quarantine.values()].filter(
        (op) => this._missingParents(op, new Set(this.rt.applied.keys())).length === 0
      );
      // 按确定性因果拓扑序应用，与到达顺序无关
      for (const op of topoOrder(releasable)) {
        this.quarantine.delete(op.opId);
        this._apply(op, {});
        if (report) report.applied.push(op.opId);
        progressed = true;
      }
    }
  }

  _validateEnvelope(op) {
    if (!op || typeof op !== "object") throw new EngineError("非法操作：不是对象");
    const { opId, site, seq, type, payload, vclock, causes } = op;
    if (typeof opId !== "string" || !opId) throw new EngineError("非法操作：缺少 opId");
    if (!SITE_RE.test(site)) throw new EngineError(`非法操作：馆号不合法（${opId}）`);
    if (!Number.isInteger(seq) || seq < 1) throw new EngineError(`非法操作：序号不合法（${opId}）`);
    if (typeof type !== "string" || !type) throw new EngineError(`非法操作：缺少类型（${opId}）`);
    if (!payload || typeof payload !== "object") throw new EngineError(`非法操作：缺少负载（${opId}）`);
    if (!vclock || typeof vclock !== "object") throw new EngineError(`非法操作：缺少向量时钟（${opId}）`);
    if (!Array.isArray(causes)) throw new EngineError(`非法操作：causes 必须是数组（${opId}）`);
    for (const [parentSite, parentSeq] of Object.entries(vclock)) {
      if (!SITE_RE.test(parentSite) || !Number.isInteger(parentSeq) || parentSeq < 0) {
        throw new EngineError(`非法操作：向量时钟分量不合法（${opId}）`);
      }
    }
  }

  // 让单个操作在当前投影上生效。确定性：任何馆在同一操作序列上得到同一结果。
  // 结构/业务非法（不同于“缺前序”）一律抛 EngineError，由 _transaction 保证整批回滚。
  _apply(op, { selfClock = null } = {}) {
    if (this.rt.applied.has(op.opId)) return { duplicate: true };

    const selfVc = selfClock || vcMerge(op.vclock, { [op.site]: op.seq });
    const write = { value: undefined, vc: selfVc, opId: op.opId, site: op.site, at: op.at };
    this._dispatch(op, write);
    const entry = { op };

    this.rt.applied.set(op.opId, entry);
    this.rt.vclock = vcMerge(this.rt.vclock, selfVc);
    this.rt.heads = [
      op.opId,
      ...this.rt.heads.filter((headId) => {
        const head = this.rt.applied.get(headId);
        if (!head) return false;
        // 被本操作支配的旧头退出头集合
        return vcConcurrent(selfClockOf(head.op), selfVc) || vcLt(selfVc, selfClockOf(head.op));
      })
    ];
    return entry;
  }

  _dispatch(op, write) {
    const p = op.payload;
    switch (op.type) {
      case "rubbing.create":
        this._applyCreate("rubbings", p, write);
        return;
      case "damage.create":
        if (!this._entityExists("rubbings", (p.fields && p.fields.rubbingId) || p.rubbingId)) {
          throw new EngineError("拓片不存在");
        }
        this._applyCreate("damages", p, write);
        return;
      case "batch.create": {
        if (!Array.isArray(p.damageIds) || p.damageIds.length === 0) {
          throw new EngineError("damageIds必须是非空数组");
        }
        const missing = p.damageIds.filter((id) => !this._entityExists("damages", id));
        if (missing.length) throw new EngineError(`缺损项不存在：${missing.join(", ")}`);
        // 先建批次再回写缺损；任一步出错上层事务整体回滚
        this._applyCreate(
          "batches",
          {
            id: p.id,
            fields: {
              name: p.name,
              status: "open",
              damageIds: p.damageIds,
              note: p.note || "",
              createdAt: write.at,
              completedAt: null
            }
          },
          write
        );
        for (const damageId of p.damageIds) {
          this._writeField("damages", damageId, "batchId", p.id, write);
          this._writeField("damages", damageId, "status", "in_repair", write);
        }
        return;
      }
      case "batch.complete": {
        if (!this._entityExists("batches", p.id)) throw new EngineError("修补批次不存在");
        this._writeField("batches", p.id, "status", "completed", write);
        this._writeField("batches", p.id, "completedAt", write.at, write);
        if (p.note !== undefined) this._writeField("batches", p.id, "note", p.note, write);
        const damageIds = this._winnerValue("batches", p.id, "damageIds") || [];
        for (const damageId of damageIds) {
          const result = (p.results || []).find((item) => item.damageId === damageId) || {};
          this._writeField("damages", damageId, "status", "repaired", write);
          const after = result.afterPhotoUrl || p.defaultAfterPhotoUrl;
          const note = result.repairNote || p.defaultRepairNote;
          if (after !== undefined) {
            const current = this._winnerValue("damages", damageId, "afterPhotoUrl");
            this._writeField("damages", damageId, "afterPhotoUrl", after || current || "", write);
          }
          if (note !== undefined) {
            const current = this._winnerValue("damages", damageId, "repairNote");
            this._writeField("damages", damageId, "repairNote", note || current || "", write);
          }
          this._writeField("damages", damageId, "repairedAt", write.at, write);
        }
        return;
      }
      case "inspection.create": {
        if (!Array.isArray(p.records) || !p.records.length) throw new EngineError("质检记录不能为空");
        // 先全部校验、再全部写入：任何一条非法，整包不生效
        for (const record of p.records) {
          if (!record || !record.result) throw new EngineError("质检结论 result 必填（pass/fail/rework）");
          if (record.damageId && !this._entityExists("damages", record.damageId)) {
            throw new EngineError(`质检缺损项不存在：${record.damageId}`);
          }
        }
        p.records.forEach((record, index) => {
          const id = `inspection_${op.site}_${op.seq}_${index}`;
          this._applyCreate(
            "inspections",
            {
              id,
              fields: {
                damageId: record.damageId || null,
                batchId: record.batchId || p.batchId || null,
                inspector: record.inspector || p.inspector || "",
                result: record.result,
                note: record.note || "",
                at: record.at || write.at
              }
            },
            write
          );
        });
        return;
      }
      case "field.update": {
        if (!ENTITIES.includes(p.entity)) throw new EngineError(`未知实体类型：${p.entity}`);
        if (!p.fields || typeof p.fields !== "object") throw new EngineError("fields必须是对象");
        if (!this._entityExists(p.entity, p.entityId)) throw new EngineError("实体不存在");
        const entries = Object.entries(p.fields);
        // 关键：先校验全部字段，再统一写入。合法字段不得因同包内的非法字段而部分落地。
        for (const [field] of entries) {
          if (field === "id" || !FIELDS[p.entity].includes(field)) {
            throw new EngineError(`不可写字段：${field}`);
          }
        }
        for (const [field, value] of entries) {
          this._writeField(p.entity, p.entityId, field, value, write);
        }
        return;
      }
      case "conflict.resolve": {
        // 裁决是纯因果写入，不做“当前是否有冲突”的顺序相关检查：
        // 冲突分支都是本操作 vclock 的祖先（缺链时会被隔离），
        // 到达时寄存器必含双方；无论先收到裁决还是先收到某个分支，合成结果一致。
        if (!p.entity || !p.entityId || !p.field || !Object.prototype.hasOwnProperty.call(p, "value")) {
          throw new EngineError("裁决操作需要 entity/entityId/field/value");
        }
        if (!ENTITIES.includes(p.entity) || !FIELDS[p.entity].includes(p.field)) {
          throw new EngineError("裁决目标非法");
        }
        if (!this._entityExists(p.entity, p.entityId)) throw new EngineError("实体不存在");
        this._writeField(p.entity, p.entityId, p.field, p.value, write, { resolution: true });
        return;
      }
      default:
        throw new EngineError(`未知操作类型：${op.type}`);
    }
  }

  _applyCreate(entity, payload, write) {
    if (!payload || !payload.id) throw new EngineError("缺少实体 id");
    const group = this.rt.registers[entity];
    if (group.has(payload.id)) throw new EngineError(`${entity} 已存在：${payload.id}`);
    const fields = new Map();
    const w0 = { ...write, value: payload.id };
    fields.set("id", { writes: [w0] });
    for (const field of FIELDS[entity]) {
      if (field === "id") continue;
      const value = payload.fields && Object.prototype.hasOwnProperty.call(payload.fields, field)
        ? payload.fields[field]
        : null;
      fields.set(field, { writes: [{ ...write, value }] });
    }
    group.set(payload.id, fields);
    return null;
  }

  _register(entity, id, field) {
    const group = this.rt.registers[entity];
    const entityRegs = group.get(id);
    if (!entityRegs) return null;
    return entityRegs.get(field) || null;
  }

  _entityExists(entity, id) {
    return this.rt.registers[entity].has(id);
  }

  _writeField(entity, id, field, value, write, extra = {}) {
    const group = this.rt.registers[entity];
    let entityRegs = group.get(id);
    if (!entityRegs) {
      entityRegs = new Map();
      group.set(id, entityRegs);
    }
    let reg = entityRegs.get(field);
    const next = { ...write, value, ...extra };
    if (!reg) {
      entityRegs.set(field, { writes: [next] });
      return;
    }
    mergeIntoRegister(reg, next);
  }

  _winnerValue(entity, id, field) {
    const reg = this._register(entity, id, field);
    return reg ? reg.writes[0].value : undefined;
  }

  // ---- 投影 / 查询 ----

  project() {
    const out = {};
    for (const entity of ENTITIES) {
      out[entity] = [];
      for (const [id, fields] of this.rt.registers[entity]) {
        const row = { id };
        for (const field of FIELDS[entity]) {
          if (field === "id") continue;
          const reg = fields.get(field);
          if (reg) row[field] = reg.writes[0].value;
        }
        out[entity].push(row);
      }
      out[entity].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return out;
  }

  listConflicts() {
    const conflicts = [];
    for (const entity of ENTITIES) {
      for (const [entityId, fields] of this.rt.registers[entity]) {
        for (const field of FIELDS[entity]) {
          const reg = fields.get(field);
          if (reg && reg.writes.length > 1) {
            conflicts.push({
              conflictId: `${entity}.${entityId}.${field}`,
              entity,
              entityId,
              field,
              winner: writeView(reg.writes[0]),
              values: reg.writes.map(writeView)
            });
          }
        }
      }
    }
    conflicts.sort((a, b) => (a.conflictId < b.conflictId ? -1 : 1));
    return conflicts;
  }

  fieldVersion(entity, entityId) {
    const fields = this.rt.registers[entity].get(entityId);
    if (!fields) return null;
    const versions = {};
    for (const [field, reg] of fields) {
      versions[field] = {
        winner: writeView(reg.writes[0]),
        versions: reg.writes.map(writeView)
      };
    }
    return { entity, entityId, fields: versions };
  }

  // 增量导出：请求方给出它的向量时钟，只返回它缺的操作。
  // 站内序号严格连续，任何已生效操作都必须导出，否则对端会断链并永久隔离。
  opsSince(theirVclock = {}) {
    const seedCount = seedOps().length;
    const ops = [];
    for (const entry of this.rt.applied.values()) {
      // 公共种子 seed:1..N 各馆部署时自带，不进同步报文；迁移续写的 seed:N+1.. 是真实数据，照常导出。
      if (entry.op.site === "seed" && entry.op.seq <= seedCount) continue;
      if ((theirVclock[entry.op.site] || 0) < entry.op.seq) {
        ops.push(cleanOp(entry.op));
      }
    }
    ops.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : a.seq - b.seq));
    return ops;
  }

  hasOp(opId) {
    return this.rt.applied.has(opId) || this.quarantine.has(opId);
  }

  // ---- 重放与收敛校验 ----

  replay() {
    const fresh = new Engine(this.site, { now: this.now });
    // 公共前史（seed:1..3）是各馆部署自带、不进同步报文，重放前先补齐。
    fresh.seed();
    // 按确定性拓扑序从头重放其余操作，与在线到达顺序无关。
    // 注意：旧库迁移续写的 seed:4.. 是真实数据，必须参与重放，不能按站点名过滤。
    const seedCount = seedOps().length;
    const ops = topoOrder(
      [...this.rt.applied.values()]
        .map((entry) => cleanOp(entry.op))
        .filter((op) => !(op.site === "seed" && op.seq <= seedCount))
    );
    for (const op of ops) fresh._apply(op, {});
    return fresh.project();
  }

  canonicalState(useReplay = false) {
    const projection = useReplay ? this.replay() : this.project();
    return canonicalize(projection);
  }

  stateHash(useReplay = false) {
    return crypto.createHash("sha256").update(this.canonicalState(useReplay)).digest("hex");
  }

  meta() {
    return {
      site: this.site,
      vclock: { ...this.rt.vclock },
      heads: [...this.rt.heads],
      applied: this.rt.applied.size,
      quarantined: [...this.quarantine.keys()],
      peers: Object.fromEntries(this.peers)
    };
  }

  recordPeer(peer, vclock) {
    const prev = this.peers.get(peer) || { vclock: {}, lastAt: null };
    this.peers.set(peer, { vclock: vcMerge(prev.vclock, vclock), lastAt: this.now() });
  }
}

// ---------- 寄存器合并 ----------

function mergeIntoRegister(reg, incoming) {
  // 新写入被任一已有写入支配（时钟不大于对方）→ 它是迟到旧值，忽略，不能覆盖较新结果
  if (reg.writes.some((w) => vcLE(incoming.vc, w.vc))) return;
  // 剔除被新写入支配的旧写入；与新写入并发的全部保留为冲突
  const survivors = reg.writes.filter((w) => !vcLE(w.vc, incoming.vc));
  survivors.push(incoming);
  survivors.sort(writeOrder);
  reg.writes = survivors;
}

// 并发写入间的确定性裁决序（仅决定默认展示值，不丢弃任何一方）
function writeOrder(a, b) {
  if (a.site !== b.site) return a.site < b.site ? -1 : 1;
  if (a.opId !== b.opId) return a.opId < b.opId ? -1 : 1;
  return 0;
}

function opsReadyOrder(a, b) {
  if (a.site !== b.site) return a.site < b.site ? -1 : 1;
  return a.seq - b.seq;
}

// x 是否在因果上先于 y：x 的自身时钟被 y 生效前的父时钟覆盖（xc <= y.vclock）。
// 直接用 opId 兜底排除 x 自身（同馆同序号时 xc 不可能等于 y.vclock）。
function hbBefore(x, y) {
  if (x.opId === y.opId) return false;
  const xc = selfClockOf(x);
  return vcLE(xc, y.vclock);
}

// 确定性全局因果序：Kahn 拓扑排序，入度为 0 的候选里总取 (site,seq) 最小者。
// 不能用“向量时钟比较 + site 决胜”的比较器：偏序上补决胜键不保证传递性
// （存在 a<b、b<c 但 c<a 的环），Array.sort 结果未定义——这正是顺序相关缺陷的根因。
function topoOrder(ops) {
  const remaining = [...ops];
  const result = [];
  while (remaining.length) {
    const candidates = [];
    for (const op of remaining) {
      let hasPred = false;
      for (const other of remaining) {
        if (other !== op && hbBefore(other, op)) {
          hasPred = true;
          break;
        }
      }
      if (!hasPred) candidates.push(op);
    }
    if (!candidates.length) {
      throw new EngineError("操作集合中存在因果环，无法排序（可能是伪造报文）");
    }
    candidates.sort(opsReadyOrder);
    const chosen = candidates[0];
    result.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
  }
  return result;
}

// 兼容旧引用名（真正的全局序请用 topoOrder）
const opsReplayOrder = opsReadyOrder;

function selfClockOf(op) {
  return vcMerge(op.vclock, { [op.site]: op.seq });
}

function writeView(w) {
  return {
    value: w.value,
    vclock: w.vc,
    opId: w.opId,
    site: w.site,
    at: w.at,
    resolution: !!w.resolution
  };
}

function sameOp(a, b) {
  return canonicalJson(cleanOp(a)) === canonicalJson(cleanOp(b));
}

function cleanOp(op) {
  const { _selfClock, ...rest } = op;
  return rest;
}

void cleanOp;

function canonicalize(projection) {
  return canonicalJson(projection);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  Engine,
  EngineError,
  FIELDS,
  ENTITIES,
  SITE_RE,
  seedOps,
  vcMerge,
  vcLE,
  vcLt,
  vcEqual,
  vcConcurrent,
  topoOrder,
  canonicalJson
};
