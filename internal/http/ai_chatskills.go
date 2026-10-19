// Package http —— ai_chatskills.go：对话技能（Cherry Studio 式 Skills）与
// AI 规则端点 + 双层生效配置视图。
//
// 对话技能三层增量合并（内置 builtin- 只读 → 平台 ai.chat_skills → 个人
// prefs.chat_skills，按 id 个人覆盖平台）：登录用户 GET /ai/chat-skills 读
// 合并视图（含 source 徽标）；管理端 GET/PUT /admin/settings/ai/chat-skills
// 整块读替平台层；个人 GET/PUT /ai/personal/chat-skills 整表读写本人层。
// 选中技能经 /ai/chat 的 chat_skill 参数注入该轮 system 提示（见 aiChat）。
//
// 规则（叠加型）：平台 GET/PUT /admin/settings/ai/rules（≤4000 字符）+
// 个人 GET/PUT /ai/personal/rules（≤2000）；对话时两段拼接注入 system。
//
// GET /ai/effective-config：覆盖型配置的生效值 + 来源（platform|user），
// 前端「跟随平台/个人覆盖」徽标与三态控件的数据源。
package http

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/ai"
	"github.com/kyle-derrick/docdyne/internal/auth"
	"github.com/kyle-derrick/docdyne/internal/settings"
)

// chatSkillsSettingsStore 为 ai.chat_skills / ai.rules 键的读写切片（同
// mcpSettingsStore 的类型断言解耦模式：旧测试 fake 不实现时按未配置降级）。
type chatSkillsSettingsStore interface {
	AIChatSkills() ([]settings.AIChatSkillDef, error)
	SetAIChatSkills(list []settings.AIChatSkillDef, actor uuid.UUID) ([]settings.AIChatSkillDef, error)
	AIRules() (string, error)
	SetAIRules(text string, actor uuid.UUID) (string, error)
}

// h.chatSkillsStore 返回支持对话技能/规则读写的 settings 服务。
func (h *Handler) chatSkillsStore() chatSkillsSettingsStore {
	if h.settings == nil {
		return nil
	}
	store, ok := h.settings.(chatSkillsSettingsStore)
	if !ok {
		return nil
	}
	return store
}

// ---------- 登录侧合并视图 ----------

// h.mergedChatSkills 合并三层对话技能（内置 + 平台启用 + 个人）。平台/
// 个人层读取失败按空处理（配置数据 best-effort，不阻塞对话链路）。
func (h *Handler) mergedChatSkills(user uuid.UUID) []ai.EffectiveChatSkill {
	var platform []settings.AIChatSkillDef
	if store := h.chatSkillsStore(); store != nil {
		if list, err := store.AIChatSkills(); err == nil {
			platform = list
		}
	}
	var personal []auth.AIPersonalChatSkill
	if h.aiPrefs != nil {
		if prefs, ok := h.loadAIPersonalPrefs(user); ok {
			personal = prefs.ChatSkills
		}
	}
	return ai.MergeChatSkills(ai.BuiltinChatSkills(), platform, personal)
}

// aiChatSkillsList GET /api/v1/ai/chat-skills（登录可用）：合并视图
// （含 source；内置只读、平台停用项剔除、个人覆盖同 id）。
func (h *Handler) aiChatSkillsList(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"skills": h.mergedChatSkills(userID(c))})
}

// platformAIRules 读平台规则（未装配/读取失败返回空串——对话链零开销
// 跳过，规则为增强项）。
func (h *Handler) platformAIRules() string {
	if store := h.chatSkillsStore(); store != nil {
		if text, err := store.AIRules(); err == nil {
			return text
		}
	}
	return ""
}

// ---------- 管理端：平台对话技能 ----------

// adminAIChatSkillsList GET /api/v1/admin/settings/ai/chat-skills：平台层
// 全量（含停用项；内置包不在列表——经合并视图可见）。
func (h *Handler) adminAIChatSkillsList(c *gin.Context) {
	store := h.chatSkillsStore()
	if store == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	list, err := store.AIChatSkills()
	if err != nil || list == nil {
		c.JSON(http.StatusOK, gin.H{"skills": []settings.AIChatSkillDef{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"skills": list})
}

// adminPutAIChatSkills PUT /api/v1/admin/settings/ai/chat-skills：整块替换
// 平台层（校验失败 400 INVALID_AI_CHAT_SKILLS）。
func (h *Handler) adminPutAIChatSkills(c *gin.Context) {
	store := h.chatSkillsStore()
	if store == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	var req struct {
		Skills []settings.AIChatSkillDef `json:"skills"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	list, err := store.SetAIChatSkills(req.Skills, userID(c))
	if err != nil {
		if errors.Is(err, settings.ErrInvalidValue) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_CHAT_SKILLS"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai chat skills"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"skills": list})
}

// ---------- 个人对话技能 ----------

// getAIPersonalChatSkills GET /api/v1/ai/personal/chat-skills：本人对话技能
// 列表（无密钥字段，原样回显；未配置返回空数组）。
func (h *Handler) getAIPersonalChatSkills(c *gin.Context) {
	if h.aiPrefs == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "personal ai settings are not configured"})
		return
	}
	prefs, _ := h.loadAIPersonalPrefs(userID(c))
	skills := prefs.ChatSkills
	if skills == nil {
		skills = []auth.AIPersonalChatSkill{}
	}
	c.JSON(http.StatusOK, gin.H{"skills": skills})
}

// putAIPersonalChatSkills PUT /api/v1/ai/personal/chat-skills：整表替换本人
// 对话技能（≤30；其余子集原样保留）。
func (h *Handler) putAIPersonalChatSkills(c *gin.Context) {
	if h.aiPrefs == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "personal ai settings are not configured"})
		return
	}
	var req struct {
		Skills []auth.AIPersonalChatSkill `json:"skills"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request", "code": "INVALID_AI_PREFS"})
		return
	}
	saved, err := h.saveAIPersonalPrefs(userID(c), func(p *auth.AIPersonalPrefs) {
		p.ChatSkills = req.Skills
	})
	if err != nil {
		respondAIPersonalError(c, err)
		return
	}
	skills := saved.ChatSkills
	if skills == nil {
		skills = []auth.AIPersonalChatSkill{}
	}
	c.JSON(http.StatusOK, gin.H{"skills": skills})
}

// ---------- 规则（平台 + 个人，叠加型） ----------

// adminGetAIRules GET /api/v1/admin/settings/ai/rules：平台规则全文（非密
// 钥明文回显；未配置返回空串）。
func (h *Handler) adminGetAIRules(c *gin.Context) {
	store := h.chatSkillsStore()
	if store == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	rules, err := store.AIRules()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load ai rules"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": rules})
}

