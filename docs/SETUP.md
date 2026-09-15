# 多馆离线协作部署说明

每个馆运行**一个完整副本**：独立数据目录、独立馆号（`SITE`），拥有拓片、缺损、批次、质检的全部数据。
断网期间照常登记，所有变更以因果操作形式落盘；联网后双向增量同步。零外部依赖，Node ≥ 18 即可。

## 1. 核心概念（运维必读）

- **操作（op）**：每一次登记/修改/完工/质检/裁决都是一条不可变操作，带 `opId = 馆号:序号`、
  向量时钟 `vclock` 和直接前序 `causes`。
- **向量时钟**：记录“本馆见过各馆到第几号”。同步按它裁剪增量、判定新旧与并发。
- **冲突**：两个馆在**互不感知**时改了同一字段，两边都是有效结果，系统**不选边、不丢数据**，
  字段成为多值寄存器，默认展示值由全局确定规则产生（两馆算出的默认值相同），
  并在 `GET /conflicts` 列出，等人工裁决。
- **隔离区（quarantine）**：收到缺少前序的操作时先隔离，不提前生效；前序补齐后自动排空，
  严格按原因果顺序生效。`GET /quarantine` 可查。
- **收敛**：所有馆最终收到同一组操作后，投影状态与 `stateHash` 完全一致。
  `GET /sync/status` 同时给出在线投影哈希和**重放哈希**，两者应始终相等。

## 2. 单机起多个馆（试运行）

```bash
# 甲馆
SITE=hallA PORT=3020 DATA_DIR=./data/hallA node server.js
# 乙馆（另开终端）
SITE=hallB PORT=3021 DATA_DIR=./data/hallB \
  SYNC_PEERS="hallA=http://127.0.0.1:3020" node server.js
```

首次启动若 `DATA_DIR` 为空，会自动播种公共演示数据（`seed:1..3`，所有馆字节一致）。
若目录里存在旧版 `db.json`，启动时**一次性迁移**为因果操作日志（旧文件不删除，可自行备份后移除）。

## 3. 多机部署（正式）

每台机器：

```bash
SITE=hallA \
PORT=3020 \
DATA_DIR=/var/lib/rubbing-repair \
SYNC_PEERS="hallB=http://10.0.0.11:3020,hallC=http://10.0.0.12:3020" \
node server.js
```

- 馆号 `SITE` **全局唯一且不可改名**（只允许字母数字、`_`、`-`，最长 32；保留名 `seed` 不可用）。
  馆号会写进每条操作的身份，改名等于另一个新馆。
- 建议放在 nginx/Caddy 反向代理后加访问控制；同步接口本身只信任报文中的操作签名身份（`opId`），
  网络层应自行保证对端可信（内网/VPN/隧道）。
- 时间戳仅用于展示与排序，**不参与因果判定**，各馆时钟有偏差不影响一致性。

### 用 systemd 常驻

```ini
# /etc/systemd/system/rubbing-repair.service
[Unit]
Description=Rubbing repair replica
After=network-online.target

[Service]
WorkingDirectory=/opt/rubbing-repair
Environment=SITE=hallA
Environment=PORT=3020
Environment=DATA_DIR=/var/lib/rubbing-repair
Environment=SYNC_PEERS=hallB=http://10.0.0.11:3020
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

### 定时增量同步（断网恢复后自动补齐）

```cron
# 每 5 分钟与乙馆双向同步一次；失败退出非零，下次继续，已传进度不重复
*/5 * * * * cd /opt/rubbing-repair && node scripts/sync-once.js \
  --local http://127.0.0.1:3020 --peer hallB >> /var/log/rubbing-sync.log 2>&1
```

也可随时手动触发（见接口文档 `POST /sync/exchange`）。多馆建议两两配通道，或指定一台中继：
操作会随任意路径传播，缺链时自动隔离并在下一轮补链。

## 4. 日常运维

```bash
# 看本馆状态：向量时钟、已生效操作数、隔离区、冲突数、双哈希
curl http://127.0.0.1:3020/sync/status | jq .data

