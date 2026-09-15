# 古籍拓片缺损修补 API（多馆离线协作版）

零依赖 Node 服务。每个馆持有完整副本，**断网时照常登记**拓片、缺损、批次和质检结果；
联网后双向增量同步，基于向量时钟与每字段多值寄存器保证：

- 每条操作带因果版本，**后到的旧操作不能覆盖较新结果**；
- 同一字段被并发修改时**双方都保留为冲突**，等待人工裁决，绝不静默丢一边；
- 缺前序的操作先**隔离**，补链后按原因果顺序生效；
- 同步**中断可续传**，重复报文**只生效一次**；
- 任一馆重放全部操作，最终收敛到同一状态（`stateHash` 一致）；
- 临时文件 + 原子 rename 落盘，落盘/同步失败不留半套。

## 快速开始

```bash
# 单馆（兼容旧用法，默认数据目录 ./data）
PORT=3020 SITE=hallA node server.js

# 第二个馆
SITE=hallB PORT=3021 DATA_DIR=./data/hallB \
  SYNC_PEERS="hallA=http://127.0.0.1:3020" node server.js

# 双向同步一次（也可定时/cron 调用，失败自动留进度，重跑续传）
node scripts/sync-once.js --local http://127.0.0.1:3021 --peer hallA

# 自动化测试（分区/乱序/重复/续传/冲突/回滚/收敛/旧接口兼容/旧库迁移）
npm test
```

旧版 `data/db.json` 在首次启动时自动迁移为因果操作日志，旧接口路径与响应结构不变。

## 文档

- [多馆部署与启动说明](docs/SETUP.md)
- [接口文档](docs/API.md)

## 主要接口

旧接口（保持不变）：

- `GET /health`
- `GET/POST /rubbings`，`GET/POST /rubbings/:id/damages`
- `GET /damages?status=&type=`，`PATCH /damages/:id`
- `GET/POST /batches`，`GET /batches/:id`，`POST /batches/:id/complete`

多馆协作新增：

- `POST /inspections`、`GET /inspections?damageId=&batchId=&result=` —— 质检登记与查询
- `POST /sync/exchange` —— 双向增量同步（自动补链/幂等/续传）
- `POST /sync/pull`、`POST /sync/push` —— 增量同步原语
- `GET /sync/status` —— 向量时钟、隔离区、冲突数、在线/重放双哈希
- `GET /conflicts`、`POST /conflicts/resolve` —— 冲突列表与人工裁决
- `GET /quarantine`、`GET /versions?entity=&id=` —— 隔离区与字段级版本

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
```
