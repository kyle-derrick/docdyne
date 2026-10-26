// convvector_test.go：会话历史向量索引单测（fake embedding/store 的
// 索引/检索/快照清理 + user_id 过滤）。
package ai

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// fakeConvEmbedding 确定性嵌入：按文本首字符散列到 2 维（同首字符同向量
// ——测试 user 过滤与命中排序足够）。
type fakeConvEmbedding struct{}

func (fakeConvEmbedding) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		v := float32(rune(strings.TrimSpace(t)[0]) % 7)
		out[i] = []float32{v, v + 1}
	}
	return out, nil
}

func (fakeConvEmbedding) Dimensions() int { return 2 }

// fakeConvStore 内存向量库（记录 upsert 点与删除过滤调用）。
type fakeConvStore struct {
	points     []VectorPoint
	delFilters []map[string]any
	dims       int
}

func (f *fakeConvStore) EnsureCollection(ctx context.Context, dim int) error {
	f.dims = dim
	return nil
}
func (f *fakeConvStore) Upsert(ctx context.Context, pts []VectorPoint) error {
	for _, p := range pts {
		replaced := false
		for i := range f.points {
			if f.points[i].ID == p.ID {
				f.points[i] = p
				replaced = true
			}
		}
		if !replaced {
			f.points = append(f.points, p)
		}
	}
	return nil
}
func (f *fakeConvStore) Search(ctx context.Context, vec []float32, limit int, filter map[string]any) ([]VectorHit, error) {
	want := ""
	if must, ok := filter["must"].([]any); ok && len(must) > 0 {
		if m, ok := must[0].(map[string]any); ok {
			if match, ok := m["match"].(map[string]any); ok {
				want, _ = match["value"].(string)
			}
		}
	}
	hits := []VectorHit{}
	for _, p := range f.points {
		if uid, _ := p.Payload["user_id"].(string); uid != want {
			continue
		}
		hits = append(hits, VectorHit{ID: p.ID, Score: 1, Payload: p.Payload})
		if len(hits) >= limit {
			break
		}
	}
	return hits, nil
}
func (f *fakeConvStore) DeleteFile(ctx context.Context, id uuid.UUID) error { return nil }
func (f *fakeConvStore) DeleteByFilter(ctx context.Context, filter map[string]any) error {
	f.delFilters = append(f.delFilters, filter)
	convo := ""
	if must, ok := filter["must"].([]any); ok && len(must) > 0 {
		if m, ok := must[0].(map[string]any); ok {
			if match, ok := m["match"].(map[string]any); ok {
				convo, _ = match["value"].(string)
			}
		}
	}
	kept := f.points[:0]
	for _, p := range f.points {
		if cid, _ := p.Payload["conversation_id"].(string); cid == convo {
			continue
		}
		kept = append(kept, p)
	}
	f.points = kept
	return nil
}

func newConvIndexer(store *fakeConvStore) *ConvVectorIndexer {
	return &ConvVectorIndexer{Resolve: func(uuid.UUID) (EmbeddingProvider, VectorStore, error) {
		return fakeConvEmbedding{}, store, nil
	}}
}

func TestConvVectorIndexTurnAndSearch(t *testing.T) {
	store := &fakeConvStore{}
	ix := newConvIndexer(store)
	user1, user2 := uuid.New(), uuid.New()
	convoA, convoB := uuid.New(), uuid.New()
	ctx := context.Background()
	msgs := []ConvMsg{
		{Role: "user", Content: "部署 DocDyne 的步骤"},
		{Role: "assistant", Content: "部署说明……"},
		{Role: "tool", Content: "工具消息不入索引"}, // 非 user/assistant 剔除
		{Role: "user", Content: "   "},      // 空内容剔除
	}
	if err := ix.IndexTurn(ctx, user1, convoA, "会话A", "turn", msgs); err != nil {
		t.Fatalf("IndexTurn: %v", err)
	}
	if err := ix.IndexTurn(ctx, user2, convoB, "会话B", "turn", []ConvMsg{{Role: "user", Content: "别的用户的消息"}}); err != nil {
		t.Fatalf("IndexTurn B: %v", err)
	}
	if len(store.points) != 3 {
		t.Fatalf("points = %d, want 3（剔除 tool 与空内容）", len(store.points))
	}
	// 检索只命中本人（user 过滤）。
	hits, err := ix.Search(ctx, user1, "部署", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("user1 hits = %d, want 2（user 过滤）", len(hits))
	}
	for _, h := range hits {
		if h.Role == "" || h.Text == "" || h.Title != "会话A" {
			t.Fatalf("hit payload malformed: %+v", h)
		}
	}
	hits2, _ := ix.Search(ctx, user2, "消息", 10)
	if len(hits2) != 1 {
		t.Fatalf("user2 hits = %d, want 1", len(hits2))
	}
}

func TestConvVectorSnapshotReplaces(t *testing.T) {
	store := &fakeConvStore{}
	ix := newConvIndexer(store)
	user, convo := uuid.New(), uuid.New()
	ctx := context.Background()
	_ = ix.IndexTurn(ctx, user, convo, "T", "turn", []ConvMsg{{Role: "user", Content: "旧消息一"}, {Role: "user", Content: "旧消息二"}})
	// snapshot：先清空全会话点，再重建为单条。
	if err := ix.IndexTurn(ctx, user, convo, "T", "snapshot", []ConvMsg{{Role: "user", Content: "新快照"}}); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(store.delFilters) != 1 {
		t.Fatalf("snapshot should delete-by-filter once, got %d", len(store.delFilters))
	}
	if len(store.points) != 1 {
		t.Fatalf("points after snapshot = %d, want 1", len(store.points))
	}
	if !strings.Contains(fmt.Sprint(store.points[0].Payload["text"]), "新快照") {
		t.Fatalf("snapshot content wrong: %+v", store.points[0].Payload)
	}
	// 相同内容重投幂等（内容哈希 ID 去重）。
	_ = ix.IndexTurn(ctx, user, convo, "T", "turn", []ConvMsg{{Role: "user", Content: "新快照"}})
	if len(store.points) != 1 {
		t.Fatalf("duplicate content should dedupe, points = %d", len(store.points))
	}
}

func TestConvVectorDisabled(t *testing.T) {
	ix := &ConvVectorIndexer{Resolve: func(uuid.UUID) (EmbeddingProvider, VectorStore, error) {
		return nil, nil, ErrVectorDisabled
	}}
	if err := ix.IndexTurn(context.Background(), uuid.New(), uuid.New(), "", "turn", []ConvMsg{{Role: "user", Content: "x"}}); err == nil {
		t.Fatal("disabled indexer should error (caller degrades)")
	}
	if _, err := ix.Search(context.Background(), uuid.New(), "q", 5); err == nil {
		t.Fatal("disabled search should error")
	}
}
