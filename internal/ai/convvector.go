// convvector.go：会话历史向量索引（ai.history_search=vector 档）。
//
// 会话消息（ai_conversation_msgs 的上游——事件追加路径）逐条嵌入 Qdrant
// 会话集合（prefix+"conv_"+hash：与文件 RAG 库同 embedding 身份但完全
// 隔离，切 embedding 模型即换库，热切换语义同文件向量）。检索侧
// dd_search_history 优先向量召回，embedding/向量库不可用（未配置 Qdrant、
// mock embedding、连接失败）时自动降级关键词检索并在结果标注 degraded。
//
// 索引为 derived data：写入 best-effort（失败仅记日志，关键词索引行仍是
// 权威数据源），管理端可全量重建（POST /admin/settings/ai/history/reindex）。
package ai

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// ConvTextMaxRunes 单条会话消息的嵌入文本上限（超长消息截断——语义召回
// 只需命中，与前 1K 字符缺失尾部信息基本无碍；亦控制嵌入成本）。
const ConvTextMaxRunes = 1000

// ConvSearchMultiplier 向量检索的候选扩倍（召回后由上游按分数截断）。
const ConvSearchMultiplier = 2

// ConvMsg 一条待索引/已召回的会话消息（最小形态）。
type ConvMsg struct {
	Role    string
	Content string
}

// ConvHit 一条会话向量召回（payload 解包后的形态，对齐 keyword 检索结果）。
type ConvHit struct {
	ConversationID string
	Title          string
	Role           string
	Text           string
	Score          float32
}

// convVectorDeleter 按过滤条件删点的可选能力（snapshot 重建/会话删除清理；
// 未实现的存储静默跳过——内容哈希 ID 的重投天然幂等，残留点仅影响已删
// 内容的召回，reindex 可自愈）。
type convVectorDeleter interface {
	DeleteByFilter(ctx context.Context, filter map[string]any) error
}

// ConvVectorIndexer 会话向量索引器（Resolve 每次按热配置解析 embedding
// 与目标集合视图；返回 ErrVectorDisabled 时调用方安静跳过/降级）。
type ConvVectorIndexer struct {
	Resolve func() (EmbeddingProvider, VectorStore, error)
}

// convPointID 稳定点 ID：会话内 role+内容 哈希（同内容去重，重复消息
// 自然合并为一点；重投幂等）。
func convPointID(convoID uuid.UUID, m ConvMsg) string {
	return uuid.NewSHA1(convoID, []byte(m.Role+"\x00"+strings.TrimSpace(m.Content))).String()
}

// convFilter 会话集合的归属过滤（must user_id 精确匹配）。
func convFilter(userID uuid.UUID) map[string]any {
	return map[string]any{"must": []any{map[string]any{
		"key": "user_id", "match": map[string]any{"value": userID.String()},
	}}}
}

// IndexTurn 索引一轮会话消息（snapshot 先清空该会话的全部点再重建）。
// 消息为空且非 snapshot 时为 no-op。
func (ix *ConvVectorIndexer) IndexTurn(ctx context.Context, userID, convoID uuid.UUID, title, kind string, msgs []ConvMsg) error {
	embeddings, vectors, err := ix.resolve()
	if err != nil {
		return err
	}
	if kind == "snapshot" {
		if deleter, ok := vectors.(convVectorDeleter); ok {
			_ = deleter.DeleteByFilter(ctx, convFilterConvo(convoID))
		}
	}
	items := make([]ConvMsg, 0, len(msgs))
	for _, m := range msgs {
		if strings.TrimSpace(m.Content) == "" || (m.Role != "user" && m.Role != "assistant") {
			continue
		}
		items = append(items, ConvMsg{Role: m.Role, Content: clipRunes(strings.TrimSpace(m.Content), ConvTextMaxRunes)})
	}
	if len(items) == 0 {
		return nil
	}
	texts := make([]string, len(items))
	for i, m := range items {
		texts[i] = m.Content
	}
	vecs, err := embeddings.Embed(ctx, texts)
	if err != nil {
		return fmt.Errorf("conv embed: %w", err)
	}
	points := make([]VectorPoint, 0, len(items))
	for i, m := range items {
		if i >= len(vecs) || len(vecs[i]) == 0 {
			continue
		}
		points = append(points, VectorPoint{
			ID: convPointID(convoID, m), Vector: vecs[i],
			Payload: map[string]any{
				"user_id": userID.String(), "conversation_id": convoID.String(),
				"role": m.Role, "title": clipRunes(title, 80), "text": m.Content,
			},
		})
	}
	if len(points) == 0 {
		return nil
	}
	if err := vectors.EnsureCollection(ctx, len(vecs[0])); err != nil {
		return err
	}
	return vectors.Upsert(ctx, points)
}

// Search 向量检索当前用户的会话历史（query 嵌入 + user_id 过滤）。
func (ix *ConvVectorIndexer) Search(ctx context.Context, userID uuid.UUID, query string, limit int) ([]ConvHit, error) {
	embeddings, vectors, err := ix.resolve()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("empty query")
	}
	if limit <= 0 {
		limit = 10
	}
	vecs, err := embeddings.Embed(ctx, []string{clipRunes(strings.TrimSpace(query), WebSearchQueryMaxRunes)})
	if err != nil || len(vecs) == 0 || len(vecs[0]) == 0 {
		if err == nil {
			err = fmt.Errorf("empty embedding")
		}
		return nil, err
	}
	hits, err := vectors.Search(ctx, vecs[0], limit*ConvSearchMultiplier, convFilter(userID))
	if err != nil {
		return nil, err
	}
	out := make([]ConvHit, 0, len(hits))
	for _, h := range hits {
		if len(out) >= limit {
			break
		}
		text, _ := h.Payload["text"].(string)
		if strings.TrimSpace(text) == "" {
			continue
		}
		title, _ := h.Payload["title"].(string)
		role, _ := h.Payload["role"].(string)
		convoID, _ := h.Payload["conversation_id"].(string)
		out = append(out, ConvHit{ConversationID: convoID, Title: title, Role: role, Text: text, Score: h.Score})
	}
	return out, nil
}

// DeleteConversation 清理一个会话的全部向量点（会话删除时 best-effort）。
func (ix *ConvVectorIndexer) DeleteConversation(ctx context.Context, convoID uuid.UUID) error {
	_, vectors, err := ix.resolve()
	if err != nil {
		return err
	}
	deleter, ok := vectors.(convVectorDeleter)
	if !ok {
		return nil
	}
	return deleter.DeleteByFilter(ctx, convFilterConvo(convoID))
}

// convFilterConvo 会话维度的删除过滤。
func convFilterConvo(convoID uuid.UUID) map[string]any {
	return map[string]any{"must": []any{map[string]any{
		"key": "conversation_id", "match": map[string]any{"value": convoID.String()},
	}}}
}

func (ix *ConvVectorIndexer) resolve() (EmbeddingProvider, VectorStore, error) {
	if ix == nil || ix.Resolve == nil {
		return nil, nil, ErrVectorDisabled
	}
	return ix.Resolve()
}
