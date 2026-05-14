# Excel 上传建表 + 表管理 + 元数据管理

## 概述

为 HK POC 增加用户自助上传 Excel 建表功能，包含表管理界面和元数据编辑，上传的表自动参与 nl2sql 查询。在 POC 层（Go 后端 + React 前端）自包含实现，不改动 Catalog/moi-core 镜像。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 实现层 | POC 层自包含 | Explore 的 FetchSchema 直接查 `information_schema`，不需要 Catalog 注册 |
| 建表方式 | 自动推断 + 预览确认 | 用户可微调列类型和填写注释 |
| Excel 格式 | 首行列名，单 sheet | 最简约束，覆盖主要场景 |
| 表管理范围 | 仅管理用户上传的表 | 系统预置表不可编辑/删除 |
| 查询集成 | 自动加入 table_list，可取消勾选 | 上传即可查，降低使用门槛 |
| 元数据范围 | 表注释 + 列注释 | 直接影响 nl2sql 质量的核心元数据 |

## 数据流

```
用户拖拽 Excel
    ↓
POST /api/user-tables/preview (multipart/form-data)
    ↓ Go: excelize 解析第一个 sheet
    ↓ 读首行 → 列名，扫描前 1000 行 → 推断类型
    ↓ 返回: { columns, preview_rows, total_rows, file_key }
    ↓
前端展示预览面板：列名 / 推断类型(可改) / 表注释 / 列注释(可填)
    ↓ 用户确认
POST /api/user-tables/create
    ↓ body: { table_name, table_comment, columns, file_key }
    ↓ Go: CREATE TABLE → LOAD DATA → COMMENT ON COLUMN
    ↓ 在 poc_user_tables 注册记录
    ↓ 返回: { table_name, row_count }
    ↓
TableSelector 动态刷新 → 新表自动出现在可选列表
    ↓
用户发起 nl2sql 查询 → Explore FetchSchema 从 information_schema 读到新表 → 正常生成 SQL
```

## 后端 API

### 端点列表

| 方法 | 路径 | 功能 |
|------|------|------|
| `POST` | `/api/user-tables/preview` | 上传 Excel，返回推断的 schema + 预览数据 |
| `POST` | `/api/user-tables/create` | 确认建表并导入数据 |
| `GET` | `/api/user-tables` | 列出所有用户上传的表 |
| `DELETE` | `/api/user-tables/{name}` | 删除用户表（DROP TABLE + 删元数据） |
| `PATCH` | `/api/user-tables/{name}/metadata` | 更新表注释和列注释 |
| `GET` | `/api/user-tables/{name}/preview` | 预览表数据（前 100 行） |

### 请求/响应结构

**POST /preview** — multipart/form-data，字段 `file`（xlsx）

```json
{
  "file_key": "upload-uuid",
  "sheet_name": "Sheet1",
  "columns": [
    {"name": "stock_code", "inferred_type": "VARCHAR(20)", "samples": ["00001","00005"]},
    {"name": "price", "inferred_type": "DECIMAL(12,4)", "samples": ["123.45","67.80"]}
  ],
  "preview_rows": [["00001","123.45"], ...],
  "total_rows": 5000
}
```

**POST /create**

```json
// Request
{
  "file_key": "upload-uuid",
  "table_name": "my_custom_data",
  "table_comment": "自定义研究数据",
  "columns": [
    {"name": "stock_code", "type": "VARCHAR(20)", "comment": "股票代码"},
    {"name": "price", "type": "DECIMAL(12,4)", "comment": "收盘价"}
  ]
}
// Response
{ "table_name": "my_custom_data", "row_count": 5000 }
```

**PATCH /{name}/metadata**

```json
{
  "table_comment": "更新后的描述",
  "columns": [
    {"name": "stock_code", "comment": "5位港股代码"},
    {"name": "price", "comment": "当日收盘价(港币)"}
  ]
}
```

### 类型推断规则

扫描前 1000 行，按优先级匹配：

1. 全为空 → `VARCHAR(255)`
2. 全为整数 → `BIGINT`
3. 全为数字（含小数） → `DECIMAL(18,6)`
4. 匹配 `YYYY-MM-DD HH:MM:SS` → `DATETIME`
5. 匹配 `YYYY-MM-DD` → `DATE`
6. 其余 → `VARCHAR(N)` 其中 N = max(实际最长 * 2, 255)