# 看待裁决冲突（同字段并发修改，双值都在）
curl http://127.0.0.1:3020/conflicts | jq .data

# 人工裁决（裁决也是一条因果操作，会同步到所有馆）
curl -X POST http://127.0.0.1:3020/conflicts/resolve \
  -H 'Content-Type: application/json' \
  -d '{"conflictId":"damages.damage_xxx.position","value":"以甲馆现场记录为准","reason":"2026-09 馆长复核"}'

# 看缺前序被隔离的操作（正常会很快自动排空；长期挂起说明某馆长期离线）
curl http://127.0.0.1:3020/quarantine | jq .data
```

健康判定：
- `replayConvergent` 必须为 `true`（在线状态 == 操作日志从头重放的状态）。
- 同步完成后各馆 `stateHash` 相同即数据一致；有未裁决冲突时哈希也会相同
  （冲突本身是所有馆一致保留的确定状态）。

## 5. 崩溃与恢复语义

- 落盘采用 **临时文件 + 原子 rename**：`state.json` 永远是完整 JSON，崩溃最多丢最后一次未落盘变更。
- 本地业务变更“先生效后落盘，落盘失败立即回滚内存”，不会留下半套。
- 同步在任意一步中断：已落盘的操作都在，重连后按向量时钟只补缺口；重复报文靠 `opId` 只生效一次。
- 重启后隔离区同样持久化，补链后自动生效。
- 备份：直接备份 `DATA_DIR/state.json`（单文件）。恢复时停服、放回文件、启动即可。

## 6. 协议版本与新旧副本混用

- 状态快照与同步信封带版本：当前 **协议 v3**（支持拒绝墓碑 tombstones）；升级前的旧副本是 **v2**。
- 能力自动协商：同步时双方在 `/sync/pull`、`/sync/push`、`/sync/status` 上交换
  `protocol` 与 `capabilities`。无需手工配置：
  - **新 ⇄ 新**：墓碑完整传播，确定性占位，收敛一致。
  - **新 ⇄ 旧**：新副本发现对端 `tombstones:false` 后，只向其发送“每个站点首个墓碑之前”
    的连续安全前缀，**不会**把旧端无法解释的墓碑/后继发过去，因此旧端不会整包失败、
    合法前序照常可见，也不会被坏操作卡住。旧端在此期间看到的是数据的一致前缀。
  - **旧端升级后**：它开始声明 `tombstones:true`，下一次同步自动补齐墓碑与后继，
    最终与所有新副本收敛到同一 `stateHash`。升级就是“换新二进制 + 重启”，数据目录不用动。
- **fail-closed**：同步入口在任何写入前做严格信封校验。若请求顶层出现白名单之外的字段
  （pull 仅允许 `site,vclock,capabilities`；push 仅 `site,ops,capabilities`；exchange 仅 `peer,url`）、
  `capabilities` 含未声明的能力键，或操作负载任意层级带有本版本不认识的 `__` 协议字段（来自更高版本），
  整包拒绝（`409`），**状态哈希与隔离区都不变**，而不是猜测语义静默处理；升级该副本后再同步即可。
- 排查看 `/sync/status` 的 `protocol`、`capabilities` 与 `invalid`（本馆确认过的被拒操作墓碑）。

## 7. 新增馆 / 退役馆

- **新增馆**：用一个未用过的 `SITE` 启动空副本（自动播种公共 seed），让它与任一在线馆做一次
  `POST /sync/exchange`，全量操作会增量灌入（空馆视角下全部为增量），哈希一致后即入群。
- **退役馆**：停止同步与服务即可；它产生过的操作已在其他馆留档。**馆号不可复用**给新馆。

## 8. 测试

```bash
npm test
```

覆盖：分区离线登记、乱序隔离补链、重复投递（重发/批内/篡改）、中断重启续传、
字段冲突与人工裁决、迟到旧值不覆盖、落盘失败回滚、三馆链式收敛、旧接口兼容与旧库迁移。
