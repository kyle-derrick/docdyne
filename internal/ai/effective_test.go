// effective_test.go：双层配置合并/生效解析单测（对话技能三层合并、规则
// 叠加、覆盖型解析、内置内容）。
package ai

import (
	"strings"
	"testing"

	"github.com/kyle-derrick/docdyne/internal/auth"
	"github.com/kyle-derrick/docdyne/internal/settings"
)

func TestMergeChatSkills(t *testing.T) {
	disabled := false
	enabled := true
	builtin := []settings.AIChatSkillDef{
		{ID: "builtin-translate", Name: "翻译", Content: "内置翻译", Enabled: &enabled},
		{ID: "builtin-polish", Name: "润色", Content: "内置润色", Enabled: &enabled},
	}
	platform := []settings.AIChatSkillDef{
		{ID: "custom-rag", Name: "检索专家", Content: "平台版", Enabled: &enabled},
		{ID: "gone", Name: "停用项", Content: "x", Enabled: &disabled},
		{ID: "builtin-translate", Name: "平台覆盖内置", Content: "平台版翻译", Enabled: &enabled},
	}
	personal := []auth.AIPersonalChatSkill{
		{ID: "custom-rag", Name: "检索专家", Content: "个人版"},
		{ID: "my-skill", Name: "我的技能", Content: "个人新增"},
	}
	merged := MergeChatSkills(builtin, platform, personal)
	byID := map[string]EffectiveChatSkill{}
	for _, s := range merged {
		byID[s.ID] = s
	}
	// 内置被平台同 id 覆盖（source=platform），位置保持在内置区。
	if got := byID["builtin-translate"]; got.Source != SourcePlatform || got.Content != "平台版翻译" {
		t.Fatalf("platform should override builtin: %+v", got)
	}
	// 个人覆盖平台同 id（source=user）。
	if got := byID["custom-rag"]; got.Source != SourceUser || got.Content != "个人版" {
		t.Fatalf("personal should override platform: %+v", got)
	}
	// 平台停用项剔除；个人新增保留。
	if _, ok := byID["gone"]; ok {
		t.Fatal("disabled platform skill should be hidden")
	}
	if got := byID["my-skill"]; got.Source != SourceUser {
		t.Fatalf("personal addition lost: %+v", got)
	}
	// 顺序：内置区在前（builtin-polish 第二位）。
	if merged[1].ID != "builtin-polish" {
		t.Fatalf("order broken: %+v", merged)
	}
}

func TestEffectiveRules(t *testing.T) {
	if got := EffectiveRules("", ""); got != "" {
		t.Fatalf("both empty should be empty, got %q", got)
	}
	if got := EffectiveRules("P", ""); !strings.Contains(got, "平台规则") || strings.Contains(got, "个人") {
		t.Fatalf("platform-only: %q", got)
	}
	if got := EffectiveRules("", "U"); !strings.Contains(got, "用户个人规则") {
		t.Fatalf("user-only: %q", got)
	}
	got := EffectiveRules("P", "U")
	if !strings.Contains(got, "平台规则") || !strings.Contains(got, "用户个人规则") {
		t.Fatalf("both should be additive: %q", got)
	}
}

func TestResolveHistorySearchMode(t *testing.T) {
	userVector := "vector"
	userBad := "semantic"
	cases := []struct {
		platform string
		user     *string
		want     string
	}{
		{"", nil, HistorySearchKeyword},
		{"off", nil, HistorySearchOff},
		{"vector", nil, HistorySearchVector},
		{"keyword", &userVector, HistorySearchVector}, // 用户覆盖优先
		{"vector", &userBad, HistorySearchVector},     // 用户非法值按未设置
		{"bad-value", nil, HistorySearchKeyword},      // 平台非法值回退默认
		{"", &userBad, HistorySearchKeyword},
	}
	for _, c := range cases {
		if got := ResolveHistorySearchMode(c.platform, c.user); got != c.want {
			t.Fatalf("ResolveHistorySearchMode(%q,%v) = %q, want %q", c.platform, c.user, got, c.want)
		}
	}
}

func TestResolveDefaultPersona(t *testing.T) {
	if got := ResolveDefaultPersona(nil, nil); got != "" {
		t.Fatalf("nil/nil should be empty, got %q", got)
	}
	platform := "plat-writer"
	user := "me:custom"
	if got := ResolveDefaultPersona(&platform, &user); got != user {
		t.Fatalf("user override: %q", got)
	}
	if got := ResolveDefaultPersona(&platform, nil); got != platform {
		t.Fatalf("platform fallback: %q", got)
	}
}

func TestBuiltinContent(t *testing.T) {
	p := BuiltinPersona()
	if p.ID != BuiltinPersonaID || !strings.HasPrefix(p.ID, settings.AIPersonaBuiltinPrefix) || p.Name == "" || p.SystemPrompt == "" {
		t.Fatalf("builtin persona malformed: %+v", p)
	}
	skills := BuiltinChatSkills()
	if len(skills) < 4 {
		t.Fatalf("expect ≥4 builtin chat skills, got %d", len(skills))
	}
	for _, s := range skills {
		if !strings.HasPrefix(s.ID, "builtin-") || strings.TrimSpace(s.Content) == "" || s.Name == "" {
			t.Fatalf("builtin skill malformed: %+v", s)
		}
	}
}
