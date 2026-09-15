"use strict";

// 原子持久化：所有状态写入 data/state.json，先写同目录临时文件再 rename。
// rename 在同一文件系统上是原子的：要么旧文件、要么新文件，绝不会出现半套 JSON。
// 同步中断/崩溃后重启，读到的永远是上一次完整落盘的快照。

const { readFile, writeFile, rename, mkdir, rm } = require("fs/promises");
const path = require("path");
const { seedOps } = require("./engine");

const STATE_FILE = "state.json";
const TMP_FILE = "state.json.tmp";
const LEGACY_FILE = "db.json";

class Store {
  constructor(dataDir, { failWrites = 0 } = {}) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, STATE_FILE);
    this.tmpPath = path.join(dataDir, TMP_FILE);
    this.legacyPath = path.join(dataDir, LEGACY_FILE);
    // 测试用：前 failWrites 次落盘故意失败，验证调用方不会留下半套状态
    this.failWrites = failWrites;
  }

  // 返回 { snapshot, migrated }；无任何文件时返回 null（由上层播种）
  async load() {
    try {
      const raw = await readFile(this.statePath, "utf8");
      return { snapshot: JSON.parse(raw), migrated: false };
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (error instanceof SyntaxError) throw new Error(`状态文件损坏：${this.statePath}`);
        throw error;
      }
    }
    // 旧版 db.json 一次性迁移：把行数据重述为 seed 站点的因果操作
    try {
      const raw = await readFile(this.legacyPath, "utf8");
      const db = JSON.parse(raw);
      return { snapshot: migrateLegacyDb(db), migrated: true };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(snapshot) {
    await mkdir(this.dataDir, { recursive: true });
    const payload = JSON.stringify(snapshot, null, 2);
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      // 模拟“写到一半磁盘故障”：残留临时文件，但 state.json 保持上一版完好
      await writeFile(this.tmpPath, payload.slice(0, Math.floor(payload.length / 2)));
      const error = new Error("模拟磁盘故障：落盘失败");
      error.code = "EIO";
      throw error;
    }
    await writeFile(this.tmpPath, payload);
    await rename(this.tmpPath, this.statePath);
  }

  async cleanupTmp() {
    await rm(this.tmpPath, { force: true });
  }
}

// ---- v1 db.json -> 因果操作日志 ----
// 迁移结果只取决于文件内容，因此各馆对同一份旧数据独立迁移也得到完全相同的操作流。
function migrateLegacyDb(db) {
  const ops = seedOps();
  const have = new Set(ops.map((op) => op.payload.id));

  // 以 seed 站点续写公共前史，严格串行，任何一步的前序都齐全
  let clock = { seed: ops.length };
  let prev = ops[ops.length - 1].opId;
  const at = "2026-06-16T00:00:00.000Z";

  const emit = (type, payload) => {
    const seq = clock.seed + 1;
    const vclock = { ...clock };
    ops.push({ opId: `seed:${seq}`, site: "seed", seq, type, payload, vclock, causes: [prev], at });
    clock = { seed: seq };
    prev = `seed:${seq}`;
  };

  const rubbings = [...(db.rubbings || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const row of rubbings) {
    if (have.has(row.id)) continue;
    emit("rubbing.create", {
      id: row.id,
      fields: {
        code: row.code,
        source: row.source,
        paperSize: row.paperSize,
        note: row.note || "",
        createdAt: row.createdAt || at
      }
    });
    have.add(row.id);
  }

  const damages = [...(db.damages || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const row of damages) {
    if (have.has(row.id)) continue;
    emit("damage.create", {
      id: row.id,
      fields: {
        rubbingId: row.rubbingId,
        position: row.position,
        type: row.type,
        beforePhotoUrl: row.beforePhotoUrl,
        afterPhotoUrl: row.afterPhotoUrl || "",
        status: row.status || "pending",
        repairNote: row.repairNote || "",
        batchId: row.batchId ?? null,
        createdAt: row.createdAt || at,
        repairedAt: row.repairedAt ?? null
      }
    });
    have.add(row.id);
  }

  const batches = [...(db.batches || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const row of batches) {
    if (have.has(row.id)) continue;
    emit("batch.create", {
      id: row.id,
      name: row.name,
      damageIds: row.damageIds || [],
      note: row.note || ""
    });
    if (row.status === "completed") {
      emit("batch.complete", {
        id: row.id,
        results: (row.damageIds || []).map((damageId) => {
          const dmg = db.damages.find((item) => item.id === damageId) || {};
          return {
            damageId,
            afterPhotoUrl: dmg.afterPhotoUrl || "",
            repairNote: dmg.repairNote || ""
          };
        }),
        note: row.note || ""
      });
    }
    have.add(row.id);
  }

  return {
    version: 2,
    site: "seed", // 仅占位；装载时以各馆自己的馆号为准
    ops,
    quarantine: [],
    peers: {},
    migratedFromLegacy: true
  };
}

module.exports = { Store, migrateLegacyDb, STATE_FILE };
