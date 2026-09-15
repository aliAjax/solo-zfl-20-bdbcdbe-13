# 接口文档

所有接口均为 HTTP JSON，基址如 `http://127.0.0.1:3020`。
旧版接口（v1）的路径、方法、状态码与响应结构**完全不变**，下文先列旧接口，再列多馆协作新增接口。

---

## 一、旧接口（保持不变）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回路由表；响应新增 `site` 字段（馆号），不影响旧字段 |
| GET | `/rubbings` | 拓片列表，含 `damageCount` / `pendingDamages` |
| POST | `/rubbings` | 登记拓片，必填 `code,source,paperSize`，可选 `note` |
| GET | `/rubbings/:id/damages` | 某拓片的缺损列表 |
| POST | `/rubbings/:id/damages` | 登记缺损，必填 `position,type,beforePhotoUrl` |
| GET | `/damages?status=&type=` | 按状态/类型筛选缺损 |
| PATCH | `/damages/:id` | 修改缺损，可改 `position,type,beforePhotoUrl,afterPhotoUrl,status,repairNote` |
| GET | `/batches` | 批次列表（enriched：含 `damages,total,repaired,pending`） |
| POST | `/batches` | 建批次，必填 `name,damageIds[]` |
| GET | `/batches/:id` | 批次详情 |
| POST | `/batches/:id/complete` | 批次完工质检登记（见下） |

`POST /batches/:id/complete` 请求体（与旧版一致）：

```json
{
  "note": "批次备注（可选）",
  "defaultAfterPhotoUrl": "https://.../default.jpg",
  "defaultRepairNote": "默认修复说明",
  "results": [
    { "damageId": "damage_...", "afterPhotoUrl": "https://.../x.jpg", "repairNote": "托裱" }
  ]
}
```

> 说明：旧版“批次完工”同时承担了质检结果登记。新版**额外**提供独立质检接口
> （`POST /inspections`），支持一次多条、按缺损/批次查询；旧接口继续可用。

错误约定与旧版一致：`400` 参数/业务校验错误，`404` 实体不存在，响应体形如 `{ "error": "..." }`。

---

## 二、多馆协作新增接口

### 操作报文（同步内部表示）

每条操作的信封：

```json
{
  "opId": "hallA:7",
  "site": "hallA",
  "seq": 7,
  "type": "field.update",
  "payload": { "entity": "damages", "entityId": "damage_...", "fields": { "position": "..." } },
  "vclock": { "seed": 3, "hallA": 6, "hallB": 4 },
  "causes": ["hallA:6", "hallB:4"],
  "at": "2026-09-15T08:00:00.000Z"
}
```

- `seq`：该馆严格递增的站内序号，断网期间也连续。
- `vclock`：操作生效**前**的因果上下文；操作自身时钟为 `vclock + {site:seq}`。
- `causes`：直接前序操作，用于乱序到达时的补链判定。
- 操作类型：`rubbing.create` / `damage.create` / `batch.create` / `batch.complete` /
  `field.update` / `inspection.create` / `conflict.resolve`。

### 1. `POST /inspections` —— 登记质检结果（离线可用）

一次可登记多条；质检记录随操作同步到所有馆。

请求体：

```json
{
  "inspector": "王老师",
  "batchId": "batch_...（可选）",
  "records": [
    { "damageId": "damage_...", "result": "pass", "note": "平整无色差", "batchId": "可选", "inspector": "可覆盖", "at": "可选ISO时间" },
    { "damageId": "damage_...", "result": "fail", "note": "边缘翘起需返工" },
    { "damageId": "damage_...", "result": "rework", "note": "重做托裱" }
  ]
}
```

- `result` 必填，取值 `pass | fail | rework`。
- 响应 `201 { data: [...记录], opId }`；参数错误 `400`。

### 2. `GET /inspections?damageId=&batchId=&result=`

按缺损、批次、结论筛选，返回 `{ data: [...] }`。

### 3. `GET /sync/status` —— 副本状态

```json
{
  "data": {
    "site": "hallA",
    "vclock": { "seed": 3, "hallA": 12, "hallB": 9 },
    "heads": ["hallA:12", "hallB:9"],
    "applied": 24,
    "quarantined": [],
    "peers": { "hallB": { "vclock": { "hallB": 9 }, "lastAt": "..." } },
    "conflicts": 1,
    "stateHash": "…",
    "replayHash": "…",
    "replayConvergent": true
  }
}
```

### 4. `POST /sync/exchange` —— 发起一次双向增量同步（推荐）

