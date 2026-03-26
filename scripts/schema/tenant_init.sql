-- MOI-Core Tenant Database Schema
-- Auto-generated from schema definitions
-- DO NOT EDIT MANUALLY - modify pkg/schema/tables.go and run: go run cmd/generate-schema/main.go

-- ============================================================================
-- file Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS file (
    file_id VARCHAR(36) PRIMARY KEY COMMENT '文件ID（UUID）',
    original_name VARCHAR(255) NOT NULL COMMENT '原始文件名',
    md5 VARCHAR(32) NOT NULL COMMENT '文件MD5值',
    size BIGINT NOT NULL COMMENT '文件大小（字节）',
    ref_count INT NOT NULL DEFAULT 0 COMMENT '引用计数',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    created_by VARCHAR(64) NOT NULL COMMENT '创建人',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_ref_count_created (ref_count, created_at),
    INDEX idx_md5 (md5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='文件元数据表';

-- ============================================================================
-- catalog Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS catalog (
    catalog_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    catalog_name VARCHAR(255) NOT NULL,
    comment TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by VARCHAR(255) NOT NULL,
    UNIQUE INDEX idx_catalog_name (catalog_name)
);

-- ============================================================================
-- cdh_config Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS cdh_config (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(256) NOT NULL,
    metastore_address VARCHAR(512) NOT NULL DEFAULT '',
    hive_address VARCHAR(512) NOT NULL DEFAULT '',
    connect_timeout INT NOT NULL DEFAULT 10,
    cdh_version VARCHAR(32) NOT NULL DEFAULT '',
    synced_at BIGINT NOT NULL DEFAULT 0,
    kerberos_principal VARCHAR(512) DEFAULT '',
    kerberos_keytab VARCHAR(1024) DEFAULT '',
    sync_task_id VARCHAR(64) DEFAULT '',
    sync_database_name VARCHAR(256) DEFAULT '',
    sync_cron_expression VARCHAR(128) DEFAULT '',
    created_by VARCHAR(256) NOT NULL,
    updated_by VARCHAR(256) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE INDEX idx_name (name)
);

-- ============================================================================
-- mc_config Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS mc_config (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(256) NOT NULL,
    access_key_id VARCHAR(256) NOT NULL,
    access_key_secret VARCHAR(512) NOT NULL,
    endpoint VARCHAR(512) NOT NULL,
    region VARCHAR(128) DEFAULT '',
    project_name VARCHAR(256) DEFAULT '',
    sync_task_id VARCHAR(64) DEFAULT '',
    sync_database_name VARCHAR(256) DEFAULT '',
    sync_cron_expression VARCHAR(128) DEFAULT '',
    created_by VARCHAR(256) NOT NULL,
    updated_by VARCHAR(256) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE INDEX idx_name (name)
);

-- ============================================================================
-- catalog_database Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS catalog_database (
    database_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    catalog_id BIGINT NOT NULL,
    database_name VARCHAR(255) NOT NULL,
    comment TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by VARCHAR(255) NOT NULL,
    source VARCHAR(32) DEFAULT 'matrixone',
    config_id BIGINT DEFAULT 0,
    UNIQUE INDEX idx_catalog_database_unique (catalog_id, database_name),
    INDEX idx_catalog_id (catalog_id),
    INDEX idx_config_id (config_id)
);

-- ============================================================================
-- volume Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS volume (
    volume_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    database_id BIGINT NOT NULL,
    catalog_id BIGINT NOT NULL,
    volume_name VARCHAR(255) NOT NULL,
    comment TEXT,
    save_path VARCHAR(1024),
    status TINYINT NOT NULL DEFAULT 1,
    parent_id BIGINT DEFAULT NULL COMMENT '父Volume ID',
    deleted BOOLEAN NOT NULL DEFAULT FALSE COMMENT '是否已删除',
    deleted_at TIMESTAMP NULL COMMENT '删除时间',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by VARCHAR(255) NOT NULL,
    UNIQUE INDEX idx_volume_unique (database_id, volume_name),
    INDEX idx_database_id (database_id),
    INDEX idx_catalog_id (catalog_id),
    INDEX idx_status (status),
    INDEX idx_parent_id (parent_id),
    INDEX idx_deleted (deleted),
    FOREIGN KEY (parent_id) REFERENCES volume(volume_id)
);

-- ============================================================================
-- volume_files Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS volume_files (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
    volume_id BIGINT NOT NULL COMMENT 'Volume ID',
    file_id VARCHAR(36) NOT NULL COMMENT '文件ID',
    file_name VARCHAR(255) NOT NULL COMMENT '文件在volume中的名称',
    file_path VARCHAR(1024) NOT NULL DEFAULT '' COMMENT '文件在volume中的路径',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    created_by VARCHAR(64) NOT NULL COMMENT '创建人',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    updated_by VARCHAR(64) NOT NULL COMMENT '更新人',
    UNIQUE KEY uk_volume_file (volume_id, file_id),
    INDEX idx_file_id (file_id),
    INDEX idx_volume_id (volume_id),
    FOREIGN KEY (file_id) REFERENCES file(file_id),
    FOREIGN KEY (volume_id) REFERENCES volume(volume_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Volume文件关联表';

-- ============================================================================
-- data_asset Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_asset (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    asset_id VARCHAR(64) NOT NULL COMMENT '对外资产ID',
    name VARCHAR(255) NOT NULL DEFAULT '' COMMENT '资产名称',
    raw_file_id VARCHAR(64) NOT NULL COMMENT '原始文件ID',
    volume_id BIGINT NULL COMMENT '所属卷ID（可选）',
    source VARCHAR(64) NOT NULL DEFAULT '' COMMENT '来源标识',
    meta JSON NULL COMMENT '资产元数据',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE INDEX uk_data_asset_asset_id (asset_id),
    INDEX idx_data_asset_raw_file_id (raw_file_id),
    INDEX idx_data_asset_volume_id (volume_id)
) COMMENT='数据资产表（原始文件到资产映射）';

-- ============================================================================
-- data_derivation Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_derivation (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    asset_id VARCHAR(64) NOT NULL COMMENT '资产ID',
    kind VARCHAR(64) NOT NULL COMMENT '衍生类型（parsed/chunk/embedding等）',
    file_id VARCHAR(64) NOT NULL COMMENT '衍生文件ID',
    meta JSON NULL COMMENT '衍生元数据',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_data_derivation_asset_kind (asset_id, kind),
    INDEX idx_data_derivation_file_id (file_id)
) COMMENT='数据资产衍生表';

-- ============================================================================
-- parsed_manifest Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS parsed_manifest (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    asset_id VARCHAR(64) NOT NULL COMMENT '资产ID',
    raw_file_id VARCHAR(64) NOT NULL COMMENT '原始文件ID',
    parsed_file_id VARCHAR(64) NOT NULL COMMENT '解析文件ID',
    manifest JSON NOT NULL COMMENT '解析结果映射与元数据',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE INDEX uk_parsed_manifest_asset (asset_id),
    INDEX idx_parsed_manifest_raw_file (raw_file_id),
    INDEX idx_parsed_manifest_parsed_file (parsed_file_id)
) COMMENT='解析结果映射表';

-- ============================================================================
-- knowledge_base Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS knowledge_base (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    name VARCHAR(255) NOT NULL COMMENT '知识库名称',
    usage_notes TEXT NULL COMMENT '用途说明',
    tables JSON NULL COMMENT '关联表信息',
    files JSON NULL COMMENT '关联文件信息',
    created_by VARCHAR(64) NOT NULL COMMENT '创建人',
    updated_by VARCHAR(64) NOT NULL COMMENT '更新人',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_knowledge_base_name (name)
) COMMENT='知识库定义表';

-- ============================================================================
-- nl2sql_knowledge Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS nl2sql_knowledge (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    knowledge_base_id BIGINT NOT NULL COMMENT '知识库ID',
    knowledge_type VARCHAR(64) NOT NULL COMMENT '知识类型',
    knowledge_key TEXT NOT NULL COMMENT '知识Key',
    name VARCHAR(255) NULL COMMENT '知识名称',
    knowledge_value JSON NULL COMMENT '知识值',
    associate_tables JSON NULL COMMENT '关联表',
    explanation_type VARCHAR(64) NULL COMMENT '解释类型',
    created_by VARCHAR(64) NOT NULL COMMENT '创建人',
    updated_by VARCHAR(64) NOT NULL COMMENT '更新人',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_nl2sql_kb (knowledge_base_id),
    INDEX idx_nl2sql_type (knowledge_type)
) COMMENT='NL2SQL 知识条目表';

-- ============================================================================
-- volume_workflow_trigger Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS volume_workflow_trigger (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    volume_id BIGINT NOT NULL COMMENT '卷ID',
    workflow_version_id VARCHAR(64) NOT NULL COMMENT '工作流版本ID',
    enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
    vars TEXT COMMENT '传递给工作流的JSON变量',
    created_by VARCHAR(36) NOT NULL COMMENT '创建者ID',
    updated_by VARCHAR(36) NOT NULL COMMENT '更新者ID',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_volume_workflow_trigger_volume_id (volume_id),
    UNIQUE INDEX uk_volume_workflow_trigger (volume_id, workflow_version_id)
) COMMENT='卷触发工作流配置表';

-- ============================================================================
-- volume_trigger_event Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS volume_trigger_event (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    trigger_id BIGINT NOT NULL COMMENT '触发器ID',
    volume_id BIGINT NOT NULL COMMENT '卷ID',
    file_id VARCHAR(64) NOT NULL COMMENT '文件ID',
    status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '状态 pending/processing/done/failed',
    error_message TEXT NULL COMMENT '错误信息',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_volume_trigger_event_status (status),
    INDEX idx_volume_trigger_event_trigger_id (trigger_id),
    INDEX idx_volume_trigger_event_volume_file (volume_id, file_id),
    UNIQUE INDEX uk_volume_trigger_event (trigger_id, file_id)
) COMMENT='卷触发事件表';

-- ============================================================================
-- catalog_table Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS catalog_table (
    table_id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '表ID',
    database_id BIGINT NOT NULL COMMENT '所属数据库ID',
    catalog_id BIGINT NOT NULL COMMENT '所属Catalog ID',
    table_name VARCHAR(255) NOT NULL COMMENT '表名',
    comment TEXT COMMENT '表注释',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    created_by VARCHAR(255) NOT NULL COMMENT '创建人',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    updated_by VARCHAR(255) NOT NULL COMMENT '更新人',
    source VARCHAR(32) DEFAULT 'matrixone' COMMENT '数据来源',
    config_id BIGINT DEFAULT 0 COMMENT '关联的CDH配置ID',
    extra TEXT DEFAULT '' COMMENT 'JSON扩展信息，存储各数据源特有字段（如CDH的table_type、storage_format、hdfs_path等）',
    UNIQUE INDEX idx_catalog_table_unique (database_id, table_name),
    INDEX idx_catalog_table_database_id (database_id),
    INDEX idx_catalog_table_catalog_id (catalog_id),
    INDEX idx_config_id (config_id)
) COMMENT='Catalog表元数据';

-- ============================================================================
-- catalog_column Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS catalog_column (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    config_id BIGINT NOT NULL DEFAULT 0,
    name VARCHAR(256) NOT NULL,
    data_type VARCHAR(256) NOT NULL,
    comment TEXT DEFAULT '',
    ordinal INT NOT NULL,
    table_id BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    INDEX idx_table_id (table_id),
    INDEX idx_config_id (config_id)
);

-- ============================================================================
-- roles Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS roles (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE INDEX idx_roles_name (name)
);

-- ============================================================================
-- role_permissions Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS role_permissions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    role_id BIGINT NOT NULL,
    permission_code INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX idx_role_perm_unique (role_id, permission_code),
    INDEX idx_role_permissions_role_id (role_id)
);

-- ============================================================================
-- user_roles Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_roles (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id VARCHAR(36) NOT NULL,
    role_id BIGINT NOT NULL,
    granted_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX idx_user_roles_unique (user_id, role_id),
    INDEX idx_user_roles_user_id (user_id),
    INDEX idx_user_roles_role_id (role_id)
);

-- ============================================================================
-- moi_object_permissions Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS moi_object_permissions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '权限记录ID',
    role_id BIGINT NOT NULL COMMENT '角色ID，关联 roles.id (TenantRole)',
    workspace_id VARCHAR(36) NOT NULL COMMENT 'Workspace ID',
    resource_type INT NOT NULL COMMENT '资源类型 (1=DATABASE, 2=TABLE)',
    resource_id VARCHAR(255) NOT NULL COMMENT '资源ID',
    actions JSON NOT NULL COMMENT '操作列表（JSON数组）',
    db_role_name VARCHAR(100) NOT NULL COMMENT '对应的数据库角色名 (moi_role_{role_id})',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_moi_object_permissions_role_id (role_id),
    INDEX idx_moi_object_permissions_resource (resource_type, resource_id),
    UNIQUE INDEX uk_moi_object_permissions_role_resource (role_id, resource_type, resource_id)
) COMMENT='对象权限表，存储角色对特定资源（Database、Table）的权限';

-- ============================================================================
-- llm_config_version Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_config_version (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键，租户内仅一行',
    version BIGINT NOT NULL DEFAULT 1 COMMENT '配置版本号，backend/endpoint/router_config 变更时同一事务自增',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) COMMENT='LLM 配置版本，多实例同步用';

-- ============================================================================
-- llm_backend Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_backend (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    name VARCHAR(255) NOT NULL COMMENT '后端名称',
    type VARCHAR(32) NOT NULL COMMENT '与 pb BackendType 枚举对应',
    api_key_encrypted VARCHAR(512) NULL COMMENT '加密 API Key（可选）',
    timeout_seconds INT NOT NULL DEFAULT 30 COMMENT '超时秒数',
    models JSON NULL COMMENT '该后端支持的模型列表',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE INDEX uk_llm_backend_name (name)
) COMMENT='LLM 后端模型配置';

-- ============================================================================
-- llm_backend_endpoint Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_backend_endpoint (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    backend_id BIGINT NOT NULL COMMENT '所属后端 id',
    address VARCHAR(512) NOT NULL COMMENT '端点地址',
    status VARCHAR(16) NOT NULL DEFAULT 'online' COMMENT '与 pb EndpointStatus 枚举对应',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_llm_backend_endpoint_backend_id (backend_id),
    FOREIGN KEY (backend_id) REFERENCES llm_backend(id)
) COMMENT='LLM 后端端点，支持上线下线';

-- ============================================================================
-- llm_router_config Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_router_config (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键，租户内仅一行',
    strategy VARCHAR(64) NOT NULL DEFAULT 'ROUND_ROBIN' COMMENT 'pb RouterStrategy 枚举名',
    health_check_interval_seconds INT NOT NULL DEFAULT 30 COMMENT '健康检查间隔秒',
    max_retries INT NOT NULL DEFAULT 2 COMMENT '最大重试次数',
    enable_session_affinity TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否会话保持',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) COMMENT='LLM 路由策略与配置，仅 workspace 管理员可写';

-- ============================================================================
-- llm_session Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_session (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    title VARCHAR(512) NOT NULL DEFAULT '' COMMENT '会话标题',
    source VARCHAR(255) NOT NULL DEFAULT '' COMMENT '来源/应用名',
    user_id VARCHAR(36) NOT NULL COMMENT 'API Key 对应用户 ID',
    session_config TEXT NULL COMMENT '会话配置',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_llm_session_user_id (user_id),
    INDEX idx_llm_session_source (source),
    INDEX idx_llm_session_created_at (created_at)
) COMMENT='LLM 会话';

-- ============================================================================
-- llm_tag Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_tag (
    source VARCHAR(255) NOT NULL COMMENT '标签来源（应用名）',
    name VARCHAR(255) NOT NULL COMMENT '标签名称',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (source, name),
    INDEX idx_llm_tag_name (name)
) COMMENT='LLM 统一标签表，会话与消息共用';

-- ============================================================================
-- llm_tag_relation Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_tag_relation (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    relation_type VARCHAR(32) NOT NULL COMMENT 'session | message',
    relation_id BIGINT NOT NULL COMMENT 'session_id 或 message_id',
    tag_source VARCHAR(255) NOT NULL COMMENT '标签来源',
    tag_name VARCHAR(255) NOT NULL COMMENT '标签名称',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    UNIQUE INDEX uk_llm_tag_relation (relation_type, relation_id, tag_source, tag_name),
    INDEX idx_llm_tag_relation_ref (relation_type, relation_id),
    INDEX idx_llm_tag_relation_tag (tag_source, tag_name)
) COMMENT='标签与会话/消息多对多关联';

-- ============================================================================
-- llm_chat_message Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_chat_message (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    user_id VARCHAR(36) NOT NULL COMMENT 'API Key 对应用户 ID',
    session_id BIGINT NULL COMMENT '关联 llm_session.id',
    source VARCHAR(255) NOT NULL DEFAULT '' COMMENT '来源',
    role VARCHAR(32) NOT NULL COMMENT '与 pb MessageRole 枚举对应',
    original_content TEXT NULL COMMENT '原始内容',
    content TEXT NOT NULL COMMENT '内容',
    model VARCHAR(255) NULL COMMENT '模型',
    status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '状态',
    response TEXT NULL COMMENT '响应',
    modified_response TEXT NULL COMMENT '修改后响应',
    message_config TEXT NULL COMMENT '配置',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_llm_chat_message_user_id (user_id),
    INDEX idx_llm_chat_message_session_id (session_id),
    INDEX idx_llm_chat_message_source (source),
    INDEX idx_llm_chat_message_role (role),
    INDEX idx_llm_chat_message_status (status),
    INDEX idx_llm_chat_message_created_at (created_at)
) COMMENT='LLM 聊天消息';

-- ============================================================================
-- parser_config_version Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS parser_config_version (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键，租户内仅一行',
    version BIGINT NOT NULL DEFAULT 1 COMMENT '配置版本号',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) COMMENT='Parser 配置版本';

-- ============================================================================
-- parser_backend Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS parser_backend (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    name VARCHAR(255) NOT NULL COMMENT '后端名称',
    type VARCHAR(32) NOT NULL COMMENT '与 pb ParserBackendType 枚举对应',
    api_key_encrypted VARCHAR(512) NULL COMMENT '加密 API Key（可选）',
    timeout_seconds INT NOT NULL DEFAULT 60 COMMENT '超时秒数',
    supported_mime_types JSON NULL COMMENT '该后端支持的 MIME 类型列表',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE INDEX uk_parser_backend_name (name)
) COMMENT='Parser 解析器后端配置';

-- ============================================================================
-- parser_backend_endpoint Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS parser_backend_endpoint (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    backend_id BIGINT NOT NULL COMMENT '所属后端 id',
    address VARCHAR(512) NOT NULL COMMENT '端点地址',
    status VARCHAR(16) NOT NULL DEFAULT 'online' COMMENT '与 pb EndpointStatus 枚举对应',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_parser_backend_endpoint_backend_id (backend_id),
    FOREIGN KEY (backend_id) REFERENCES parser_backend(id)
) COMMENT='Parser 后端端点';

-- ============================================================================
-- parser_router_config Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS parser_router_config (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键，租户内仅一行',
    strategy VARCHAR(64) NOT NULL DEFAULT 'ROUND_ROBIN' COMMENT 'RouterStrategy 枚举名',
    health_check_interval_seconds INT NOT NULL DEFAULT 30 COMMENT '健康检查间隔秒',
    max_retries INT NOT NULL DEFAULT 2 COMMENT '最大重试次数',
    enable_session_affinity TINYINT(1) NOT NULL DEFAULT 0 COMMENT '保留字段',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) COMMENT='Parser 路由策略配置';

-- ============================================================================
-- embedding_config_version Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS embedding_config_version (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键，租户内仅一行',
    version BIGINT NOT NULL DEFAULT 1 COMMENT '配置版本号',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) COMMENT='Embedding 配置版本';

-- ============================================================================
-- embedding_backend Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS embedding_backend (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    name VARCHAR(255) NOT NULL COMMENT '后端名称',
    type VARCHAR(32) NOT NULL COMMENT '后端类型（与 BackendType 枚举名对应）',
    api_key_encrypted VARCHAR(512) NULL COMMENT '加密 API Key（可选）',
    timeout_seconds INT NOT NULL DEFAULT 30 COMMENT '超时秒数',
    models JSON NULL COMMENT '该后端支持的模型列表',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE INDEX uk_embedding_backend_name (name)
) COMMENT='Embedding 后端模型配置';

-- ============================================================================
-- embedding_backend_endpoint Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS embedding_backend_endpoint (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键',
    backend_id BIGINT NOT NULL COMMENT '所属后端 id',
    address VARCHAR(512) NOT NULL COMMENT '端点地址',
    status VARCHAR(16) NOT NULL DEFAULT 'online' COMMENT '状态（EndpointStatus 枚举名）',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_embedding_backend_endpoint_backend_id (backend_id),
    FOREIGN KEY (backend_id) REFERENCES embedding_backend(id)
) COMMENT='Embedding 后端端点';

-- ============================================================================
-- embedding_router_config Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS embedding_router_config (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键，租户内仅一行',
    strategy VARCHAR(64) NOT NULL DEFAULT 'ROUND_ROBIN' COMMENT 'RouterStrategy 枚举名',
    health_check_interval_seconds INT NOT NULL DEFAULT 30 COMMENT '健康检查间隔秒',
    max_retries INT NOT NULL DEFAULT 2 COMMENT '最大重试次数',
    enable_session_affinity TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否会话保持（保留字段）',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) COMMENT='Embedding 路由策略配置';

-- ============================================================================
-- explore_index_health Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS explore_index_health (
    workspace_id VARCHAR(64) PRIMARY KEY COMMENT '工作空间ID',
    index_state VARCHAR(16) NOT NULL DEFAULT 'OK' COMMENT '索引状态: OK/MISSING/STALE/REBUILDING',
    last_checked_at TIMESTAMP NULL COMMENT '最后检查时间',
    last_built_at TIMESTAMP NULL COMMENT '最后构建时间',
    last_error VARCHAR(256) COMMENT '最后错误信息',
    INDEX idx_index_state (index_state)
) COMMENT='Explore 索引健康状态表';

