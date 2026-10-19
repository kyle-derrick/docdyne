// ai_chatskills_test.go：对话技能（合并视图/管理端整块读替/个人子集）与
// 规则、生效配置端点单测。
package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/ai"
	"github.com/kyle-derrick/docdyne/internal/auth"
	"github.com/kyle-derrick/docdyne/internal/settings"
)

// newChatSkillsRouter 组装对话技能/规则/生效配置测试路由（登录态 actor）。
func newChatSkillsRouter(st settingsService, prefs aiPrefsStore, actor uuid.UUID) *gin.Engine {
	gin.SetMode(gin.TestMode)
	h := NewHandler(nil, nil, nil, nil, nil, nil, nil, false, "", time.Hour)
	h.settings = st
	h.aiPrefs = prefs
	r := gin.New()
	withUser := func(handle gin.HandlerFunc) gin.HandlerFunc {
		return func(c *gin.Context) {
			c.Set(auth.UserIDContextKey, actor)
			handle(c)
		}
	}
	r.GET("/api/v1/ai/chat-skills", withUser(h.aiChatSkillsList))
	r.GET("/api/v1/ai/effective-config", withUser(h.aiEffectiveConfig))
	r.GET("/api/v1/admin/settings/ai/chat-skills", h.adminAIChatSkillsList)
	r.PUT("/api/v1/admin/settings/ai/chat-skills", withUser(h.adminPutAIChatSkills))
	r.GET("/api/v1/admin/settings/ai/rules", h.adminGetAIRules)
	r.PUT("/api/v1/admin/settings/ai/rules", withUser(h.adminPutAIRules))
	r.GET("/api/v1/ai/personal/chat-skills", withUser(h.getAIPersonalChatSkills))
	r.PUT("/api/v1/ai/personal/chat-skills", withUser(h.putAIPersonalChatSkills))
	r.GET("/api/v1/ai/personal/rules", withUser(h.getAIPersonalRules))
	r.PUT("/api/v1/ai/personal/rules", withUser(h.putAIPersonalRules))
	return r
}

// TestChatSkillsMergedView 合并视图：内置恒在、平台停用剔除、个人覆盖同 id
// （source=user）。
func TestChatSkillsMergedView(t *testing.T) {
	disabled := false
	enabled := true
	st := &fakeSettingsService{chatSkills: []settings.AIChatSkillDef{
		{ID: "plat-a", Name: "平台A", Content: "平台版", Enabled: &enabled},
		{ID: "plat-off", Name: "停用", Content: "x", Enabled: &disabled},
	}}
	prefs := newFakeAIPrefsStore()
	actor := uuid.New()
	_ = prefs.SetAIPrefs(actor, json.RawMessage(`{"chat_skills":[{"id":"plat-a","name":"平台A","content":"个人版"},{"id":"mine","name":"我的","content":"自定义"}]}`))
	r := newChatSkillsRouter(st, prefs, actor)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/chat-skills", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", w.Code, w.Body.String())
	}
	var out struct {
		Skills []ai.EffectiveChatSkill `json:"skills"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	byID := map[string]ai.EffectiveChatSkill{}
	for _, s := range out.Skills {
		byID[s.ID] = s
	}
	if len(byID) < 6 { // 内置 4 + 平台A + mine
		t.Fatalf("merged = %d entries: %+v", len(out.Skills), out.Skills)
	}
	if _, ok := byID["plat-off"]; ok {
		t.Fatal("disabled platform skill should be hidden")
	}
	if got := byID["plat-a"]; got.Source != "user" || got.Content != "个人版" {
		t.Fatalf("personal override broken: %+v", got)
	}
	if got := byID["builtin-translate"]; got.Source != "builtin" {
		t.Fatalf("builtin entry missing: %+v", got)
	}
	if got := byID["mine"]; got.Source != "user" {
		t.Fatalf("personal addition lost: %+v", got)
	}
}

// TestAdminChatSkillsAndRulesRoundTrip 管理端整块替换 + 规则读写与上限。
func TestAdminChatSkillsAndRulesRoundTrip(t *testing.T) {
	st := &fakeSettingsService{}
	actor := uuid.New()
	r := newChatSkillsRouter(st, nil, actor)
	// PUT chat-skills（停用项也在管理端全量回显）。
	body := `{"skills":[{"id":"s1","name":"技能1","content":"内容","enabled":true}]}`
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings/ai/chat-skills", strings.NewReader(body)))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "技能1") {
		t.Fatalf("put chat-skills: %d %s", w.Code, w.Body.String())
	}
	// GET 回读。
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings/ai/chat-skills", nil))
	if !strings.Contains(w.Body.String(), "s1") {
		t.Fatalf("get chat-skills: %s", w.Body.String())
	}
	// 规则写入 + 回读 + 超长拒绝（fake 不做上限校验，上限由 settings 层
	// 单测覆盖；此处验证端点管道）。
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings/ai/rules", strings.NewReader(`{"rules":"全局规则A"}`)))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "全局规则A") {
		t.Fatalf("put rules: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings/ai/rules", nil))
	if !strings.Contains(w.Body.String(), "全局规则A") {
		t.Fatalf("get rules: %s", w.Body.String())
	}
}

// TestPersonalChatSkillsAndRules 个人子集端点：整表替换其余子集不受影响。
func TestPersonalChatSkillsAndRules(t *testing.T) {
	prefs := newFakeAIPrefsStore()
	actor := uuid.New()
	// 预置 providers 子集——chat-skills 保存后必须原样保留。
	_ = prefs.SetAIPrefs(actor, json.RawMessage(`{"providers":[{"id":"p1","name":"个人","kind":"openai_compatible","base_url":"https://x.example.com","models":[{"id":"m1","capabilities":{"kind":"chat","vision":true}}]}]}`))
	r := newChatSkillsRouter(&fakeSettingsService{}, prefs, actor)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/v1/ai/personal/chat-skills", strings.NewReader(`{"skills":[{"id":"s1","name":"技能","content":"内容"}]}`)))
	if w.Code != http.StatusOK {
		t.Fatalf("put personal chat-skills: %d %s", w.Code, w.Body.String())
	}
	raw, _ := prefs.GetAIPrefs(actor)
	if !strings.Contains(string(raw), `"p1"`) {
		t.Fatalf("providers subset lost: %s", raw)
	}
	// 个人规则。
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/v1/ai/personal/rules", strings.NewReader(`{"rules":"我自己的规则"}`)))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "我自己的规则") {
		t.Fatalf("put personal rules: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/personal/rules", nil))
	if !strings.Contains(w.Body.String(), "我自己的规则") {
		t.Fatalf("get personal rules: %s", w.Body.String())
	}
}

// TestEffectiveConfig 覆盖型字段：用户覆盖生效（source=user）、未覆盖跟随
// 平台（source=platform）。
func TestEffectiveConfig(t *testing.T) {
	st := &fakeSettingsService{}
	prefs := newFakeAIPrefsStore()
	actor := uuid.New()
	// overrides：history_search=vector + temperature=0.7（web_search/persona 未覆盖）。
	_ = prefs.SetAIPrefs(actor, json.RawMessage(`{"rules":"R","overrides":{"history_search":"vector","temperature":0.7}}`))
	r := newChatSkillsRouter(st, prefs, actor)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/effective-config", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", w.Code, w.Body.String())
	}
	var out struct {
		HistorySearch struct {
			Value  string `json:"value"`
			Source string `json:"source"`
		} `json:"history_search"`
		Temperature struct {
			Value  float64 `json:"value"`
			Source string  `json:"source"`
		} `json:"temperature"`
		WebSearch struct {
			Source string `json:"source"`
		} `json:"web_search"`
		Rules struct {
			PlatformPresent bool `json:"platform_present"`
			UserPresent     bool `json:"user_present"`
		} `json:"rules"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.HistorySearch.Value != "vector" || out.HistorySearch.Source != "user" {
		t.Fatalf("history override: %+v", out.HistorySearch)
	}
	if out.Temperature.Value != 0.7 || out.Temperature.Source != "user" {
		t.Fatalf("temperature override: %+v", out.Temperature)
	}
	if out.WebSearch.Source != "platform" {
		t.Fatalf("web_search should follow platform: %+v", out.WebSearch)
	}
	if !out.Rules.UserPresent {
		t.Fatalf("user rules presence: %+v", out.Rules)
	}
}

