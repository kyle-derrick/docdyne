// ai_conversations.go：AI 会话记录端点（/api/v1/ai/conversations，
// ai_conversations 表，migration 053，本人维度）。
//
// 全局助手（file_id=NULL）、编辑页面板（editor）、OnlyOffice 插件（plugin）
// 三处对话的会话统一服务端持久化：列表（不含正文）/新建/读取（含正文）/
// 整体更新（title 与 messages）/删除。跨设备一致，前端从 localStorage
// 迁移本机历史后以服务端为唯一事实源。认证与 /ai/chat 同组（ai:chat
// scope，浏览器 JWT 不受影响）。
package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/auth"
)

// aiConvoStore 抽象会话存取（生产实现 *auth.UserStore，NewHandler 装配；
// 接口化便于单测注入内存实现，模式同 aiMemoryStore）。
type aiConvoStore interface {
	ListAIConversations(userID uuid.UUID, fileID *uuid.UUID, source string, limit int) ([]auth.AIConversationMeta, error)
	CreateAIConversation(userID uuid.UUID, fileID *uuid.UUID, source, title string) (auth.AIConversation, error)
	GetAIConversation(userID, id uuid.UUID) (auth.AIConversation, bool, error)
	UpdateAIConversation(userID, id uuid.UUID, title *string, messages json.RawMessage) (bool, error)
	AppendAIConvoEvent(userID, id uuid.UUID, kind string, payload json.RawMessage) (bool, error)
	DeleteAIConversation(userID, id uuid.UUID) (bool, error)
}

var _ aiConvoStore = (*auth.UserStore)(nil)

// aiConvoScope 解析列表/新建的公共 query：file_id（可空=全局助手）与
// source（缺省 assistant）。返回 gin 错误时已写响应。
func aiConvoScope(c *gin.Context) (*uuid.UUID, string, bool) {
	source := c.DefaultQuery("source", auth.AIConvoSourceAssistant)
	if err := auth.ValidateAIConvoSource(source); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_CONVERSATION"})
		return nil, "", false
	}
	var fileID *uuid.UUID
	if raw := c.Query("file_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file_id", "code": "INVALID_AI_CONVERSATION"})
			return nil, "", false
		}
		fileID = &id
	}
	return fileID, source, true
}

// aiConvoList GET /api/v1/ai/conversations?file_id=&source=：scope 内最近
// 会话列表（updated_at 倒序，≤30 条，不含 messages 正文）。
func (h *Handler) aiConvoList(c *gin.Context) {
	if h.aiConversations == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai conversations is not configured"})
		return
	}
	fileID, source, ok := aiConvoScope(c)
	if !ok {
		return
	}
	items, err := h.aiConversations.ListAIConversations(userID(c), fileID, source, 0)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidAIConversation) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_CONVERSATION"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load conversations"})
		return
	}
	if items == nil {
		items = []auth.AIConversationMeta{}
	}
	c.JSON(http.StatusOK, gin.H{"conversations": items})
}

// aiConvoCreate POST /api/v1/ai/conversations {file_id?, source?, title?}：
// 新建空会话（返回完整行；messages=[]）。source 缺省 assistant。
func (h *Handler) aiConvoCreate(c *gin.Context) {
	if h.aiConversations == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai conversations is not configured"})
		return
	}
	var req struct {
		FileID *string `json:"file_id"`
		Source string  `json:"source"`
		Title  string  `json:"title"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	source := req.Source
	if source == "" {
		source = auth.AIConvoSourceAssistant
	}
	var fileID *uuid.UUID
	if req.FileID != nil && *req.FileID != "" {
		id, err := uuid.Parse(*req.FileID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file_id", "code": "INVALID_AI_CONVERSATION"})
			return
		}
		fileID = &id
	}
	row, err := h.aiConversations.CreateAIConversation(userID(c), fileID, source, req.Title)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidAIConversation) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_CONVERSATION"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to create conversation"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"conversation": row})
}

// aiConvoGet GET /api/v1/ai/conversations/:id：单个会话（含 messages 正文）。
// 不存在/非本人 404（不区分，避免越权探测）。
func (h *Handler) aiConvoGet(c *gin.Context) {
	if h.aiConversations == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai conversations is not configured"})
		return
	}
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	row, found, err := h.aiConversations.GetAIConversation(userID(c), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load conversation"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "conversation not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversation": row})
}

// aiConvoUpdate PUT /api/v1/ai/conversations/:id {title}：
// 更新标题（内容写走 POST /:id/events 事件端点）。
func (h *Handler) aiConvoUpdate(c *gin.Context) {
	if h.aiConversations == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai conversations is not configured"})
		return
	}
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Title *string `json:"title"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if req.Title == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title required", "code": "INVALID_AI_CONVERSATION"})
		return
	}
	found, err := h.aiConversations.UpdateAIConversation(userID(c), id, req.Title, nil)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidAIConversation) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_CONVERSATION"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save conversation"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "conversation not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// aiConvoDelete DELETE /api/v1/ai/conversations/:id：删除会话（204）。
// v7.9：删除前先回放会话，删除后联动清理其上传附件（files[].upload=true
// 的文件，best-effort——「随会话一起删除」）。
func (h *Handler) aiConvoDelete(c *gin.Context) {
	if h.aiConversations == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai conversations is not configured"})
		return
	}
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	row, found, err := h.aiConversations.GetAIConversation(userID(c), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to delete conversation"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "conversation not found"})
		return
	}
	messages := row.Messages
	if _, err := h.aiConversations.DeleteAIConversation(userID(c), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to delete conversation"})
		return
	}
	h.deleteConversationAttachments(userID(c), messages)
	c.Status(http.StatusNoContent)
}

// aiConvoEvents POST /api/v1/ai/conversations/:id/events {kind, messages}：
// 追加事件（turn=追加回合消息 / snapshot=全量快照替换；messages 为前端
// 回合结构数组）。返回最新 message_count。
func (h *Handler) aiConvoEvents(c *gin.Context) {
	if h.aiConversations == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai conversations is not configured"})
		return
	}
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Kind     string          `json:"kind"`
		Messages json.RawMessage `json:"messages"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if req.Kind == "" {
		req.Kind = "turn"
	}
	found, err := h.aiConversations.AppendAIConvoEvent(userID(c), id, req.Kind, req.Messages)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidAIConversation) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_CONVERSATION"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to append conversation events"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "conversation not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