// adminPutAIRules PUT /api/v1/admin/settings/ai/rules {rules}：写入平台规则
// （≤4000 字符；显式空串 = 清空）。
func (h *Handler) adminPutAIRules(c *gin.Context) {
	store := h.chatSkillsStore()
	if store == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	var req struct {
		Rules string `json:"rules"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	rules, err := store.SetAIRules(req.Rules, userID(c))
	if err != nil {
		if errors.Is(err, settings.ErrInvalidValue) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_RULES"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai rules"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": rules})
}

// getAIPersonalRules GET /api/v1/ai/personal/rules：本人规则全文。
func (h *Handler) getAIPersonalRules(c *gin.Context) {
	if h.aiPrefs == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "personal ai settings are not configured"})
		return
	}
	prefs, _ := h.loadAIPersonalPrefs(userID(c))
	c.JSON(http.StatusOK, gin.H{"rules": prefs.Rules})
}

// putAIPersonalRules PUT /api/v1/ai/personal/rules {rules}：写入本人规则
// （≤2000 字符；显式空串 = 清空；其余子集原样保留）。
func (h *Handler) putAIPersonalRules(c *gin.Context) {
	if h.aiPrefs == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "personal ai settings are not configured"})
		return
	}
	var req struct {
		Rules string `json:"rules"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request", "code": "INVALID_AI_PREFS"})
		return
	}
	saved, err := h.saveAIPersonalPrefs(userID(c), func(p *auth.AIPersonalPrefs) {
		p.Rules = req.Rules
	})
	if err != nil {
		respondAIPersonalError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": saved.Rules})
}

// ---------- 生效配置视图（覆盖型 + 来源徽标） ----------

// aiEffectiveConfig GET /api/v1/ai/effective-config（登录可用）：双层配置
// 的生效值。source 取 platform|user——user 表示个人覆盖生效；覆盖型字段
// 未覆盖时值与平台一致。rules 只报两端是否配置（全文经各自端点读取）。
func (h *Handler) aiEffectiveConfig(c *gin.Context) {
	user := userID(c)
	var ov settings.AIConfig
	if h.settings != nil {
		if cfg, _, err := h.settings.AIOverrides(); err == nil {
			ov = cfg
		}
	}
	var prefs auth.AIPersonalPrefs
	if h.aiPrefs != nil {
		if p, ok := h.loadAIPersonalPrefs(user); ok {
			prefs = p
		}
	}
	userOverrides := prefs.Overrides

	// web_search：value 为对话联网搜索的默认开关（个人覆盖 > 平台默认关）。
	webValue := false
	webSource := ai.SourcePlatform
	if userOverrides != nil && userOverrides.WebSearch != nil {
		webValue, webSource = *userOverrides.WebSearch, ai.SourceUser
	}

	historyMode := ai.ResolveHistorySearchMode(ov.HistorySearch, nil)
	historySource := ai.SourcePlatform
	if userOverrides != nil && userOverrides.HistorySearch != nil {
		historyMode = ai.ResolveHistorySearchMode(ov.HistorySearch, userOverrides.HistorySearch)
		historySource = ai.SourceUser
	}

	persona := ai.ResolveDefaultPersona(ov.DefaultPersona, nil)
	personaSource := ai.SourcePlatform
	if userOverrides != nil && userOverrides.DefaultPersona != nil {
		persona = ai.ResolveDefaultPersona(ov.DefaultPersona, userOverrides.DefaultPersona)
		personaSource = ai.SourceUser
	}

	tempValue := ov.Temperature
	tempSource := ai.SourcePlatform
	if userOverrides != nil && userOverrides.Temperature != nil {
		tempValue, tempSource = *userOverrides.Temperature, ai.SourceUser
	}

	ocr := gin.H{"enabled": ov.OCR.Enabled, "provider_id": ov.OCR.ProviderID, "model_id": ov.OCR.ModelID}
	ocrSource := ai.SourcePlatform
	if userOverrides != nil && userOverrides.OCR != nil {
		ocr = gin.H{"provider_id": userOverrides.OCR.ProviderID, "model_id": userOverrides.OCR.ModelID}
		ocrSource = ai.SourceUser
	}

	platformRules := false
	if store := h.chatSkillsStore(); store != nil {
		if text, err := store.AIRules(); err == nil && text != "" {
			platformRules = true
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"web_search":      gin.H{"value": webValue, "source": webSource},
		"history_search":  gin.H{"value": historyMode, "source": historySource},
		"default_persona": gin.H{"value": persona, "source": personaSource},
		"temperature":     gin.H{"value": tempValue, "source": tempSource},
		"ocr":             gin.H{"value": ocr, "source": ocrSource},
		"rules":           gin.H{"platform_present": platformRules, "user_present": prefs.Rules != ""},
	})
}
