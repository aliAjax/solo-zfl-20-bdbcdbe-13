"use strict";

// 同步信封 fail-closed 回归：
//   pull / push / exchange 三个入口在任何写入（及 pull 的读取裁剪）前都必须校验：
//     - 顶层信封字段白名单；
//     - capabilities 只含已声明能力键；
//     - 操作 payload 任意层级不含未知 __ 协议字段。
//   任一不满足 -> 409，状态哈希与隔离区都不变；已声明能力内的正常信封照常通过。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateEnvelope, EngineError, Engine } = require("../lib/engine");

test("validateEnvelope：白名单内字段通过", () => {
  assert.doesNotThrow(() => validateEnvelope("pull", { site: "a", vclock: {}, capabilities: { tombstones: true, conflicts: false } }));
  assert.doesNotThrow(() => validateEnvelope("pull", {}));
  assert.doesNotThrow(() => validateEnvelope("push", { site: "a", ops: [] }));
  assert.doesNotThrow(() => validateEnvelope("push", { site: "a", ops: [], capabilities: { tombstones: false } }));
  assert.doesNotThrow(() => validateEnvelope("exchange", { peer: "b" }));
  assert.doesNotThrow(() => validateEnvelope("exchange", { peer: "b", url: "http://x" }));
});

test("validateEnvelope：未知顶层字段（含 __ 协议字段与普通拼错字段）一律 409", () => {
  assert.throws(() => validateEnvelope("pull", { vclock: {}, __future: 1 }), (e) => e instanceof EngineError && e.status === 409);
  assert.throws(() => validateEnvelope("pull", { site: "a", vclock: {}, vclock2: {} }), /vclock2/);
  assert.throws(() => validateEnvelope("push", { site: "a", ops: [], dryRun: true }), /dryRun/);
  assert.throws(() => validateEnvelope("push", { ops: [], __compress: "zstd" }), /__compress/);
  assert.throws(() => validateEnvelope("exchange", { peer: "b", mode: "future" }), /mode/);
});

test("validateEnvelope：未知能力键拒绝；已知键允许且不强制取值", () => {
  assert.throws(() => validateEnvelope("pull", { capabilities: { tombstones: true, teleport: true } }), /capabilities\.teleport/);
  assert.throws(() => validateEnvelope("push", { capabilities: { encryption: "rot13" } }), /capabilities\.encryption/);
  assert.doesNotThrow(() => validateEnvelope("push", { capabilities: { tombstones: 0, conflicts: 0 } }));
  assert.throws(() => validateEnvelope("push", { capabilities: [] }), /capabilities 必须是对象/);
  assert.throws(() => validateEnvelope("push", { capabilities: "yes" }), /capabilities 必须是对象/);
});

test("validateEnvelope：非对象信封 400；未知入口 400", () => {
  assert.throws(() => validateEnvelope("pull", null), /JSON 对象/);
  assert.throws(() => validateEnvelope("push", []), /JSON 对象/);
  assert.throws(() => validateEnvelope("push", "x"), /JSON 对象/);
  assert.throws(() => validateEnvelope("bogus", {}), /未知同步入口/);
});

test("操作 payload 嵌套未知标记被引擎在写入前拒绝", () => {
  const e = new Engine("nc").seed();
  const before = e.stateHash();
  const base = {
    opId: "z:1",
    site: "z",
    seq: 1,
    type: "field.update",
    payload: { entity: "damages", entityId: "damage_demo_1", fields: { repairNote: "x" } },
    vclock: { seed: 3 },
    causes: ["seed:3"],
    at: "t"
  };
  const nested = JSON.parse(JSON.stringify(base));
  nested.payload.fields.__future = { algo: "x" };
  assert.throws(() => e.ingest([nested]), /payload\.fields\.__future/);
  assert.equal(e.stateHash(), before);
  assert.equal(e.meta().applied, 3);

  // 同包合法操作也不落地
  const good = { ...base, opId: "z:2", seq: 2, vclock: { seed: 3, z: 1 }, causes: ["z:1"] };
  assert.throws(() => e.ingest([good, nested]), /__future/);
  assert.equal(e.stateHash(), before);
});
