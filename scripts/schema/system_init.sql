-- MOI-Core Catalog Service Database Schema
-- Auto-generated from schema definitions
-- DO NOT EDIT MANUALLY - modify pkg/schema/tables.go and run: go run cmd/generate-schema/main.go
--
-- Usage:
--   CREATE DATABASE IF NOT EXISTS your_database;
--   USE your_database;
--   source init.sql;

-- ============================================================================
-- saga_states Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS saga_states (
    saga_id VARCHAR(64) PRIMARY KEY COMMENT 'Saga 唯一标识',
    saga_name VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'Saga 名称',
    status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'Saga 状态: pending, running, completed, failed, compensating, compensated, compensation_failed',
    current_step INT NOT NULL DEFAULT 0 COMMENT '当前执行到的步骤索引',
    context JSON COMMENT 'Saga 上下文数据',
    error TEXT COMMENT '错误信息',
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '开始时间',
    completed_at TIMESTAMP NULL DEFAULT NULL COMMENT '完成时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    version INT NOT NULL DEFAULT 0 COMMENT '乐观锁版本号',
    fence_token BIGINT NOT NULL DEFAULT 0 COMMENT '隔离令牌，防止脑裂',
    executor_id VARCHAR(64) DEFAULT NULL COMMENT '当前执行器ID',
    heartbeat_at TIMESTAMP NULL DEFAULT NULL COMMENT '最后心跳时间',
    compensation_step INT DEFAULT -1 COMMENT '当前补偿到的步骤索引，-1表示未开始补偿',
    INDEX idx_saga_states_name (saga_name),
    INDEX idx_saga_states_status (status),
    INDEX idx_saga_states_started_at (started_at),
    INDEX idx_saga_states_heartbeat (status, heartbeat_at),
    INDEX idx_saga_states_executor (executor_id)
);

-- ============================================================================
-- saga_step_states Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS saga_step_states (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
    saga_id VARCHAR(64) NOT NULL COMMENT 'Saga ID',
    step_name VARCHAR(128) NOT NULL COMMENT '步骤名称',
    step_index INT NOT NULL COMMENT '步骤索引',
    status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '步骤状态: pending, running, completed, failed, skipped, compensating, compensated',
    error TEXT COMMENT '错误信息',
    started_at TIMESTAMP NULL DEFAULT NULL COMMENT '开始时间',
    completed_at TIMESTAMP NULL DEFAULT NULL COMMENT '完成时间',
    retry_count INT NOT NULL DEFAULT 0 COMMENT '重试次数',
    fence_token BIGINT NOT NULL DEFAULT 0 COMMENT '隔离令牌，与 saga_states 同步',
    UNIQUE INDEX idx_saga_step_unique (saga_id, step_index),
    INDEX idx_saga_step_saga_id (saga_id),
    INDEX idx_saga_step_status (status),
    INDEX idx_saga_step_fence (saga_id, fence_token)
);

-- ============================================================================
-- saga_idempotency Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS saga_idempotency (
    idempotency_key VARCHAR(255) PRIMARY KEY COMMENT '幂等键，格式为 saga_id:step_name',
    saga_id VARCHAR(64) NOT NULL COMMENT 'Saga ID',
    step_name VARCHAR(128) NOT NULL COMMENT '步骤名称',
    result JSON COMMENT '执行结果',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_saga_idempotency_saga_id (saga_id)
);

-- ============================================================================
-- users Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(255),
    phone VARCHAR(50),
    status TINYINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_email (email),
    INDEX idx_users_username (username),
    INDEX idx_users_status (status)
);

-- ============================================================================
-- api_keys Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,
    encrypted_key VARCHAR(512) NOT NULL,
    expires_at TIMESTAMP NULL,
    last_used_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_api_keys_user_id (user_id),
    INDEX idx_api_keys_key_prefix (key_prefix)
);

