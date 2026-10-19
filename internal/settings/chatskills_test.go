package settings

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TestValidateAIChatSkills 校验对话技能边界：条数/重复 id/字段长度。
func TestValidateAIChatSkills(t *testing.T) {
	enabled := true
	ok := []AIChatSkillDef{{ID: "translate", Name: "翻译", Content: "把输入翻译为英文。", Enabled: &enabled}}
	if err := ValidateAIChatSkills(ok); err != nil {
		t.Fatalf("valid list rejected: %v", err)
	}
	if err := ValidateAIChatSkills([]AIChatSkillDef{{ID: "x", Name: "空内容", Content: "  "}}); err == nil {
		t.Fatal("empty content accepted")
	}
	if err := ValidateAIChatSkills([]AIChatSkillDef{
		{ID: "a", Name: "A", Content: "x"},
		{ID: "a", Name: "B", Content: "y"},
	}); err == nil {
		t.Fatal("duplicate id accepted")
	}
	if err := ValidateAIChatSkills([]AIChatSkillDef{{ID: "a", Name: "A", Content: strings.Repeat("字", 4001)}}); err == nil {
		t.Fatal("oversized content accepted")
	}
	if err := ValidateAIChatSkills([]AIChatSkillDef{{ID: "a", Name: "A", Icon: strings.Repeat("i", 41), Content: "x"}}); err == nil {
		t.Fatal("oversized icon accepted")
	}
}

// TestAIRulesRoundTrip 规则读写：默认空、写入回读、超长拒绝、显式清空。
func TestAIRulesRoundTrip(t *testing.T) {
	store := newTestStore(newMemRepo(), &memAudit{})
	actor := uuid.New()
	if v, err := store.AIRules(); err != nil || v != "" {
		t.Fatalf("unset rules should be empty, got %q err=%v", v, err)
	}
	if _, err := store.SetAIRules("回答保持简洁。", actor); err != nil {
		t.Fatalf("set rules: %v", err)
	}
	if v, _ := store.AIRules(); v != "回答保持简洁。" {
		t.Fatalf("rules round-trip mismatch: %q", v)
	}
	if _, err := store.SetAIRules(strings.Repeat("规", 4001), actor); err == nil {
		t.Fatal("oversized rules accepted")
	}
	if _, err := store.SetAIRules("  ", actor); err != nil {
		t.Fatalf("clear rules: %v", err)
	}
	if v, _ := store.AIRules(); v != "" {
		t.Fatalf("explicit empty should clear, got %q", v)
	}
}

// TestSetAIMCPHeadersInherit headers 值留空 = 按 ID+键继承现值（掩码回读
// 保存不得擦密钥）；auth_header 继承语义保持。
func TestSetAIMCPHeadersInherit(t *testing.T) {
	store := newTestStore(newMemRepo(), &memAudit{})
	actor := uuid.New()
	seed := []AIMCPServiceDef{{
		ID: "demo", Name: "Demo", URL: "https://mcp.example.com/mcp", Enabled: true,
		AuthHeader: "Authorization: Bearer secret-token",
		Headers:    map[string]string{"X-Api-Key": "k1", "X-Tenant": "t1"},
	}}
	if _, err := store.SetAIMCPServices(seed, actor); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// 掩码回读形态：headers 值为空（继承），X-Tenant 显式换新值。
	got, err := store.SetAIMCPServices([]AIMCPServiceDef{{
		ID: "demo", Name: "Demo", URL: "https://mcp.example.com/mcp", Enabled: true,
		Headers: map[string]string{"X-Api-Key": "", "X-Tenant": "t2"},
	}}, actor)
	if err != nil {
		t.Fatalf("save with masked headers: %v", err)
	}
	if got[0].AuthHeader != "Authorization: Bearer secret-token" {
		t.Fatalf("auth_header inherit broken: %q", got[0].AuthHeader)
	}
	if got[0].Headers["X-Api-Key"] != "k1" {
		t.Fatalf("header inherit broken: %q", got[0].Headers["X-Api-Key"])
	}
	if got[0].Headers["X-Tenant"] != "t2" {
		t.Fatalf("header explicit update broken: %q", got[0].Headers["X-Tenant"])
	}
}

// TestSetAIMCPNewFields 校验新字段边界：description/timeout/disabled_tools。
func TestSetAIMCPNewFields(t *testing.T) {
	store := newTestStore(newMemRepo(), &memAudit{})
	actor := uuid.New()
	bad := []AIMCPServiceDef{{ID: "a", Name: "A", URL: "https://x.example.com", TimeoutSec: 61, Enabled: true}}
	if _, err := store.SetAIMCPServices(bad, actor); err == nil {
		t.Fatal("timeout >60 accepted")
	}
	bad = []AIMCPServiceDef{{ID: "a", Name: "A", URL: "https://x.example.com", DisabledTools: []string{"t", "t"}, Enabled: true}}
	if _, err := store.SetAIMCPServices(bad, actor); err == nil {
		t.Fatal("duplicate disabled tool accepted")
	}
	bad = []AIMCPServiceDef{{ID: "a", Name: "A", URL: "https://x.example.com", Description: strings.Repeat("描", 201), Enabled: true}}
	if _, err := store.SetAIMCPServices(bad, actor); err == nil {
		t.Fatal("oversized description accepted")
	}
	good := []AIMCPServiceDef{{ID: "a", Name: "A", URL: "https://x.example.com", TimeoutSec: 30, DisabledTools: []string{"dangerous_tool"}, Enabled: true}}
	if _, err := store.SetAIMCPServices(good, actor); err != nil {
		t.Fatalf("valid new fields rejected: %v", err)
	}
}

