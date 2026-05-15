# 用户认证 + 会话隔离

## 概述

为 HK POC 增加应用内用户认证系统。Go 后端内置用户表 + 会话 token，前端加登录页。登录后每个用户只能看到自己的对话，知识库和用户表全局共享。

## 认证流程

### 注册 `POST /api/auth/register`

请求 `{ username, password }`。校验：username 3-32 字符 `[a-zA-Z0-9_]`，password >= 6 字符。bcrypt hash（cost=10）存入 `poc_users` 表。返回 201。

### 登录 `POST /api/auth/login`

请求 `{ username, password }`。bcrypt.CompareHashAndPassword 验证。生成 32 bytes 随机 session token（crypto/rand hex 编码）。存入 `poc_sessions` 表，过期时间 7 天。

响应头：`Set-Cookie: poc_token=<token>; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`

响应体：`{ username }`

### 登出 `POST /api/auth/logout`

删除 poc_sessions 记录，清除 cookie。返回 204。

### 身份查询 `GET /api/auth/me`

从 context 取 user_id，返回 `{ username }`。前端刷新时用来恢复登录态。

### Auth Middleware

拦截所有 `/api/*` 请求，排除 `/api/auth/*`。读 Cookie `poc_token` → 查 `poc_sessions` → 校验未过期 → 注入 `user_id` 到 request context。失败返回 401 `{"error":"unauthorized"}`。

## 安全设计

- 密码：bcrypt cost=10，数据库只存 hash
- Token：crypto/rand 32 bytes，非 JWT，无签名密钥管理
- 存储：HttpOnly cookie，前端 JS 无法读取，防 XSS 窃取
- CSRF：SameSite=Lax 防跨站请求
- 过期 session：查询时过滤 `expires_at > NOW()`，后台 goroutine 每小时清理

## 会话隔离

### conversations 表加 user_id

```sql
ALTER TABLE conversations ADD COLUMN user_id VARCHAR(64) DEFAULT '';
```

启动时自动检测列是否存在，不存在则 ALTER。已有会话 user_id 为空串。

### 隔离规则

| 资源 | 隔离 | 说明 |
|------|------|------|
| conversations | 按 user_id | 只能看到/操作自己的对话 |
| messages | 按 conversation owner | 通过 conversation 的 user_id 间接隔离 |
| user-tables | 不隔离 | 上传的数据表全局共享 |
| knowledge | 不隔离 | 知识库全局共享 |
| tables | 不隔离 | 系统表 + 用户表都是全局的 |

### 查询改动

- `GET /api/conversations` → `WHERE user_id = ?`
- `POST /api/conversations` → INSERT 带 user_id
- `GET/PATCH/DELETE /api/conversations/{id}` → 加 `AND user_id = ?` 防越权
- `POST /api/conversations/{id}/messages` → 验证 conversation owner

## 数据库

```sql
CREATE TABLE IF NOT EXISTS poc_users (
    id         VARCHAR(64) PRIMARY KEY,
    username   VARCHAR(32) UNIQUE NOT NULL,
    password   VARCHAR(128) NOT NULL,
    created_at DATETIME DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS poc_sessions (
    token      VARCHAR(128) PRIMARY KEY,
    user_id    VARCHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL
);
```

## 后端文件

| 文件 | 动作 | 职责 |
|------|------|------|
| `auth.go` | 新建 | AuthService：用户注册/登录/登出/查询 + session CRUD + bcrypt + 过期清理 |
| `auth_middleware.go` | 新建 | Cookie 读取 → session 校验 → context 注入 user_id |
| `main.go` | 修改 | 初始化 AuthService，包裹 auth middleware |
| `conversations_db.go` | 修改 | 所有查询方法加 user_id 参数 |
| `conversations_handler.go` | 修改 | 从 context 取 user_id 传给 DB 层 |

## 前端文件

| 文件 | 动作 | 职责 |
|------|------|------|
| `api/auth.ts` | 新建 | login/register/logout/me API 调用 |
| `components/LoginPage.tsx` | 新建 | 登录/注册表单（tab 切换），内联样式 |
| `App.tsx` | 修改 | 启动时 GET /api/auth/me 恢复登录态，未登录渲染 LoginPage |
| `i18n/zh.json` | 修改 | 登录相关翻译 |
| `i18n/en.json` | 修改 | 登录相关翻译 |

## 前端行为

App 启动 → `GET /api/auth/me` → 成功设置 user 状态渲染主界面 → 401 渲染 LoginPage。

LoginPage：tab 切换登录/注册模式。注册成功后自动登录。错误信息内联展示。

Header 右侧显示用户名 + 登出按钮。

## 不做的事

- 不做角色/权限（无 admin）
- 不做修改密码/找回密码
- 不做 CSRF token（HttpOnly + SameSite=Lax 足够）
- 不做 rate limiting（内网环境）
- 不做 refresh token（7 天 session 足够）