-- ============================================================================
-- workspaces Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS workspaces (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    owner_id VARCHAR(36) NOT NULL,
    account_name VARCHAR(255) NOT NULL UNIQUE,
    status TINYINT NOT NULL DEFAULT 1,
    create_version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    version_offset INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_workspaces_owner_id (owner_id),
    INDEX idx_workspaces_account_name (account_name),
    INDEX idx_workspaces_status (status)
);

-- ============================================================================
-- workspace_users Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS workspace_users (
    id VARCHAR(36) PRIMARY KEY,
    workspace_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    granted_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX idx_workspace_users_unique (workspace_id, user_id),
    INDEX idx_workspace_users_user_id (user_id)
);

-- ============================================================================
-- db_users Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS db_users (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    workspace_id VARCHAR(36) NOT NULL,
    db_username VARCHAR(255) NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE INDEX idx_db_users_unique (user_id, workspace_id),
    INDEX idx_db_users_workspace_id (workspace_id)
);

-- ============================================================================
-- moi_version Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS moi_version (
    version VARCHAR(50) NOT NULL,
    version_offset INT UNSIGNED DEFAULT 0,
    state INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (version, version_offset)
);

-- ============================================================================
-- moi_upgrade Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS moi_upgrade (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY AUTO_INCREMENT,
    from_version VARCHAR(50) NOT NULL,
    to_version VARCHAR(50) NOT NULL,
    final_version VARCHAR(50) NOT NULL,
    final_version_offset INT UNSIGNED DEFAULT 0,
    state INT NOT NULL,
    upgrade_order INT NOT NULL,
    upgrade_system INT NOT NULL,
    upgrade_tenant INT NOT NULL,
    total_tenant INT NOT NULL DEFAULT 0,
    ready_tenant INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================================
-- moi_upgrade_tenant Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS moi_upgrade_tenant (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY AUTO_INCREMENT,
    upgrade_id BIGINT UNSIGNED NOT NULL,
    workspace_id VARCHAR(64) NOT NULL,
    account_name VARCHAR(255) NOT NULL,
    target_version VARCHAR(50) NOT NULL,
    state INT NOT NULL,
    claimed_by VARCHAR(64),
    claimed_at TIMESTAMP NULL,
    heartbeat_at TIMESTAMP NULL,
    attempts INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_upgrade_id (upgrade_id),
    INDEX idx_state (state),
    UNIQUE KEY uk_upgrade_ws (upgrade_id, workspace_id)
);

-- ============================================================================
-- mowl_workflow_definition Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_workflow_definition (
    id VARCHAR(36) NOT NULL PRIMARY KEY COMMENT '工作流定义ID (UUID)',
    workspace_id VARCHAR(36) NOT NULL COMMENT '工作空间ID',
    user_id VARCHAR(36) NOT NULL COMMENT '创建者用户ID，引用 users.id',
    name VARCHAR(256) NOT NULL COMMENT '工作流名称',
    description TEXT COMMENT '工作流描述',
    latest_version INT NOT NULL DEFAULT 0 COMMENT '最新版本号',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE KEY uk_workspace_user_name (workspace_id, user_id, name),
    INDEX idx_workspace_id (workspace_id),
    INDEX idx_user_id (user_id)
) COMMENT='Mowl工作流定义表';

-- ============================================================================
-- mowl_workflow_version Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_workflow_version (
    id VARCHAR(36) NOT NULL PRIMARY KEY COMMENT '版本ID (UUID)',
    workspace_id VARCHAR(36) NOT NULL COMMENT '工作空间ID',
    user_id VARCHAR(36) NOT NULL COMMENT '用户ID，用于用户级别隔离',
    workflow_id VARCHAR(36) NOT NULL COMMENT '工作流定义ID',
    version INT NOT NULL COMMENT '版本号',
    workflow TEXT NOT NULL COMMENT '完整的工作流定义 (JSON)',
    status VARCHAR(16) NOT NULL DEFAULT 'draft' COMMENT '状态: draft/published/deprecated',
    created_by VARCHAR(36) NOT NULL COMMENT '创建者用户ID，引用 users.id',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    published_at TIMESTAMP NULL COMMENT '发布时间',
    type INT NOT NULL DEFAULT 1 COMMENT '工作流类型: 0=UNSPECIFIED, 1=WORKFLOW, 2=DYNAMIC_SERVICE',
    input_schema TEXT NULL COMMENT '输入参数 JSON Schema（动态服务必填）',
    output_schema TEXT NULL COMMENT '输出结果 JSON Schema（动态服务必填）',
    result_mode INT NOT NULL DEFAULT 0 COMMENT '结果返回模式: 0=UNSPECIFIED, 1=ONESHOT, 2=STREAM',
    description TEXT NULL COMMENT '描述信息',
    runtime_spec_json TEXT NULL COMMENT 'JSON-serialized RuntimeSpec for dynamic worker configuration',
    UNIQUE KEY uk_workflow_version (workflow_id, version),
    INDEX idx_workspace_id (workspace_id),
    INDEX idx_user_id (user_id),
    INDEX idx_workflow_id (workflow_id),
    INDEX idx_status (status),
    INDEX idx_created_by (created_by),
    INDEX idx_type (type)
) COMMENT='Mowl工作流版本表';

-- ============================================================================
-- mowl_task Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_task (
    id VARCHAR(36) NOT NULL PRIMARY KEY COMMENT '任务ID (UUID)',
    workspace_id VARCHAR(36) NOT NULL COMMENT '工作空间ID',
    user_id VARCHAR(36) NOT NULL COMMENT '创建者用户ID，引用 users.id',
    name VARCHAR(255) NOT NULL COMMENT '任务名称',
    workflow_version_id VARCHAR(36) NOT NULL COMMENT '工作流版本ID（必填，引用 mowl_workflow_version.id）',
    cron_expression VARCHAR(255) COMMENT 'Cron表达式，用于周期性任务',
    data TEXT COMMENT '任务数据 (JSON)',
    vars TEXT COMMENT '任务变量 (JSON)',
    transient TINYINT(1) COMMENT '是否为临时任务',
    status INT NOT NULL COMMENT '任务状态',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE KEY uk_workspace_user_name (workspace_id, user_id, name),
    INDEX idx_workspace_id (workspace_id),
    INDEX idx_status (status),
    INDEX idx_user_id (user_id),
    INDEX idx_workflow_version_id (workflow_version_id)
) COMMENT='Mowl任务表';

-- ============================================================================
-- mowl_workitem_metadata Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_workitem_metadata (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '自增主键',
    node_id VARCHAR(255) NOT NULL COMMENT '节点标识符，如 datasync:unzip',
    user_id VARCHAR(36) NOT NULL COMMENT '创建者用户ID，引用 users.id',
    isolation_level VARCHAR(50) NOT NULL DEFAULT 'private' COMMENT '隔离级别: public/shared/private',
    description TEXT COMMENT '工作项描述',
    version VARCHAR(50) COMMENT '版本号，如 1.0.0',
    input_schema TEXT COMMENT 'JSON Schema for input validation',
    output_schema TEXT COMMENT 'JSON Schema for output validation',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    deleted_at TIMESTAMP NULL DEFAULT NULL COMMENT '删除时间（软删除）',
    INDEX idx_node_id (node_id),
    INDEX idx_user_id (user_id),
    INDEX idx_isolation_level (isolation_level),
    INDEX idx_deleted_at (deleted_at),
    UNIQUE KEY uk_node_user (node_id, user_id, deleted_at)
) COMMENT='Mowl工作项元数据表';

-- ============================================================================
-- mowl_workitem_shared Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_workitem_shared (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '自增主键',
    workitem_id BIGINT NOT NULL COMMENT '关联到 mowl_workitem_metadata.id',
    node_id VARCHAR(255) NOT NULL COMMENT '节点标识符（冗余字段，便于查询）',
    user_id VARCHAR(36) NOT NULL COMMENT '被共享的用户ID',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    INDEX idx_workitem_id (workitem_id),
    INDEX idx_node_id (node_id),
    INDEX idx_user_id (user_id),
    INDEX idx_node_user (node_id, user_id),
    UNIQUE KEY uk_workitem_user (workitem_id, user_id)
) COMMENT='Mowl工作项共享关系表';

-- ============================================================================
-- mowl_workflow_cases Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_workflow_cases (
    id VARCHAR(36) NOT NULL PRIMARY KEY COMMENT '案例ID (UUID)',
    task_id VARCHAR(36) COMMENT '关联的任务ID',
    server VARCHAR(255) NOT NULL COMMENT '服务器标识',
    workflow TEXT NOT NULL COMMENT '工作流定义 (JSON)',
    data TEXT COMMENT '数据参数 (JSON)',
    vars TEXT COMMENT '变量 (JSON)',
    state TEXT COMMENT '工作流状态 (JSON key-value store)',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    INDEX idx_task_id (task_id)
) COMMENT='Mowl工作流案例表';

-- ============================================================================
-- mowl_case_status Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_case_status (
    case_id VARCHAR(36) NOT NULL PRIMARY KEY COMMENT '案例ID',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    result TEXT COMMENT '执行结果 (JSON)',
    error TEXT COMMENT '错误信息',
    status VARCHAR(255) NOT NULL COMMENT '状态'
) COMMENT='Mowl案例状态表';

-- ============================================================================
-- mowl_case_workitem Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_case_workitem (
    case_id VARCHAR(36) NOT NULL COMMENT '案例ID',
    server VARCHAR(255) NOT NULL COMMENT '服务器标识',
    worker VARCHAR(255) NOT NULL COMMENT 'Worker标识',
    id VARCHAR(36) NOT NULL COMMENT '工作项ID (UUID)',
    parallel_index INT NOT NULL COMMENT '并行索引',
    parallel_total INT NOT NULL COMMENT '并行总数',
    parent_id VARCHAR(36) COMMENT '父工作项ID',
    node TEXT COMMENT '节点定义 (JSON)',
    data TEXT COMMENT '数据参数 (JSON)',
    vars TEXT COMMENT '变量 (JSON)',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    PRIMARY KEY (case_id, id, parallel_index)
) COMMENT='Mowl案例工作项表';

-- ============================================================================
-- mowl_case_workitem_status Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_case_workitem_status (
    case_id VARCHAR(36) NOT NULL COMMENT '案例ID',
    workitem_id VARCHAR(36) NOT NULL COMMENT '工作项ID',
    parallel_index INT NOT NULL COMMENT '并行索引',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    status VARCHAR(255) NOT NULL COMMENT '状态',
    result TEXT COMMENT '执行结果 (JSON)',
    error TEXT COMMENT '错误信息',
    PRIMARY KEY (case_id, workitem_id, parallel_index)
) COMMENT='Mowl案例工作项状态表';

-- ============================================================================
-- mowl_case_token Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_case_token (
    case_id VARCHAR(36) NOT NULL COMMENT '案例ID',
    id VARCHAR(36) NOT NULL COMMENT '令牌ID (UUID)',
    producer TEXT NOT NULL COMMENT '生产者节点名称',
    consumer TEXT NOT NULL COMMENT '消费者节点名称',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    action VARCHAR(255) NOT NULL COMMENT '动作类型: external/internal',
    status VARCHAR(255) NOT NULL COMMENT '状态: pending/completed',
    workitem_id VARCHAR(36) COMMENT '关联的工作项ID',
    parallel_index INT NOT NULL COMMENT '并行索引',
    data TEXT COMMENT '数据 (JSON)',
    vars TEXT COMMENT '变量 (JSON)',
    error TEXT COMMENT '错误信息',
    PRIMARY KEY (case_id, id)
) COMMENT='Mowl案例令牌表';

-- ============================================================================
-- mowl_log Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_log (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '自增主键',
    case_id VARCHAR(36) NOT NULL COMMENT '案例ID',
    workitem_id VARCHAR(36) COMMENT '工作项ID',
    level VARCHAR(255) NOT NULL COMMENT '日志级别',
    file VARCHAR(255) NOT NULL COMMENT '文件名',
    line INT NOT NULL COMMENT '行号',
    message TEXT NOT NULL COMMENT '日志消息',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    INDEX idx_case_id (case_id),
    INDEX idx_created_at (created_at)
) COMMENT='Mowl日志表';

-- ============================================================================
-- mowl_trace Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_trace (
    trace_id VARCHAR(36) NOT NULL PRIMARY KEY COMMENT 'Trace ID (UUID)',
    case_id VARCHAR(36) NOT NULL COMMENT '案例ID',
    task_id VARCHAR(36) NOT NULL COMMENT '任务ID',
    workspace_id VARCHAR(36) NOT NULL COMMENT '工作空间ID',
    user_id VARCHAR(36) NOT NULL COMMENT '用户ID',
    workflow_id VARCHAR(36) COMMENT '工作流ID',
    workflow_version_id VARCHAR(36) COMMENT '工作流版本ID',
    status VARCHAR(32) NOT NULL COMMENT '状态',
    started_at TIMESTAMP NOT NULL COMMENT '开始时间',
    ended_at TIMESTAMP NULL COMMENT '结束时间',
    duration_ms BIGINT COMMENT '耗时毫秒',
    options_json TEXT COMMENT 'TraceOptions JSON',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    INDEX idx_case_id (case_id),
    INDEX idx_workspace_id (workspace_id),
    INDEX idx_task_id (task_id),
    INDEX idx_started_at (started_at)
) COMMENT='Mowl Trace 表';

-- ============================================================================
-- mowl_trace_span Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mowl_trace_span (
    span_id VARCHAR(36) NOT NULL PRIMARY KEY COMMENT 'Span ID (UUID)',
    trace_id VARCHAR(36) NOT NULL COMMENT 'Trace ID',
    parent_span_id VARCHAR(36) COMMENT '父 Span ID',
    case_id VARCHAR(36) NOT NULL COMMENT '案例ID',
    workitem_id VARCHAR(36) COMMENT '工作项ID',
    node_id VARCHAR(255) COMMENT '节点ID',
    worker_id VARCHAR(255) COMMENT 'Worker ID',
    kind VARCHAR(32) NOT NULL COMMENT 'Span 类型',
    name VARCHAR(255) NOT NULL COMMENT 'Span 名称',
    status VARCHAR(32) NOT NULL COMMENT '状态',
    started_at TIMESTAMP NOT NULL COMMENT '开始时间',
    ended_at TIMESTAMP NULL COMMENT '结束时间',
    duration_ms BIGINT COMMENT '耗时毫秒',
    attrs_json TEXT COMMENT 'Span 属性 JSON',
    error TEXT COMMENT '错误信息',
    INDEX idx_trace_id (trace_id),
    INDEX idx_case_id (case_id),
    INDEX idx_parent_span_id (parent_span_id),
    INDEX idx_started_at (started_at)
) COMMENT='Mowl Trace Span 表';

-- ============================================================================
-- moi_function_permissions Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS moi_function_permissions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '权限记录ID',
    permission_code INT NOT NULL COMMENT '权限代码',
    permission_name VARCHAR(100) NOT NULL COMMENT '权限名称',
    description TEXT COMMENT '权限描述',
    category VARCHAR(50) NOT NULL COMMENT '权限分类: workflow/task/workitem',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    UNIQUE KEY uk_permission_code (permission_code),
    INDEX idx_category (category)
) COMMENT='功能权限定义表';