### 元数据表 DDL

```sql
CREATE TABLE IF NOT EXISTS poc_user_tables (
  table_name VARCHAR(128) PRIMARY KEY,
  table_comment VARCHAR(512) DEFAULT '',
  row_count BIGINT DEFAULT 0,
  created_at DATETIME DEFAULT NOW()
);
```

### 安全约束

- `table_name` 校验：仅允许 `[a-z0-9_]`，长度 1-64，不能和系统表重名
- 文件大小限制：50MB
- 临时文件 10 分钟未确认自动清理（后台 goroutine）
- `DELETE` 操作只允许删除 `poc_user_tables` 中存在的表

### 对现有 /api/tables 的改造

现有 `/api/tables` 从硬编码改为系统表 + 用户表合并返回：

- 系统表仍硬编码，加 `"source": "system"` 标记
- 用户表从 `poc_user_tables` 查询，加 `"source": "user"` 标记
- Explore 请求的 `table_list` 动态合并用户表

### 新增 Go 文件

| 文件 | 职责 |
|------|------|
| `user_tables_handler.go` | HTTP 路由分发 + 参数校验 |
| `user_tables.go` | 核心逻辑：Excel 解析、类型推断、建表、导入、元数据 CRUD |

## 前端设计

### 新增组件

| 组件 | 功能 |
|------|------|
| `UserTablePanel.tsx` | 侧滑面板，表列表 + 上传入口（类似 KnowledgePanel） |
| `ExcelUploadDialog.tsx` | 拖拽上传 → 预览确认 → 建表的完整流程 |
| `ColumnMetaEditor.tsx` | 编辑已有表的列注释和表注释 |

### 交互流程

**表管理面板 (UserTablePanel)**

- 顶部导航栏新增"数据表管理"按钮，点击打开侧滑面板
- 面板内展示用户上传的表卡片列表
- 每张卡片显示：表名、行数、创建时间、操作按钮（编辑元数据/预览/删除）
- 顶部 [+ 上传 Excel] 按钮触发上传对话框

**上传流程 (ExcelUploadDialog)**

1. 拖拽/选择 xlsx 文件 → 调 `POST /api/user-tables/preview`
2. 预览确认界面：表名输入、表注释输入、列表格（列名/类型下拉/列注释）、前 20 行数据预览
3. 确认 → 调 `POST /api/user-tables/create` → 完成提示 → 自动刷新列表

**元数据编辑 (ColumnMetaEditor)**

- 点击"编辑元数据"展开内联编辑器
- 表注释：单行输入框
- 列注释：每列一行，列名(只读) | 类型(只读) | 注释(可编辑)
- 底部 [保存] 按钮 → 调 `PATCH /api/user-tables/{name}/metadata`

### 对现有组件的改动

| 组件 | 改动 |
|------|------|
| `App.tsx` | 顶部导航增加"数据表管理"按钮，引入 UserTablePanel |
| `TableSelector.tsx` | 返回数据增加 `source` 字段，用户表可加不同样式标记 |

### 新增文件

| 文件 | 职责 |
|------|------|
| `api/userTables.ts` | 封装所有 `/api/user-tables/*` 的 fetch 调用 |
| `components/UserTablePanel.tsx` | 表管理侧滑面板 |
| `components/ExcelUploadDialog.tsx` | 上传预览确认对话框 |
| `components/ColumnMetaEditor.tsx` | 列注释编辑器 |

### i18n

在 `i18n/index.ts` 增加：`tableManagement`, `uploadExcel`, `confirmCreate`, `editMetadata`, `deleteTable`, `tableName`, `tableComment`, `columnComment`, `inferredType`, `previewData` 等中英文 key。

## 不做的事

- 不改 Catalog/moi-core 镜像
- 不支持多 sheet、CSV 等其他格式
- 不做知识库自动联动（用户可手动通过知识库面板添加 glossary）
- 不做数据重新上传/追加
- 不做列类型修改（建表后不可改列类型，只能删表重建）