由本馆主动连对端，多轮“拉-生效-推”直到双方无增量，自动补链、自动幂等、中断后可续。

请求体：

```json
{ "peer": "hallB", "url": "http://10.0.0.11:3020（可选，缺省查 SYNC_PEERS）" }
```

响应 `200`：

```json
{
  "data": {
    "rounds": 2,
    "pulled": 9,
    "pushed": 7,
    "applied": ["hallB:5", "hallB:6"],
    "duplicate": [],
    "quarantined": [],
    "rejected": [],
    "missing": [],
    "meta": { "...本馆同步后状态..." }
  }
}
```

- `applied`：本轮真正生效的操作；`duplicate`：重复收到、只计一次的操作；
  `quarantined`：缺前序被隔离的操作；`missing`：尚缺的前序 `opId`；
  `rejected`：进了日志但被业务规则拒绝的操作（跨馆确定性拒绝，占用序号）。
- 网络中断返回 `502 { error, partial, retryable:true }`：已生效进度保留，重试自动续传。

### 5. `POST /sync/pull` —— 增量拉取原语

请求 `{ "site": "请求方馆号", "vclock": { "hallA": 12 } }`，
响应 `{ "ops": [ ...请求方缺失的操作 ], "peerVclock": { ...本馆当前时钟 } }`。
`vclock` 省略或给 `{}` 表示要全部非 seed 操作（新馆初始化用）。

### 6. `POST /sync/push` —— 幂等推送原语

请求 `{ "site": "发送方馆号", "ops": [ ... ] }`，响应 `{ data: <摄入报告>, peerVclock }`。

- 同一 `opId` 重复投递（重发、批内重复）只生效一次，计入 `duplicate`。
- 缺前序的操作计入 `quarantined` 并在 `missing` 给出缺口，补链后自动按序生效。
- 同一 `opId` 内容不一致（损坏/伪造）：整包 `409` 拒绝，**不产生任何效果**，可安全重发。
- 批量摄入是一个落盘事务，失败整体回滚。

### 7. `GET /conflicts` —— 待人工裁决的字段冲突

```json
{
  "data": [
    {
      "conflictId": "damages.damage_abc.position",
      "entity": "damages",
      "entityId": "damage_abc",
      "field": "position",
      "winner": { "value": "甲馆描述", "vclock": {}, "opId": "hallA:5", "site": "hallA", "at": "..." },
      "values": [
        { "value": "甲馆描述", "opId": "hallA:5", "site": "hallA", "vclock": {}, "at": "..." },
        { "value": "乙馆描述", "opId": "hallB:3", "site": "hallB", "vclock": {}, "at": "..." }
      ]
    }
  ]
}
```

所有并发值都在 `values` 中，绝不静默丢弃；`winner` 只是两馆一致的默认展示值。

### 8. `POST /conflicts/resolve` —— 人工裁决

```json
{ "conflictId": "damages.damage_abc.position", "value": "最终采用的字段值", "reason": "现场复核（可选）" }
```

也可不用 `conflictId`，直接给 `entity,entityId,field,value`。
裁决是一条向量时钟支配冲突双方的操作，会同步到所有馆；裁决后旧分支的迟到新写入会形成**新的**冲突
而不会悄悄覆盖裁决。成功 `200 { data: { resolved, opId } }`；无冲突可裁返回 `409`。

### 9. `GET /quarantine` —— 隔离区

`{ "data": [ { "opId": "hallA:8", "state": "隔离中：…" } ], "count": 0 }`。

### 10. `GET /versions?entity=&id=` —— 实体逐字段版本

返回每个字段的当前默认版本 `winner` 与全部并存版本（含向量时钟），供审计与前端高亮冲突。

---

## 三、一致性保证小结

1. **后到旧操作不覆盖新结果**：寄存器按向量时钟合并，被支配的旧值丢弃。
2. **同字段并发修改必留冲突**：互不支配的写入全部保留，等待 `/conflicts/resolve`。
3. **缺前序先隔离**：不提前生效；补齐后按原因果顺序（拓扑序 + `(site,seq)` 决胜）排空。
4. **重复报文只生效一次**：以 `opId` 幂等；同号异容整包拒绝。
5. **中断可续传**：向量时钟即续传游标；进度逐条落盘。
6. **任意馆重放收敛**：操作序与默认决胜规则完全确定，`stateHash` 最终一致。
7. **无半套落盘**：tmp + rename 原子写；业务/同步失败回滚内存与磁盘事务。
