// Package ai —— H2 备选模型链单测：首选模型上游失败且零增量时依序切换
// fallback_models 重试；带工具/已流出增量/配置类错误不回退。
package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/docflow/docflow/internal/settings"
)

// fakeUpstream500 恒定 500 的假上游（模拟首选 Provider 故障）。
func fakeUpstream500() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"upstream down"}}`))
	}))
}

// fakeUpstreamOK 非流式返回固定答案的假 openai 兼容上游。
func fakeUpstreamOK(content string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"` + content + `"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}`))
	}))
}

func fallbackTestConfig(p1URL, p2URL string) settings.AIConfig {
	return settings.AIConfig{
		Providers: []settings.AIProvider{
			{ID: "p1", Name: "主用", Kind: settings.AIKindOpenAICompatible, BaseURL: p1URL, Enabled: true,
				Models: []settings.AIModel{{ID: "m1", Capabilities: settings.AIModelCapabilities{Kind: settings.AIModelKindChat}}}},
			{ID: "p2", Name: "备用", Kind: settings.AIKindOpenAICompatible, BaseURL: p2URL, Enabled: true,
				Models: []settings.AIModel{{ID: "m2", Capabilities: settings.AIModelCapabilities{Kind: settings.AIModelKindChat}}}},
		},
		Temperature: 0.3,
		MaxTokens:   128,
	}
}

// TestChatFallbackSwitch 首选 500 → 切换备选成功：FallbackFrom 标注原目标、
// 结果字段为备选 Provider/模型；失效条目（指向不存在的 Provider）跳过。
func TestChatFallbackSwitch(t *testing.T) {
	bad := fakeUpstream500()
	defer bad.Close()
	good := fakeUpstreamOK("备用模型的回答")
	defer good.Close()
	cfg := fallbackTestConfig(bad.URL, good.URL)
	cfg.FallbackModels = []settings.AIModelRef{
		{ProviderID: "gone", ModelID: "nope"}, // 失效条目：静默跳过
		{ProviderID: "p2", ModelID: "m2"},
	}
	svc := NewService(func() (settings.AIConfig, error) { return cfg, nil })

	res, err := svc.Chat(context.Background(), ChatRequest{
		ProviderID: "p1", Model: "m1",
		Messages: []Message{{Role: "user", Content: "问点啥"}},
	}, nil)
	if err != nil {
		t.Fatalf("Chat: %v（应切换备选成功）", err)
	}
	if res.ProviderID != "p2" || res.Model != "m2" {
		t.Fatalf("served by = %s/%s, want p2/m2", res.ProviderID, res.Model)
	}
	if res.Content != "备用模型的回答" {
		t.Fatalf("content = %q", res.Content)
	}
	if !strings.Contains(res.FallbackFrom, "主用") || !strings.Contains(res.FallbackFrom, "m1") {
		t.Fatalf("FallbackFrom = %q, want 含原目标「主用 / m1」", res.FallbackFrom)
	}
}

// TestChatFallbackAllFail 备选也失败：回首个上游错误，不伪造成功。
func TestChatFallbackAllFail(t *testing.T) {
	bad1 := fakeUpstream500()
	defer bad1.Close()
	bad2 := fakeUpstream500()
	defer bad2.Close()
	cfg := fallbackTestConfig(bad1.URL, bad2.URL)
	cfg.FallbackModels = []settings.AIModelRef{{ProviderID: "p2", ModelID: "m2"}}
	svc := NewService(func() (settings.AIConfig, error) { return cfg, nil })

	_, err := svc.Chat(context.Background(), ChatRequest{
		ProviderID: "p1", Model: "m1",
		Messages: []Message{{Role: "user", Content: "问点啥"}},
	}, nil)
	if err == nil {
		t.Fatal("err = nil, want 上游错误透传")
	}
}

// TestCanFallback 回退条件矩阵：仅上游错误 + 零增量 + 未取消 + 无工具。
func TestCanFallback(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := ChatRequest{Messages: []Message{{Role: "user", Content: "q"}}}
	cases := []struct {
		name     string
		ctx      context.Context
		req      ChatRequest
		err      error
		streamed bool
		want     bool
	}{
		{"上游错误零增量", context.Background(), req, ErrUpstreamChat, false, true},
		{"已流出增量", context.Background(), req, ErrUpstreamChat, true, false},
		{"请求已取消", ctx, req, ErrUpstreamChat, false, false},
		{"配置类错误", context.Background(), req, ErrNoProvider, false, false},
		{"带平台工具", context.Background(), ChatRequest{PlatformTools: []PlatformTool{{Name: PlatformToolReadFile}}, ToolExecutor: func(name string, args json.RawMessage) (string, error) { return "", nil }}, ErrUpstreamChat, false, false},
		{"带 MCP", context.Background(), ChatRequest{UseMCP: true}, ErrUpstreamChat, false, false},
	}
	for _, tc := range cases {
		if got := canFallback(tc.ctx, tc.req, tc.err, tc.streamed); got != tc.want {
			t.Errorf("%s: canFallback = %v, want %v", tc.name, got, tc.want)
		}
	}
}
