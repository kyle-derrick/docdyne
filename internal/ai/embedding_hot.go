// Package ai —— embedding_hot.go：RAG embedding 配置热切换（免重启）。
//
// 管理端修改 ai.rag.embedding_provider / embedding_model 后，索引与检索
// 路径经 ResolveEmbedding 每次按当前热配置解析 embedding Provider 与派生
// collection 名：同 provider+model 恒定同库，切模型即换库（旧库数据保留，
// 重建索引后写入新库——POST /admin/settings/ai/reindex）。
package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"

	"github.com/kyle-derrick/docdyne/internal/settings"
)

// ErrVectorDisabled 表示当前热配置未启用向量路径（RAG mode 非 hybrid 或
// vector_enabled=false）：VectorIndexer 据此安静跳过向量索引，HybridRetriever
// 降级纯关键词召回——两种情况都不产生任何 Qdrant 连接。
var ErrVectorDisabled = errors.New("vector rag disabled by hot config")

// mockEmbedding8 为 mock 路径的共享单例（8 维，无状态可并发复用）。
var mockEmbedding8 = NewMockEmbeddingProvider(8)

var (
	// embeddingClientsMu 保护 embeddingClients 缓存（EmbeddingProvider 无
	// 状态，按配置指纹全局缓存复用；OpenAI 兼容客户端无待回收资源，旧
	// 条目自然淘汰即可）。
	embeddingClientsMu sync.Mutex
	embeddingClients   = map[string]EmbeddingProvider{}
)

// ResolveEmbedding 按当前热配置解析 embedding Provider 与 collection 派生
// 名。mock → 内置 8 维；Provider ID → 从 Provider 池取 base/key/model 构造
// OpenAI 兼容 embedding 客户端（同配置复用缓存实例）。派生名保证「同
// provider+model 同库、切模型即换库」，旧库数据保留（重建索引后写入新库）。
// 未配置可用 embedding 目标时返回错误（调用方按降级/跳过处理）。
func (s *Service) ResolveEmbedding() (EmbeddingProvider, string, error) {
	cfg, err := s.Config()
	if err != nil {
		return nil, "", fmt.Errorf("read ai config: %w", err)
	}
	prefix := cfg.RAG.CollectionPrefix
	if cfg.RAG.EmbeddingProvider == "mock" {
		return mockEmbedding8, prefix + "g_mock8", nil
	}
	// 旧值 openai_compatible / 空串回落默认 Provider；显式 ID 须命中且
	// 模型具备 embedding 能力（语义同 settings.AIConfig.ResolveEmbeddingTarget
	// 与管理端 RAG 连接测试）。
	p, model, ok := cfg.ResolveEmbeddingTarget()
	if !ok || p.Kind != settings.AIKindOpenAICompatible {
		return nil, "", fmt.Errorf("rag embedding provider %q not configured (pick an embedding-capable model)", cfg.RAG.EmbeddingProvider)
	}
	return embeddingProviderFor(p, model), EmbeddingCollection(prefix, p.ID, model), nil
}

// ResolveConvVectors 解析会话向量档（ai.history_search=vector）的 embedding
// 与派生 collection：与文件 RAG 同 embedding 身份、conv_ 变体名隔离。
// mock embedding 的向量无语义召回意义（sha256 散列）——返回
// ErrVectorDisabled 由调用方降级关键词检索（不报错、不建库）。
func (s *Service) ResolveConvVectors() (EmbeddingProvider, string, error) {
	cfg, err := s.Config()
	if err != nil {
		return nil, "", fmt.Errorf("read ai config: %w", err)
	}
	if cfg.RAG.EmbeddingProvider == "mock" {
		return nil, "", ErrVectorDisabled
	}
	p, model, ok := cfg.ResolveEmbeddingTarget()
	if !ok || p.Kind != settings.AIKindOpenAICompatible {
		return nil, "", ErrVectorDisabled
	}
	return embeddingProviderFor(p, model), ConvCollection(cfg.RAG.CollectionPrefix, p.ID, model), nil
}

// embeddingProviderFor 取（或缓存）OpenAI 兼容 embedding 客户端。缓存键含
// base/key：管理员改密钥或网关地址（模型 ID 不变）后同样立即生效。
func embeddingProviderFor(p settings.AIProvider, model string) EmbeddingProvider {
	key := p.ID + "\x00" + model + "\x00" + p.BaseURL + "\x00" + p.APIKey
	embeddingClientsMu.Lock()
	defer embeddingClientsMu.Unlock()
	provider, cached := embeddingClients[key]
	if !cached {
		provider = NewOpenAIEmbeddingProvider(p.BaseURL, p.APIKey, model, nil)
		embeddingClients[key] = provider
	}
	return provider
}

// embeddingIdentityHash provider+model 身份哈希（collection 派生共用）。
func embeddingIdentityHash(providerID, modelID string) string {
	sum := sha256.Sum256([]byte(providerID + "::" + modelID))
	return hex.EncodeToString(sum[:])[:10]
}

// EmbeddingCollection 派生向量 collection 名：
// prefix + "g_" + sha256(providerID + "::" + modelID) 前 10 hex——同
// provider+model 恒定同名（重启亦然），换模型即换名。
func EmbeddingCollection(prefix, providerID, modelID string) string {
	return prefix + "g_" + embeddingIdentityHash(providerID, modelID)
}

// ConvCollection 会话向量集合名（prefix+"conv_"+同身份哈希）：与文件 RAG
// 库同 embedding 身份但完全隔离（重建/删除互不影响），切模型同样换名。
func ConvCollection(prefix, providerID, modelID string) string {
	return prefix + "conv_" + embeddingIdentityHash(providerID, modelID)
}
