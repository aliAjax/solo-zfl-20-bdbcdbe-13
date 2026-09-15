"use strict";

// 副本门面：装载/播种、串行化所有变更、落盘失败整体回滚。
//
// 不变式：
// 1. 内存状态与磁盘状态只差“当前这一次已成功落盘的变更”。任何变更先在引擎内生效，
//    再原子落盘；落盘失败立即用上一份完整快照重建内存，磁盘与内存都不留半套。
// 2. 变更经互斥队列串行执行，两个并发登记不可能基于同一内存前态产生同序号操作。

const { Engine } = require("./engine");
const { Store } = require("./store");

class Replica {
  constructor(site, dataDir, { now, failWrites = 0 } = {}) {
    this.site = site;
    this.store = new Store(dataDir, { failWrites });
    this.now = now || (() => new Date().toISOString());
    this.engine = null;
    this.tail = Promise.resolve();
    this.lastPersisted = null;
    this.idCounter = 0;
  }

  async init() {
    const loaded = await this.store.load();
    this.engine = new Engine(this.site, { now: this.now });
    if (loaded) {
      this.engine.loadSnapshot(loaded.snapshot);
      await this.store.cleanupTmp();
    } else {
      this.engine.seed();
    }
    await this._persist();
    return this;
  }

  // 串行执行一个本地变更。builder 同步读取投影并返回 { type, payload }。
  // builder 抛错（业务校验）不产生任何操作；落盘抛错则回滚到上一快照。
  mutate(builder) {
    const run = this.tail.then(() => {
      let op;
      try {
        const ctx = { makeId: (prefix) => this.makeId(prefix), now: this.now() };
        const spec = builder(this.engine, ctx);
        op = this.engine.nextOp(spec.type, spec.payload);
        this.engine.commitLocal(op); // 业务拒绝在此抛出，引擎内无痕
      } catch (error) {
        return Promise.reject(error);
      }
      return this._persist()
        .then(() => op)
        .catch((error) => {
          this.engine.loadSnapshot(structuredClone(this.lastPersisted));
          throw error;
        });
    });
    // 队列不因单次失败而中断
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // 摄入同步报文（幂等）。操作生效与对端游标更新在同一事务内落盘；
  // 失败整体回滚，发送方可安全重发整包。
  applyRemote(ops, peer) {
    const run = this.tail.then(() => {
      let report;
      try {
        report = this.engine.ingest(ops);
        if (peer) {
          const vclock = {};
          for (const op of ops) vclock[op.site] = Math.max(vclock[op.site] || 0, op.seq);
          this.engine.recordPeer(peer, vclock);
        }
      } catch (error) {
        return Promise.reject(error);
      }
      return this._persist()
        .then(() => report)
        .catch((error) => {
          this.engine.loadSnapshot(structuredClone(this.lastPersisted));
          throw error;
        });
    });
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  makeId(prefix) {
    this.idCounter += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${this.site}_${Date.now().toString(36)}_${this.idCounter}_${rand}`;
  }

  project() {
    return this.engine.project();
  }

  meta() {
    return this.engine.meta();
  }

  conflicts() {
    return this.engine.listConflicts();
  }

  fieldVersion(entity, id) {
    return this.engine.fieldVersion(entity, id);
  }

  stateHash(useReplay = false) {
    return this.engine.stateHash(useReplay);
  }

  replayProject() {
    return this.engine.replay();
  }

  since(vclock) {
    return this.engine.opsSince(vclock);
  }

  _persist() {
    const snapshot = this.engine.toSnapshot();
    return this.store.save(snapshot).then(() => {
      this.lastPersisted = snapshot;
    });
  }
}

module.exports = { Replica };