// TestDefaultPersonaValidation default_persona：builtin- 前缀/现存 id 放行、
// dangling 拒绝；nil 载荷保持现值。
func TestDefaultPersonaValidation(t *testing.T) {
	store := newTestStore(newMemRepo(), &memAudit{})
	actor := uuid.New()
	persona := "writer"
	cfg := DefaultAIConfig()
	cfg.DefaultPersona = &persona
	cfg.Personas = []AIPersonaDef{{ID: "writer", Name: "写作", SystemPrompt: "你是一名写作助手。"}}
	if _, err := store.SetAI(cfg, DefaultAIConfig(), actor); err != nil {
		t.Fatalf("persona id should validate: %v", err)
	}
	builtin := "builtin-assistant"
	cfg2 := DefaultAIConfig()
	cfg2.DefaultPersona = &builtin
	if _, err := store.SetAI(cfg2, DefaultAIConfig(), actor); err != nil {
		t.Fatalf("builtin prefix should validate: %v", err)
	}
	dangling := "ghost"
	cfg3 := DefaultAIConfig()
	cfg3.DefaultPersona = &dangling
	if _, err := store.SetAI(cfg3, DefaultAIConfig(), actor); err == nil {
		t.Fatal("dangling default_persona accepted")
	}
	// nil 载荷（旧客户端）= 保持现值：此前最后一次成功写入为 builtin-assistant。
	ov, _, err := store.AIOverrides()
	if err != nil {
		t.Fatalf("overrides: %v", err)
	}
	cur := DefaultAIConfig()
	cur.Temperature = ov.Temperature // 避免零值回退干扰
	cur.DefaultPersona = nil
	if _, err := store.SetAI(cur, DefaultAIConfig(), actor); err != nil {
		t.Fatalf("nil payload save: %v", err)
	}
	ov2, _, _ := store.AIOverrides()
	if ov2.DefaultPersona == nil || *ov2.DefaultPersona != "builtin-assistant" {
		t.Fatalf("nil payload should keep current default_persona, got %v", ov2.DefaultPersona)
	}
}

// TestSetAIPersonasClearsDanglingDefaultPersona 人设删除后悬空
// default_persona 被静默置空。
func TestSetAIPersonasClearsDanglingDefaultPersona(t *testing.T) {
	store := newTestStore(newMemRepo(), &memAudit{})
	actor := uuid.New()
	if _, err := store.SetAIPersonas([]AIPersonaDef{{ID: "writer", Name: "写作", SystemPrompt: "p"}}, actor); err != nil {
		t.Fatalf("seed personas: %v", err)
	}
	cfg := DefaultAIConfig()
	persona := "writer"
	cfg.DefaultPersona = &persona
	if _, err := store.SetAI(cfg, DefaultAIConfig(), actor); err != nil {
		t.Fatalf("set default_persona: %v", err)
	}
	// 删除 writer 人设 → default_persona 悬空 → 应被清空。
	if _, err := store.SetAIPersonas([]AIPersonaDef{{ID: "coder", Name: "编码", SystemPrompt: "p"}}, actor); err != nil {
		t.Fatalf("replace personas: %v", err)
	}
	ov, _, _ := store.AIOverrides()
	if ov.DefaultPersona == nil || *ov.DefaultPersona != "" {
		t.Fatalf("dangling default_persona should be cleared, got %v", ov.DefaultPersona)
	}
}

// TestHistorySearchVectorAllowed vector 取值合法；非法值拒绝。
func TestHistorySearchVectorAllowed(t *testing.T) {
	cfg := DefaultAIConfig()
	cfg.HistorySearch = "vector"
	if err := ValidateAI(cfg); err != nil {
		t.Fatalf("vector should be valid: %v", err)
	}
	cfg.HistorySearch = "semantic"
	if err := ValidateAI(cfg); err == nil {
		t.Fatal("invalid history_search accepted")
	}
}

// TestSearchProxyAndBuiltinProviders 代理 URL 校验 + duckduckgo/bing 合法。
func TestSearchProxyAndBuiltinProviders(t *testing.T) {
	cfg := DefaultAIConfig()
	cfg.Search.Provider = "duckduckgo"
	if err := ValidateAI(cfg); err != nil {
		t.Fatalf("duckduckgo should be valid: %v", err)
	}
	cfg.Search.Provider = "bing"
	if err := ValidateAI(cfg); err != nil {
		t.Fatalf("bing should be valid: %v", err)
	}
	cfg.Search.ProxyURL = "http://127.0.0.1:20170"
	if err := ValidateAI(cfg); err != nil {
		t.Fatalf("proxy url should be valid: %v", err)
	}
	cfg.Search.ProxyURL = "not-a-url"
	if err := ValidateAI(cfg); err == nil {
		t.Fatal("invalid proxy url accepted")
	}
}
