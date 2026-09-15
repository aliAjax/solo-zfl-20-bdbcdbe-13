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

// ---------- 协议能力协商 ----------
//
// 墓碑（被拒操作占位）是 v3 才引入的协议数据。旧版副本不认识携带 __invalid
// 标记的操作，会把它当普通操作执行而整包失败。因此：
//   - 任何同步响应都带 capabilities，声明本副本“能理解什么”；
//   - 导出方按请求方能力裁剪：对不支持 tombstones 的旧副本，绝不发送墓碑以及
//     因果上依赖墓碑的后继（会让旧副本序号断洞），只发送其能安全应用的连续前缀；
//   - 收到操作时，除白名单 __invalid/__invalidReason 外的任何 __ 协议字段都
//     fail-closed：明确拒绝且不改任何已落盘状态。
const PROTOCOL_VERSION = 3;
const CAPABILITIES = Object.freeze({ tombstones: true, conflicts: true });

// 同步信封上允许出现的非业务字段（其余顶层字段按普通数据处理；__ 前缀的操作字段受保护）
const KNOWN_OP_MARKERS = new Set(["__invalid", "__invalidReason"]);

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
  // legacy=true 模拟不支持墓碑协议的旧版副本：
  //   - 不声明 tombstones 能力；
  //   - 收到带 __invalid 的操作按普通操作执行（旧行为）；
  //   - 导出从不携带墓碑标记。
  // 仅用于跨版本兼容与测试；真实旧副本就是升级前的二进制。
  constructor(site, { now = () => new Date().toISOString(), legacy = false } = {}) {
    if (!SITE_RE.test(site) || RESERVED_SITES.has(site)) {
      throw new Error(`非法馆号：${site}（需匹配 ${SITE_RE}，且不能使用保留名 seed）`);
    }
    this.site = site;
    this.now = now;
    this.legacy = legacy;
    this.rt = blankRuntime();
    this.quarantine = new Map(); // opId -> op
    this.peers = new Map(); // peerSite -> { vclock, lastAt }
    this.selfClocks = new WeakMap(); // op -> 该操作自身的向量时钟（父上下文 + 本站点序号）
  }

  capabilities() {
    return this.legacy ? { tombstones: false, conflicts: true } : { ...CAPABILITIES };
  }

  // legacy 模式模拟升级前的旧二进制：协议版本停留在 2（无墓碑）。
  protocolVersion() {
    return this.legacy ? 2 : PROTOCOL_VERSION;
  }

  // ---- 持久化装载 ----

  loadSnapshot(snap) {
    this.rt = blankRuntime();
    this.quarantine = new Map();
    this.peers = new Map();
    const invalidReason = new Map((snap.invalid || []).map((item) => [item.opId, item.reason]));
    const ops = topoOrder(snap.ops || []);
    for (const op of ops) {
      this._apply(op, invalidReason.has(op.opId) ? { invalidReason: invalidReason.get(op.opId) } : {});
    }
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
      version: 3,
      site: this.site,
      ops: [...this.rt.applied.values()].map((entry) => cleanOp(entry.op)),
      // 被业务/结构规则拒绝的操作墓碑：只占站内序号、不产生状态，用于防止坏操作永久阻塞同步链
      invalid: [...this.rt.applied.values()]
        .filter((entry) => entry.invalid)
        .map((entry) => ({ opId: entry.op.opId, reason: entry.invalidReason || "" })),
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
    // 无法安全识别的协议数据必须 fail-closed：在任何状态变更前拒绝整包。
    for (const op of incoming) this._validateProtocolMarkers(op);

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
        if (this.rt.applied.has(op.opId)) {
          report.duplicate.push(op.opId);
        } else if (this.quarantine.has(op.opId)) {
          if (this.isInvalidMarked(op)) {
            // 上游已确认该 opId 非法：用墓碑替换隔离中的原始副本，解锁站内序号链
            this.quarantine.delete(op.opId);
            pending.push(op);
          } else {
            report.duplicate.push(op.opId);
          }
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

      // 本批直接就绪的操作按确定性拓扑序生效：先因后果，并发按 (site,seq) 决胜。
      // 这些操作发送方还持有整包：任一非法（未知类型/非法字段/合法因果序下实体不存在），
      // 由外层 _transaction 整体回滚并返回 409，发送方剔除/修正后整包重发——合法操作也不留下。
      for (const op of topoOrder(ready)) {
        if (this.isInvalidMarked(op)) {
          // 上游已确认非法：直接立墓碑占位，不再尝试分发
          this._applyTombstone(op, op.__invalidReason || "上游馆标记为非法操作");
          report.applied.push(op.opId);
          report.rejected.push(op.opId);
          continue;
        }
        this._apply(op, {});
        report.applied.push(op.opId);
      }

      // 历史隔离项补链排空：逐条原子处理（不能整批回滚，否则早先批次的坏后继会
      // 永久卡住该馆）。合法前序正常生效；非法后继降级为“拒绝墓碑”：占住站内序号、
      // 移出隔离区、写进 rejected，不回滚同批合法前序，同步链得以继续。
      this._drainQuarantine(report);
      report.missing.sort();
    });

    return report;
  }

  // 逐条应用一个已补齐前序的操作；若其结构/业务非法，则降级为拒绝墓碑而不是向外抛错。
  // 返回 "applied" | "rejected"。仅用于隔离区补链排空。
  _applyOrTombstone(op, report = null) {
    // 上游已标记的墓碑：直接占位，不再分发
    if (this.isInvalidMarked(op)) {
      this._applyTombstone(op, op.__invalidReason || "上游馆标记为非法操作");
      if (report) {
        report.applied.push(op.opId);
        report.rejected.push(op.opId);
      }
      return "rejected";
    }
    const savedRt = structuredClone(this.rt);
    try {
      this._apply(op, {});
      if (report) report.applied.push(op.opId);
      return "applied";
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      // 回滚这次本应产生的寄存器写入，只保留一个“已拒绝”的序号占位
      this.rt = savedRt;
      this._applyTombstone(op, error.message);
      if (report) {
        report.rejected.push(op.opId);
        if (!report.rejectionReasons) report.rejectionReasons = {};
        report.rejectionReasons[op.opId] = error.message;
      }
      return "rejected";
    }
  }

  // 拒绝墓碑：进入操作日志、推进向量时钟，但不分发到任何实体/字段。
  _applyTombstone(op, reason) {
    const selfVc = selfClockOf(op);
    this.rt.applied.set(op.opId, { op, invalid: true, invalidReason: reason });
    this.rt.vclock = vcMerge(this.rt.vclock, selfVc);
    this.rt.heads = [op.opId, ...this.rt.heads.filter((h) => h !== op.opId)];
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
      // 按确定性因果拓扑序逐条应用，与到达顺序无关。
      for (const op of topoOrder(releasable)) {
        this.quarantine.delete(op.opId);
        if (this.legacy) {
          // 旧副本：直接执行，坏操作抛错并由外层事务整批回滚（历史行为）
          this._apply(op, {});
          if (report) report.applied.push(op.opId);
        } else {
          // 新副本：坏操作降级为拒绝墓碑，不中断整轮（详见 _applyOrTombstone）
          this._applyOrTombstone(op, report);
        }
        progressed = true;
      }
    }
  }

  // 旧副本不识别墓碑标记：__invalid 对它只是普通额外字段，按普通操作执行。
  isInvalidMarked(op) {
    return !this.legacy && isInvalidMarked(op);
  }

  // fail-closed：识别不了的协议扩展字段绝不静默忽略。
  // 新副本认识白名单中的墓碑标记；其余任何 __ 前缀字段都意味着来自更新版本、
  // 语义未知的数据，必须在落盘前明确拒绝（由 ingest 外层事务保证不改状态）。
  _validateProtocolMarkers(op) {
    if (this.legacy) return; // 旧副本没有协议标记概念，按普通操作处理（历史行为）
    for (const key of Object.keys(op)) {
      if (key.startsWith("__") && !KNOWN_OP_MARKERS.has(key)) {
        throw new EngineError(
          `操作 ${op.opId} 携带本副本无法识别的协议字段：${key}（需要升级本副本），拒绝摄入`
        );
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
  // 结构/业务非法（不同于“缺前序”）一律抛 EngineError；由调用方决定整批回滚还是降级为墓碑。
  // invalidReason 非空时，该操作以“拒绝墓碑”重放（仅装载持久化的墓碑时使用）。
  _apply(op, { selfClock = null, invalidReason = null } = {}) {
    if (this.rt.applied.has(op.opId)) return { duplicate: true };

    const selfVc = selfClock || vcMerge(op.vclock, { [op.site]: op.seq });
    const entry = { op };
    if (invalidReason) {
      entry.invalid = true;
      entry.invalidReason = invalidReason;
    } else {
      const write = { value: undefined, vc: selfVc, opId: op.opId, site: op.site, at: op.at };
      this._dispatch(op, write);
    }

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
  // 站内序号严格连续；但对不支持墓碑的旧副本，墓碑及其因果后继一律不导出，
  // 只给它“每个站点首个墓碑之前”的安全前缀——旧副本看到的是连续无洞、且可正常
  // 应用的操作，不会把墓碑误当普通操作执行而整包失败。
  // opts.capabilities.tombstones=false 表示对端是旧副本。
  opsSince(theirVclock = {}, opts = {}) {
    const seedCount = seedOps().length;
    const supportTombstones = opts.capabilities ? !!opts.capabilities.tombstones : true;

    // 每个站点第一个墓碑序号：该站点 seq>=cutoff 的操作都依赖墓碑，不能给旧副本。
    const firstInvalidSeq = {};
    if (!supportTombstones) {
      for (const entry of this.rt.applied.values()) {
        if (!entry.invalid) continue;
        const prev = firstInvalidSeq[entry.op.site];
        if (prev === undefined || entry.op.seq < prev) firstInvalidSeq[entry.op.site] = entry.op.seq;
      }
    }

    const ops = [];
    for (const entry of this.rt.applied.values()) {
      if (entry.op.site === "seed" && entry.op.seq <= seedCount) continue;
      if ((theirVclock[entry.op.site] || 0) >= entry.op.seq) continue;
      if (!supportTombstones && this._dependsOnTombstone(entry.op, firstInvalidSeq)) continue;
      ops.push(entry.invalid ? markInvalid(cleanOp(entry.op), entry.invalidReason) : cleanOp(entry.op));
    }
    ops.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : a.seq - b.seq));
    return ops;
  }

  // 操作是否因果依赖任一墓碑：本站点 seq 越过 cutoff，或向量时钟里某站点分量越过其 cutoff。
  _dependsOnTombstone(op, firstInvalidSeq) {
    const localCut = firstInvalidSeq[op.site];
    if (localCut !== undefined && op.seq >= localCut) return true;
    for (const [site, seq] of Object.entries(op.vclock || {})) {
      const cut = firstInvalidSeq[site];
      if (cut !== undefined && seq >= cut) return true;
    }
    return false;
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
    const entries = [...this.rt.applied.values()].filter(
      (entry) => !(entry.op.site === "seed" && entry.op.seq <= seedCount)
    );
    const invalidById = new Map(
      entries.filter((entry) => entry.invalid).map((entry) => [entry.op.opId, entry.invalidReason || ""])
    );
    const ops = topoOrder(entries.map((entry) => cleanOp(entry.op)));
    for (const op of ops) {
      fresh._apply(op, invalidById.has(op.opId) ? { invalidReason: invalidById.get(op.opId) } : {});
    }
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
    const invalid = [...this.rt.applied.values()]
      .filter((entry) => entry.invalid)
      .map((entry) => ({ opId: entry.op.opId, reason: entry.invalidReason || "" }));
    return {
      site: this.site,
      vclock: { ...this.rt.vclock },
      heads: [...this.rt.heads],
      applied: this.rt.applied.size,
      quarantined: [...this.quarantine.keys()],
      invalid,
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

// 同步报文中的临时标记，不进操作日志本体：
// __invalid=true 表示这是上游已确认的“拒绝墓碑”，接收方直接占位、不再分发。
function markInvalid(op, reason) {
  return { ...op, __invalid: true, __invalidReason: reason || "" };
}

function isInvalidMarked(op) {
  return op && op.__invalid === true;
}

function cleanOp(op) {
  const { _selfClock, __invalid, __invalidReason, ...rest } = op;
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
