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
    "invalid": [{ "opId": "badX:2", "reason": "实体不存在" }],
    "peers": { "hallB": { "vclock": { "hallB": 9 }, "lastAt": "..." } },
    "conflicts": 1,
    "stateHash": "…",
    "replayHash": "…",
    "replayConvergent": true,
    "protocol": 3,
    "capabilities": { "tombstones": true, "conflicts": true }
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
  `rejected`：补链时被确认非法、以“拒绝墓碑”占位的操作（详见 `/sync/push`）。
- 同一组操作无论以什么顺序、分多少批到达，最终状态哈希与冲突集合完全一致，在线投影与重放投影一致。
- 网络中断返回 `502 { error, partial, retryable:true }`：已生效进度保留，重试自动续传。

### 5. `POST /sync/pull` —— 增量拉取原语（带能力协商）

请求：

```json
{ "site": "请求方馆号", "vclock": { "hallA": 12 }, "capabilities": { "tombstones": true } }
```

响应：

```json
{
  "ops": [ "...请求方缺失且其能力可安全接收的操作..." ],
  "peerVclock": { "...本馆当前时钟..." },
  "protocol": 3,
  "capabilities": { "tombstones": true, "conflicts": true }
}
```

- `vclock` 省略或给 `{}` 表示要全部非 seed 操作（新馆初始化用）。
- **能力协商（跨版本兼容）**：
  - 新副本（协议 v3）请求时带 `capabilities.tombstones: true`，可收到带墓碑标记的操作；
  - 旧副本（协议 v2）不发送 `capabilities` 或发送 `tombstones:false`，导出方据此
    **裁剪掉所有墓碑以及因果上依赖墓碑的后继**，只返回“每个站点首个墓碑之前”的连续安全前缀，
    保证旧副本不会收到它无法解释的协议数据、不会整包失败；
  - 旧副本升级为新版后，正常声明 `tombstones:true` 再拉一次，被裁剪的墓碑与后继自动补齐，最终收敛。

### 6. `POST /sync/push` —— 幂等推送原语

请求 `{ "site": "发送方馆号", "ops": [ ... ], "capabilities": { "tombstones": true } }`，
响应 `{ data: <摄入报告>, peerVclock, protocol, capabilities }`。

- 同一 `opId` 重复投递（重发、批内重复）只生效一次，计入 `duplicate`。
- 缺前序的操作计入 `quarantined` 并在 `missing` 给出缺口，补链后自动按原因果顺序生效。
- **整包原子**：一批里只要有一条非法操作（未知类型、不可写字段、合法因果序下实体仍不存在等），
  整批返回 `409`，**包括同包内完全合法的操作在内，一条都不生效、不进日志、不改隔离区**；
  发送方剔除/修正非法项后原样重发即可。单条 `field.update` 内合法与非法字段混合时，
  合法字段同样不会部分写入。
- **先隔离、后补链的坏操作不永久阻塞**：一条非法操作若先因缺前序进入隔离区，
  等前序补齐、它被排空时会被**明确拒绝并移出隔离区**：
  - 同批补来的合法前序正常生效（不会被坏后继连累回滚）；
  - 坏操作以“拒绝墓碑”占位：进入操作日志、占住站内序号（使后继不再断链）、不产生任何业务状态，
    计入响应 `rejected`，原因在 `rejectionReasons[opId]`，并可在 `GET /sync/status` 的 `invalid` 中查到；
  - 墓碑只向**声明了 `tombstones` 能力的新副本**传播（操作带 `__invalid` 标记，接收方确定性占位、
    不再报 409）；旧副本经能力协商收不到墓碑及后继，升级后自动补齐（见 pull）；
  - **无法安全识别的协议数据 fail-closed**：操作上出现本副本不认识的 `__` 前缀字段
    （来自更新版本的协议扩展）时，整包 `409` 拒绝、不改动任何已落盘状态；
  - 重发合法前序是幂等的，坏操作不会再回到隔离区。
- 同一组合法操作只改变投递顺序或分批方式，最终得到**同一状态哈希与同一冲突集合**，
  且在线投影与重放投影一致。
- 同一 `opId` 内容不一致（损坏/伪造）：整包 `409` 拒绝，不产生任何效果，可安全重发。
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
   补链时发现某条操作本身非法（实体不存在、不可写字段、未知类型等），该操作被明确拒绝、
   移出隔离区并立“拒绝墓碑”占位，不连累同批合法前序，也不会永久卡住后续同步。
4. **重复报文只生效一次**：以 `opId` 幂等；同号异容整包拒绝。
5. **中断可续传**：向量时钟即续传游标；进度逐条落盘。
6. **任意馆重放收敛**：操作序与默认决胜规则完全确定，`stateHash` 最终一致。
7. **无半套落盘**：tmp + rename 原子写；业务/同步失败回滚内存与磁盘事务。
