// rag_personal_test.go：个人 RAG 覆盖单测——embedding 按用户解析（个人库
// 派生名/失效回落平台）、会话向量个人库命名、检索 TopK 个人覆盖。
package ai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/auth"
	"github.com/kyle-derrick/docdyne/internal/search"
	"github.com/kyle-derrick/docdyne/internal/settings"
)

// personalRAGPrefs 构造带个人 Provider（embedding 模型 em1）与 RAG 覆盖的 prefs。
func personalRAGPrefs(emb *auth.AIPersonalModelRef, topK *int) auth.AIPersonalPrefs {
	return auth.AIPersonalPrefs{
		Providers: []auth.AIPersonalProvider{{
			ID: "mine", Name: "mine", Kind: settings.AIKindOpenAICompatible,
			BaseURL: "https://my.example.com",
			Models: []auth.AIPersonalModel{
				{ID: "em1", Capabilities: settings.AIModelCapabilities{Kind: settings.AIModelKindEmbedding}},
				{ID: "c1", Capabilities: settings.AIModelCapabilities{Kind: settings.AIModelKindChat}},
			},
		}},
		Overrides: &auth.AIPersonalOverrides{RAG: &auth.AIPersonalRAGOverrides{Embedding: emb, TopK: topK}},
	}
}

// TestResolveEmbeddingForPersonal 个人覆盖 → 用户专属库派生名；未配置/失效/
// 非 openai_compatible → 回落平台链。
func TestResolveEmbeddingForPersonal(t *testing.T) {
	svc := hotService(hotConfig("p1", "m1"))
	user := uuid.Must(uuid.NewV7())
	ref := &auth.AIPersonalModelRef{ProviderID: "mine", ModelID: "em1"}

	_, coll, err := svc.WithPersonalPrefs(personalRAGPrefs(ref, nil)).ResolveEmbeddingFor(user)
	if err != nil {
		t.Fatal(err)
	}
	hash := hex.EncodeToString(func() []byte { s := sha256.Sum256([]byte("mine::em1")); return s[:] }())
	uhash := hex.EncodeToString(func() []byte { s := sha256.Sum256([]byte("user::" + user.String())); return s[:] }())
	want := "docdyne_u" + uhash[:10] + "_" + hash[:10]
	if coll != want {
		t.Fatalf("personal collection %q != %q", coll, want)
	}
	// 用户隔离：另一用户同名模型 → 不同库。
	_, coll2, _ := svc.WithPersonalPrefs(personalRAGPrefs(ref, nil)).ResolveEmbeddingFor(uuid.Must(uuid.NewV7()))
	if coll2 == coll {
		t.Fatal("different users must derive different collections")
	}

	// 未挂载个人配置 → 平台链（平台 provider+model 派生）。
	_, platColl, err := svc.ResolveEmbeddingFor(user)
	if err != nil {
		t.Fatal(err)
	}
	if platColl == coll {
		t.Fatal("no personal prefs must fall back to platform collection")
	}

	// 个人条目失效（模型不存在）→ 静默回落平台。
	bad := &auth.AIPersonalModelRef{ProviderID: "mine", ModelID: "nope"}
	if _, c, err := svc.WithPersonalPrefs(personalRAGPrefs(bad, nil)).ResolveEmbeddingFor(user); err != nil || c != platColl {
		t.Fatalf("stale personal ref must fall back to platform, got %q (%v)", c, err)
	}

	// anthropic Provider 无 embeddings API：校验层拒绝，运行时同样回落。
	anthropic := personalRAGPrefs(ref, nil)
	anthropic.Providers[0].Kind = settings.AIKindAnthropic
	if _, c, err := svc.WithPersonalPrefs(anthropic).ResolveEmbeddingFor(user); err != nil || c != platColl {
		t.Fatalf("anthropic personal embedding must fall back, got %q (%v)", c, err)
	}
}

// TestResolveConvVectorsForPersonal 个人会话库命名：conv_u<uid8>_<hash>，
// 与该用户文件库仅 conv_ 前缀之差；未覆盖时与平台链一致。
func TestResolveConvVectorsForPersonal(t *testing.T) {
	svc := hotService(hotConfig("p1", "m1"))
	user := uuid.Must(uuid.NewV7())
	ref := &auth.AIPersonalModelRef{ProviderID: "mine", ModelID: "em1"}
	_, coll, err := svc.WithPersonalPrefs(personalRAGPrefs(ref, nil)).ResolveConvVectorsFor(user)
	if err != nil {
		t.Fatal(err)
	}
	hash := hex.EncodeToString(func() []byte { s := sha256.Sum256([]byte("mine::em1")); return s[:] }())
	uhash := hex.EncodeToString(func() []byte { s := sha256.Sum256([]byte("user::" + user.String())); return s[:] }())
	want := "docdyne_conv_u" + uhash[:10] + "_" + hash[:10]
	if coll != want {
		t.Fatalf("personal conv collection %q != %q", coll, want)
	}
	// 未覆盖 → 与平台链一致。
	plat, _, errPlat := svc.ResolveConvVectors()
	got, _, errGot := svc.ResolveConvVectorsFor(user)
	if (errPlat == nil) != (errGot == nil) || plat != got {
		t.Fatalf("no override must equal platform path: %q/%v vs %q/%v", plat, errPlat, got, errGot)
	}
}

// TestRetrieveOptPersonalTopK topK<=0 时个人覆盖生效；覆盖非法范围回默认。
func TestRetrieveOptPersonalTopK(t *testing.T) {
	stub := &limitRecorder{}
	svc := NewService(func() (settings.AIConfig, error) { return settings.AIConfig{}, nil })
	svc.SetSearcher(stub)
	topK := 3
	svc2 := svc.WithPersonalPrefs(personalRAGPrefs(nil, &topK))
	if _, err := svc2.RetrieveOpt(context.Background(), uuid.New(), "q", 0, nil); err != nil {
		t.Fatal(err)
	}
	if stub.lastLimit != 3 {
		t.Fatalf("personal top_k = %d, want 3", stub.lastLimit)
	}
	// 无个人覆盖 → 默认。
	if _, err := svc.RetrieveOpt(context.Background(), uuid.New(), "q", 0, nil); err != nil {
		t.Fatal(err)
	}
	if stub.lastLimit != RAGTopKDefault {
		t.Fatalf("default top_k = %d, want %d", stub.lastLimit, RAGTopKDefault)
	}
}

// limitRecorder 记录 Query 收到的 Limit（keyword 检索路径）。
type limitRecorder struct{ lastLimit int }

func (l *limitRecorder) Query(user uuid.UUID, opts search.QueryOptions) ([]search.Result, error) {
	l.lastLimit = opts.Limit
	return nil, nil
}
