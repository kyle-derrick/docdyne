// Package http —— ai_memory_tools.go：工具式记忆执行器（v7.15 A7）。
//
// include_memory 开启时，dd_read_memory/dd_write_memory 随对话注入（见
// ai.go 的装配逻辑），system 上下文只带记忆标题列表（aiMemoryContextBlock），
// 详情按需经工具读取——替代旧的全量内容注入（20 条 ×≤2000 字符最多
// 6000 字符常驻），常态占用从 ~1500 tok 降到 ~200 tok。
//
// 执行器独立于 platformToolCtx（不依赖文件栈）：use_files 关闭/无空间时
// 记忆工具仍可用。写入走 CreateAutoAIMemory（kind=auto，服务端提取专用
// 通道——手动记忆仍归用户维护，AI 只增 auto 类）并按 AIMemoryAutoMax 裁剪。
// 审计口径与文件工具一致（ai.tool，工具名+参数摘要+结果状态+耗时）。
package http

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/ai"
	"github.com/kyle-derrick/docdyne/internal/audit"
	"github.com/kyle-derrick/docdyne/internal/auth"
)

// aiMemoryToolStore 记忆工具所需的最小存取能力（生产实现 *auth.UserStore，
// 即既有 aiAutoMemoryStore——复用类型断言通道：h.aiMemory 未实现时工具
// 不注入，旧测试 fake 无需补方法）。
type aiMemoryToolStore interface {
	ListAIMemory(userID uuid.UUID, limit int) ([]auth.AIMemory, error)
	CreateAutoAIMemory(userID uuid.UUID, content string) (auth.AIMemory, error)
	TrimAutoAIMemory(userID uuid.UUID, keep int) error
}

// memoryToolCtx 记忆工具执行上下文（仅依赖 Handler 的记忆存储；无文件
// 栈依赖——与 platformToolCtx 刻意分离，include_memory 单独开启即可用）。
type memoryToolCtx struct {
	h    *Handler
	c    *gin.Context
	user uuid.UUID
}

// 记忆工具行为边界。
const (
	// aiMemoryToolReadLimit dd_read_memory 无 query 时返回的最近条数。
	aiMemoryToolReadLimit = 10
	// aiMemoryToolQueryLimit 带 query 时最多扫描/返回的记忆条数。
	aiMemoryToolQueryLimit = 50
)

// execute 执行一个记忆工具调用（分发口径同 executePlatformTool：参数
// 非法/业务失败返回 {"ok":false,...} JSON 回喂模型，仅未知工具名返回
// Go 错误）。每次执行写一条 ai.tool 审计。
func (m *memoryToolCtx) execute(name string, argsJSON json.RawMessage) (string, error) {
	args := map[string]any{}
	if len(strings.TrimSpace(string(argsJSON))) > 0 {
		if err := json.Unmarshal(argsJSON, &args); err != nil {
			return platformToolResult(gin.H{"error": "参数不是合法 JSON 对象"}), nil
		}
	}
	str := func(key string) string {
		v, _ := args[key].(string)
		return strings.TrimSpace(v)
	}
	started := time.Now()
	var summary string
	var result any
	var err error
	switch name {
	case ai.PlatformToolReadMemory:
		query := str("query")
		summary = "query=" + query
		result, err = m.toolReadMemory(query)
	case ai.PlatformToolWriteMemory:
		content := str("content")
		summary = fmt.Sprintf("content_len=%d", len([]rune(content)))
		if content == "" {
			err = fmt.Errorf("content 为必填参数")
		} else {
			result, err = m.toolWriteMemory(content)
		}
	default:
		return "", fmt.Errorf("未知记忆工具 %q", name)
	}
	status := audit.StatusSuccess
	if err != nil {
		status = audit.StatusFailure
	}
	m.auditTool(name, status, summary, time.Since(started).Milliseconds(), result, err)
	if err != nil {
		return platformToolResult(gin.H{"error": err.Error()}), nil
	}
	out, merr := json.Marshal(result)
	if merr != nil {
		return platformToolResult(gin.H{"error": "工具结果序列化失败"}), nil
	}
	return `{"ok":true,` + strings.TrimPrefix(string(out), "{"), nil
}

// toolReadMemory dd_read_memory：query 非空按子串过滤（大小写不敏感），
// 空 query 返回最近 aiMemoryToolReadLimit 条。
func (m *memoryToolCtx) toolReadMemory(query string) (any, error) {
	store, ok := m.h.aiMemory.(aiMemoryToolStore)
	if !ok {
		return nil, fmt.Errorf("记忆存储未配置")
	}
	items, err := store.ListAIMemory(m.user, aiMemoryToolQueryLimit)
	if err != nil {
		return nil, fmt.Errorf("记忆读取失败")
	}
	type memItem struct {
		Kind      string    `json:"kind"`
		Content   string    `json:"content"`
		CreatedAt time.Time `json:"created_at"`
	}
	out := make([]memItem, 0, aiMemoryToolReadLimit)
	for _, it := range items { // List 为最新在前
		if query != "" && !containsFold(it.Content, query) {
			continue
		}
		out = append(out, memItem{Kind: it.Kind, Content: it.Content, CreatedAt: it.CreatedAt})
		if len(out) >= aiMemoryToolReadLimit {
			break
		}
	}
	return gin.H{"results": out, "count": len(out)}, nil
}

// toolWriteMemory dd_write_memory：写一条 kind=auto 记忆并裁剪上限
// （校验含 ≤AIMemoryMaxContentRunes，超长报错回喂而非静默截断——让模型
// 自行精炼后重试）。
func (m *memoryToolCtx) toolWriteMemory(content string) (any, error) {
	store, ok := m.h.aiMemory.(aiMemoryToolStore)
	if !ok {
		return nil, fmt.Errorf("记忆存储未配置")
	}
	item, err := store.CreateAutoAIMemory(m.user, content)
	if err != nil {
		return nil, err // 校验错误（如过长）原样回喂模型
	}
	if err := store.TrimAutoAIMemory(m.user, auth.AIMemoryAutoMax); err != nil {
		// 裁剪失败不影响写入结果（下次写入重试），与 trimAIConversations
		// 同口径静默。
		_ = err
	}
	return gin.H{"id": item.ID, "kind": item.Kind, "note": "已记录；用户可在 AI 记忆设置中查看或删除"}, nil
}

// auditTool 写一条记忆工具执行审计（口径同 platformToolCtx.auditTool；
// J3 增强：失败附 error 原文，写记忆结果附 memory_id）。
func (m *memoryToolCtx) auditTool(name, status, summary string, durationMS int64, result any, callErr error) {
	if m.h == nil {
		return
	}
	meta := map[string]any{
		"tool": name, "args": summary, "status": status, "duration_ms": durationMS,
	}
	if callErr != nil {
		meta["error"] = callErr.Error()
	}
	if r, ok := result.(gin.H); ok && r != nil {
		if v, ok := r["id"]; ok {
			meta["memory_id"] = v
		}
	}
	metaJSON, _ := json.Marshal(meta)
	entry := audit.Entry{
		UserID:       &m.user,
		Action:       aiToolAuditAction,
		ResourceType: audit.ResourceAI,
		Status:       status,
		Metadata:     string(metaJSON),
	}
	if m.c != nil {
		m.h.recordAudit(m.c, entry)
		return
	}
	if entry.Status == "" {
		entry.Status = audit.StatusSuccess
	}
	_ = m.h.audit.Record(entry)
}
