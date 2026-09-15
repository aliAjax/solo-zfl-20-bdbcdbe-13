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
    // 本地构造的 op 已满足所有前序，直接生效
    const trial = this._trial(op);
    if (trial.rejected) {
      const error = new EngineError(trial.rejected.message || "操作被业务规则拒绝", 400);
      throw error;
    }
    this._apply(op, { selfClock: this.selfClocks.get(op) });
    return op;
  }

  // 在投影副本上试算，用于本地提交前校验，拒绝时不留半截变更
  _trial(op) {
    const saved = structuredClone(this.rt);
    const result = this._apply(op, { selfClock: this.selfClocks.get(op) });
    this.rt = saved;
    return result;
  }

  // ---- 外来操作摄入（同步入口）----

  ingest(incoming) {
    if (!Array.isArray(incoming)) throw new EngineError("操作必须以数组形式提交");
    const report = { applied: [], duplicate: [], quarantined: [], rejected: [], missing: [] };

    for (const op of incoming) this._validateEnvelope(op);

    // 同序号不同内容 = 伪造/损坏，整批拒绝（不产生任何效果，发送方可安全重试）
    for (const op of incoming) {
      const appliedEntry = this.rt.applied.get(op.opId);
      const existing = appliedEntry ? appliedEntry.op : this.quarantine.get(op.opId);
      if (existing && !sameOp(existing, op)) {
        throw new EngineError(`操作 ${op.opId} 与已收内容不一致，拒绝摄入`);
      }
      // 同一报文内重复投递：内容一致则容忍（只生效一次），内容不一致才拒绝
      for (const other of incoming) {
        if (other !== op && other.opId === op.opId && !sameOp(other, op)) {
          throw new EngineError(`批次内操作重复且内容不一致：${op.opId}`);
        }
      }
    }

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

    // 第一遍：幂等分类。已生效或已隔离的同内容报文只生效一次。
    const pending = [];
    for (const op of uniqueIncoming) {
      if (this.rt.applied.has(op.opId)) {
        report.duplicate.push(op.opId);
      } else if (this.quarantine.has(op.opId)) {
        report.duplicate.push(op.opId);
      } else {
        pending.push(op);
      }
    }

    // 第二遍：在“已生效 ∪ 本批待处理”集合内反复解锁因果链，直到不再有进展。
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
    ready.sort(opsReplayOrder);
    for (const op of ready) {
      const entry = this._apply(op, {});
      report.applied.push(op.opId); // 进了操作日志即算生效
      if (entry.rejected) report.rejected.push(op.opId); // 被业务规则拒绝的单列
    }

    // 新到的链可能解掉历史隔离。
    this._drainQuarantine(report);

    report.missing.sort();
    return report;
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
      releasable.sort(opsReplayOrder);
      for (const op of releasable) {
        this.quarantine.delete(op.opId);
        const entry = this._apply(op, {});
        if (report) {
          report.applied.push(op.opId);
          if (entry.rejected) report.rejected.push(op.opId);
        }
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
  _apply(op, { fromLog = false, selfClock = null } = {}) {
    if (this.rt.applied.has(op.opId)) return { duplicate: true };

    const selfVc = selfClock || vcMerge(op.vclock, { [op.site]: op.seq });
    const write = { value: undefined, vc: selfVc, opId: op.opId, site: op.site, at: op.at };
    const rejection = this._dispatch(op, write);
    const entry = { op, rejected: rejection || null };

    // 被业务规则拒绝的操作同样占用序号、推进时钟，保证各馆次序一致。
    this.rt.applied.set(op.opId, entry);
    this.rt.vclock = vcMerge(this.rt.vclock, selfVc);
    this.rt.heads = [
      op.opId,
      ...this.rt.heads.filter((headId) => {
        const head = this.rt.applied.get(headId);
        if (!head) return false;
        const headClock = headClockOf(head.op, this.rt.applied);
        // 被本操作支配的旧头退出头集合
        return vcConcurrent(headClock, selfVc) || vcLt(selfVc, headClock);
      })
    ];
    return entry;
  }

  _dispatch(op, write) {
    const p = op.payload;
    switch (op.type) {
      case "rubbing.create":
        return this._applyCreate("rubbings", p, write);
      case "damage.create":
        if (!this._entityExists("rubbings", (p.fields && p.fields.rubbingId) || p.rubbingId)) {
          return reject("拓片不存在");
        }
        return this._applyCreate("damages", p, write);
      case "batch.create": {
        const missing = (p.damageIds || []).filter((id) => !this._entityExists("damages", id));
        if (missing.length) return reject(`缺损项不存在：${missing.join(", ")}`);
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
        return null;
      }
      case "batch.complete": {
        if (!this._entityExists("batches", p.id)) return reject("修补批次不存在");
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
        return null;
      }
      case "inspection.create": {
        if (!Array.isArray(p.records) || !p.records.length) return reject("质检记录不能为空");
        for (const record of p.records) {
          if (!record.result) return reject("质检结论 result 必填（pass/fail/rework）");
          if (record.damageId && !this._entityExists("damages", record.damageId)) {
            return reject(`质检缺损项不存在：${record.damageId}`);
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
        return null;
      }
      case "field.update": {
        if (!ENTITIES.includes(p.entity)) return reject(`未知实体类型：${p.entity}`);
        if (!this._entityExists(p.entity, p.entityId)) return reject("实体不存在");
        for (const [field, value] of Object.entries(p.fields || {})) {
          if (!FIELDS[p.entity].includes(field) || field === "id") return reject(`不可写字段：${field}`);
          this._writeField(p.entity, p.entityId, field, value, write);
        }
        return null;
      }
      case "conflict.resolve": {
        // 裁决操作的向量时钟支配冲突双方：旧分支之后再补写的旧值会被自然丢弃，
        // 各馆独立重放也得到同一裁决结果。
        if (!p.entity || !p.entityId || !p.field || !Object.prototype.hasOwnProperty.call(p, "value")) {
          return reject("裁决操作需要 entity/entityId/field/value");
        }
        const reg = this._register(p.entity, p.entityId, p.field);
        if (!reg) return reject("冲突不存在或已解决");
        if (reg.writes.length < 2) return reject("该字段不存在冲突");
        this._writeField(p.entity, p.entityId, p.field, p.value, write, { resolution: true });
        return null;
      }
      default:
        return reject(`未知操作类型：${op.type}`);
    }
  }

  reject(message) {
    return { message };
  }

  _applyCreate(entity, payload, write) {
    if (!payload || !payload.id) return reject("缺少实体 id");
    const group = this.rt.registers[entity];
    if (group.has(payload.id)) return reject(`${entity} 已存在：${payload.id}`);
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
  // 被业务规则拒绝的操作同样占用站内序号，必须一并导出，否则对端序号断链会永久隔离。
  opsSince(theirVclock = {}) {
    const ops = [];
    for (const entry of this.rt.applied.values()) {
      // seed 是各馆部署时自带的公共前史，不进同步报文
      if (entry.op.site === "seed") continue;
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
    // 包含被业务规则拒绝的操作：它们同样占用序号、可能留下部分写入，
    // 漏放会与在线投影发散。拒绝与否完全由操作序列决定，因此重放结果确定。
    const ops = [...this.rt.applied.values()].map((entry) => cleanOp(entry.op));
    ops.sort(opsReplayOrder);
    for (const op of ops) fresh._apply(cleanOpForApply(op), {});
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

function opsReplayOrder(a, b) {
  if (vcLE(selfClockOf(a), selfClockOf(b)) && !vcEqual(selfClockOf(a), selfClockOf(b))) return -1;
  if (vcLE(selfClockOf(b), selfClockOf(a)) && !vcEqual(selfClockOf(a), selfClockOf(b))) return 1;
  return opsReadyOrder(a, b);
}

function selfClockOf(op) {
  return vcMerge(op.vclock, { [op.site]: op.seq });
}

function headClockOf(op, applied) {
  return selfClockOf(op);
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

function cleanOpForApply(op) {
  return cleanOp(op);
}

function reject(message) {
  return { message };
}

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
  canonicalJson
};
