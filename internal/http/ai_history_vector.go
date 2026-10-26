// ai_history_vector.go：会话历史检索 vector 档（ai.history_search=vector）
// 的 HTTP 侧管道——写入钩子（事件追加后异步嵌入）、检索路径
// （dd_search_history 向量优先 + 自动降级关键词）与全量重建端点。
package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/ai"
	"github.com/kyle-derrick/docdyne/internal/audit"
	"github.com/kyle-derrick/docdyne/internal/auth"
)

// aiHistoryVectorIndexTimeout 单轮异步嵌入的超时（含 embedding 上行 +
// Qdrant upsert；超时仅丢本轮索引，关键词行仍是权威数据源）。
const aiHistoryVectorIndexTimeout = 30 * time.Second

// aiHistorySearchModeFor 解析该用户生效的历史检索模式（用户覆盖 → 平台
// → 默认 keyword）。与 aiHistorySearchEnabled（平台开关，历史兼容）同源。
func (h *Handler) aiHistorySearchModeFor(user uuid.UUID) string {
	platform := ""
	if h.settings != nil {
		if cfg, _, err := h.settings.AIOverrides(); err == nil {
			platform = cfg.HistorySearch
		}
	}
	if h.aiPrefs != nil {
		if prefs, ok := h.loadAIPersonalPrefs(user); ok && prefs.Overrides != nil && prefs.Overrides.HistorySearch != nil {
			return ai.ResolveHistorySearchMode(platform, prefs.Overrides.HistorySearch)
		}
	}
	return ai.ResolveHistorySearchMode(platform, nil)
}

// aiConvoVectorIndex 事件追加成功后异步索引（best-effort：recover + 独立
// 超时 + ErrVectorDisabled 静默——不阻塞 200 响应，失败只丢本轮派生索引）。
// kind=turn 增量、snapshot 先清空该会话全部点再重建。
func (h *Handler) aiConvoVectorIndex(userID, convoID uuid.UUID, kind string, payload json.RawMessage) {
	if h.aiConvVectors == nil || h.aiConversations == nil {
		return
	}
	if h.aiHistorySearchModeFor(userID) != ai.HistorySearchVector {
		return
	}
	go func() {
		defer func() { _ = recover() }() // 派生索引失败不拖垮请求路径
		ctx, cancel := context.WithTimeout(context.Background(), aiHistoryVectorIndexTimeout)
		defer cancel()
		var items []json.RawMessage
		if json.Unmarshal(payload, &items) != nil {
			return
		}
		msgs := make([]ai.ConvMsg, 0, len(items))
		for _, raw := range items {
			var msg struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			}
			if json.Unmarshal(raw, &msg) != nil || msg.Role == "" || msg.Content == "" {
				continue
			}
			msgs = append(msgs, ai.ConvMsg{Role: msg.Role, Content: msg.Content})
		}
		if len(msgs) == 0 && kind != "snapshot" {
			return
		}
		title := ""
		if row, found, err := h.aiConversations.GetAIConversation(userID, convoID); err == nil && found {
			title = row.Title
		}
		// 索引为派生数据：失败静默（关键词行 ai_conversation_msgs 仍是权威
		// 数据源，snapshot/reindex 自愈）。
		_ = h.aiConvVectors.IndexTurn(ctx, userID, convoID, title, kind, msgs)
	}()
}

// aiConvoVectorDelete 会话删除后异步清理其向量点（best-effort；userID
// 用于解析该用户的向量库——个人 embedding 覆盖时点在用户专属库）。
func (h *Handler) aiConvoVectorDelete(userID, convoID uuid.UUID) {
	if h.aiConvVectors == nil {
		return
	}
	go func() {
		defer func() { _ = recover() }()
		ctx, cancel := context.WithTimeout(context.Background(), aiHistoryVectorIndexTimeout)
		defer cancel()
		_ = h.aiConvVectors.DeleteConversation(ctx, userID, convoID)
	}()
}

// ---------- dd_search_history 向量路径（toolSearchHistory 调用） ----------