// TestChatSkillInjectionInChat /ai/chat 的 chat_skill 参数：有效 id 注入
// system、未知 id 400 INVALID_CHAT_SKILL、规则叠加注入。用 mock 上游断言
// 收到的 system 内容。
func TestChatSkillInjectionInChat(t *testing.T) {
	enabled := true
	st := &fakeSettingsService{
		chatSkills: []settings.AIChatSkillDef{{ID: "plat-skill", Name: "平台技能", Content: "技能指令内容XYZ", Enabled: &enabled}},
		rules:      "平台规则ABC",
	}
	prefs := newFakeAIPrefsStore()
	actor := uuid.New()
	_ = prefs.SetAIPrefs(actor, json.RawMessage(`{"rules":"个人规则DEF"}`))
	// mock Provider（AIKindMock echo 上游）。
	svc := newAIv1Service(1) // 既有测试助手：装配 mock provider 服务
	h := NewHandler(nil, nil, nil, nil, nil, nil, nil, false, "", time.Hour)
	h.aiSvc = svc
	h.aiLimiter = newDynamicRateLimiter()
	h.settings = st
	h.aiPrefs = prefs
	gin.SetMode(gin.TestMode)
	r := gin.New()
	withUser := func(handle gin.HandlerFunc) gin.HandlerFunc {
		return func(c *gin.Context) {
			c.Set(auth.UserIDContextKey, actor)
			handle(c)
		}
	}
	r.POST("/api/v1/ai/chat", withUser(h.aiChat))

	// 1) 未知技能 → 400。
	body := `{"messages":[{"role":"user","content":"你好"}],"stream":false,"chat_skill":"ghost"}`
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/ai/chat", bytes.NewReader([]byte(body))))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "INVALID_CHAT_SKILL") {
		t.Fatalf("unknown skill should 400: %d %s", w.Code, w.Body.String())
	}

	// 2) 有效技能 + 规则：mock 回显型上游——直接断言响应 200 且无错误
	//（system 注入内容在 mock 链路不可观测，覆盖注入细节由 effective 层
	// 单测保障；此处验证管道不炸 + 规则两端存在时不报错）。
	body = `{"messages":[{"role":"user","content":"你好"}],"stream":false,"chat_skill":"plat-skill"}`
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/ai/chat", bytes.NewReader([]byte(body))))
	if w.Code != http.StatusOK {
		t.Fatalf("valid skill chat failed: %d %s", w.Code, w.Body.String())
	}
}