// historyVectorSearch 向量检索当前用户会话历史；任何失败（未注入/未配置
// embedding/Qdrant 连接错误）返回 error 由调用方降级关键词。
func (p *platformToolCtx) historyVectorSearch(query string) ([]gin.H, error) {
	if p.h.aiConvVectors == nil {
		return nil, errors.New("conv vector indexer not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	hits, err := p.h.aiConvVectors.Search(ctx, p.user, query, ai.PlatformToolHistorySearchLimit)
	if err != nil {
		return nil, err
	}
	out := make([]gin.H, 0, len(hits))
	for _, h := range hits {
		out = append(out, gin.H{
			"conversation_title": h.Title,
			"role":               h.Role,
			"fragment":           h.Text,
		})
	}
	return out, nil
}

// ---------- 管理端全量重建 ----------

// aiConvoMsgLister 重建端点的消息行分批列举（*auth.UserStore 天然满足）。
type aiConvoMsgLister interface {
	ListAIConvoMsgsBatch(offset, limit int) ([]auth.AIConvoMsg, error)
	ConvoTitleMap(ids []uuid.UUID) (map[uuid.UUID]string, error)
}

// adminReindexHistoryVector POST /api/v1/admin/settings/ai/history/reindex：
// 全量重建会话向量索引（分批读 ai_conversation_msgs → 按会话分组重嵌入）。
// vector 档未就绪（未注入索引器/embedding 为 mock）时 400；成功返回
// {conversations, messages} 计数（同步执行，大会话量时为慢操作——管理端
// 维护动作，与文件 reindex 同口径）。
func (h *Handler) adminReindexHistoryVector(c *gin.Context) {
	if h.aiConvVectors == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "会话向量未启用（未配置 Qdrant 或 embedding 为 mock），无需重建", "code": "VECTOR_DISABLED"})
		return
	}
	lister, ok := h.aiConversations.(aiConvoMsgLister)
	if !ok || lister == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai conversations is not configured"})
		return
	}
	const batch = 500
	type msgKey struct{ convo, user uuid.UUID }
	byConvo := map[msgKey][]ai.ConvMsg{}
	convoIDs := map[uuid.UUID]bool{}
	offset, total := 0, 0
	for {
		rows, err := lister.ListAIConvoMsgsBatch(offset, batch)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load conversation messages"})
			return
		}
		if len(rows) == 0 {
			break
		}
		for _, r := range rows {
			key := msgKey{r.ConversationID, r.UserID}
			byConvo[key] = append(byConvo[key], ai.ConvMsg{Role: r.Role, Content: r.Content})
			convoIDs[r.ConversationID] = true
			total++
		}
		offset += len(rows)
		if len(rows) < batch {
			break
		}
	}
	ids := make([]uuid.UUID, 0, len(convoIDs))
	for id := range convoIDs {
		ids = append(ids, id)
	}
	titles, err := lister.ConvoTitleMap(ids)
	if err != nil {
		titles = map[uuid.UUID]string{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	indexed := 0
	for key, msgs := range byConvo {
		if err := h.aiConvVectors.IndexTurn(ctx, key.user, key.convo, titles[key.convo], "snapshot", msgs); err != nil {
			if errors.Is(err, ai.ErrVectorDisabled) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "会话向量未启用（embedding 为 mock 或未配置），已停止重建", "code": "VECTOR_DISABLED"})
				return
			}
			continue // 单会话失败跳过（重建为 best-effort 全量动作）
		}
		indexed++
	}
	if h.audit != nil {
		actor := userID(c)
		metadata, _ := json.Marshal(map[string]any{"conversations": indexed, "messages": total})
		_ = h.audit.Record(audit.Entry{UserID: &actor, Action: "ai.reindex", ResourceType: audit.ResourceAI, ResourceID: "settings/ai/history/reindex", Status: audit.StatusSuccess, Metadata: string(metadata)})
	}
	c.JSON(http.StatusOK, gin.H{"conversations": indexed, "messages": total})
}
