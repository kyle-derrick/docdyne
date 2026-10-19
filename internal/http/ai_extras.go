// Package http —— ai_extras.go：AI 配置体系补全端点（平台人设 / 技能
// 模板 / 用户记忆）。
//
// 平台人设与技能（system_settings 的 ai.personas / ai.skills 键，管理员
// 维护、EffectImmediate）：登录用户经 GET /ai/personas|/ai/skills 读取
// （空配置返回空数组，不随 AI 总开关 404——人设/技能是配置数据而非对话
// 能力）；管理端 GET/PUT /admin/settings/ai/personas|/ai/skills 整块读替
// （校验见 settings 包：≤50 条、id 唯一、name ≤64、prompt ≤4000）。
//
// 用户记忆（ai_memory 表，migration 050，本人维度、仅手动维护——自动
// 提取落库 v1 不做）：GET/POST/PUT/DELETE /ai/memory（PUT 编辑 content、
// kind 不变）；/ai/chat 的 include_memory=true 时取最近 20 条拼入 system
// 上下文（总量按 aiMemoryContextMaxRunes 截断，「以下是用户的长期偏好
// 记忆…」，见 aiChat 的 aiMemoryContextBlock）。
//
// 外部 MCP 服务器（system_settings 的 ai.mcp 键）：登录用户经 GET
// /ai/mcp 读启用服务（仅 id/name，不泄 URL/凭据——前端 use_mcp 开关
// 展示）；管理端 GET/PUT /admin/settings/ai/mcp 整块读替（auth_header
// 只写不读：留空 = 按 ID 继承现值，回显 auth_header_configured 布尔）；
// POST /admin/settings/ai/mcp/test 按给定参数实测连通性（支持草稿）。
package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"github.com/kyle-derrick/docdyne/internal/ai"
	"github.com/kyle-derrick/docdyne/internal/auth"
	"github.com/kyle-derrick/docdyne/internal/mcpclient"
	"github.com/kyle-derrick/docdyne/internal/settings"
)

// ---------- 平台人设 / 技能模板 ----------

// aiPersonasList GET /api/v1/ai/personas（登录可用）：人设数组（内置默认
// 置顶 + 平台配置；热读取；未装配 settings 服务或读取失败仅返回内置——
// 配置数据 best-effort，不阻塞前端人设下拉）。管理端 GET /admin/settings/
// ai/personas 复用本端点（内置条目 builtin- 前缀只读，管理端编辑仅平台层）。
func (h *Handler) aiPersonasList(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"personas": append([]settings.AIPersonaDef{ai.BuiltinPersona()}, h.platformPersonas()...)})
}

func (h *Handler) platformPersonas() []settings.AIPersonaDef {
	if h.settings == nil {
		return []settings.AIPersonaDef{}
	}
	list, err := h.settings.AIPersonas()
	if err != nil || list == nil {
		return []settings.AIPersonaDef{}
	}
	return list
}

// adminAIPersonasList GET /api/v1/admin/settings/ai/personas：管理端平台层
// 全量（不含内置条目——内置只读、编辑仅平台层；登录侧 aiPersonasList
// 才合并内置置顶）。
func (h *Handler) adminAIPersonasList(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"personas": h.platformPersonas()})
}

// aiSkillsList GET /api/v1/ai/skills（登录可用）：平台技能数组（语义同
// personas；数组顺序即展示顺序）。
func (h *Handler) aiSkillsList(c *gin.Context) {
	// 登录侧仅返回启用技能（停用项管理端可见，用户侧隐藏）。
	c.JSON(http.StatusOK, gin.H{"skills": h.platformSkills()})
}

func (h *Handler) platformSkills() []settings.AISkillDef {
	if h.settings == nil {
		return []settings.AISkillDef{}
	}
	list, err := h.settings.AISkills()
	if err != nil || list == nil {
		return []settings.AISkillDef{}
	}
	enabled := make([]settings.AISkillDef, 0, len(list))
	for _, s := range list {
		if s.Enabled == nil || *s.Enabled {
			enabled = append(enabled, s)
		}
	}
	return enabled
}

// adminAISkillsList GET /api/v1/admin/settings/ai/skills：管理端全量列表
// （含停用项，enabled 字段透传）。
func (h *Handler) adminAISkillsList(c *gin.Context) {
	if h.settings == nil {
		c.JSON(http.StatusOK, gin.H{"skills": []settings.AISkillDef{}})
		return
	}
	list, err := h.settings.AISkills()
	if err != nil || list == nil {
		c.JSON(http.StatusOK, gin.H{"skills": []settings.AISkillDef{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"skills": list})
}

// adminPutAIPersonas PUT /api/v1/admin/settings/ai/personas：整块替换平台
// 人设（校验失败 400 INVALID_AI_PERSONAS，error 含字段定位）。
func (h *Handler) adminPutAIPersonas(c *gin.Context) {
	if h.settings == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	var req struct {
		Personas []settings.AIPersonaDef `json:"personas"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	list, err := h.settings.SetAIPersonas(req.Personas, userID(c))
	if err != nil {
		if errors.Is(err, settings.ErrInvalidValue) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_PERSONAS"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai personas"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"personas": list})
}

// adminPutAISkills PUT /api/v1/admin/settings/ai/skills：整块替换平台技能
// （校验失败 400 INVALID_AI_SKILLS）。
func (h *Handler) adminPutAISkills(c *gin.Context) {
	if h.settings == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	var req struct {
		Skills []settings.AISkillDef `json:"skills"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	list, err := h.settings.SetAISkills(req.Skills, userID(c))
	if err != nil {
		if errors.Is(err, settings.ErrInvalidValue) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_SKILLS"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai skills"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"skills": list})
}

// ---------- 编辑器 Agent 技能包（管理端 CRUD + 导入导出，I 批次） ----------

// aiPackageImportMaxBytes 导入载荷上限（文本；50 条 ×4KB system 提示的
// 充分冗余）。
const aiPackageImportMaxBytes = 256 << 10

// adminAIAgentPackagesList GET /api/v1/admin/settings/ai/agent-packages：
// 平台包全量（内置包编译期内置，不在此列表——导出端点 scope=builtin 可取）。
func (h *Handler) adminAIAgentPackagesList(c *gin.Context) {
	if h.settings == nil {
		c.JSON(http.StatusOK, gin.H{"packages": []settings.AIAgentPackageDef{}})
		return
	}
	list, err := h.settings.AIAgentPackages()
	if err != nil || list == nil {
		c.JSON(http.StatusOK, gin.H{"packages": []settings.AIAgentPackageDef{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"packages": list})
}

// adminPutAIAgentPackages PUT /api/v1/admin/settings/ai/agent-packages：
// 整块替换平台包（校验失败 400 INVALID_AI_PACKAGES，error 含字段定位）。
func (h *Handler) adminPutAIAgentPackages(c *gin.Context) {
	if h.settings == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	var req struct {
		Packages []settings.AIAgentPackageDef `json:"packages"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	list, err := h.settings.SetAIAgentPackages(req.Packages, userID(c))
	if err != nil {
		if errors.Is(err, settings.ErrInvalidValue) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_PACKAGES"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai agent packages"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"packages": list})
}

// aiPackageExportFile 导出文件名前缀（format 决定扩展名）。
const aiPackageExportFile = "docdyne-agent-packages"

// adminExportAIAgentPackages GET /api/v1/admin/settings/ai/agent-packages/
// export?format=json|yaml&scope=platform|builtin|all：技能包导出（I2，可
// 分享/导入）。JSON 为机器交换权威格式；YAML 供人读分享（键名与 JSON
// 一致，导入两侧通吃）。scope 默认 platform（builtin=编译期内置包，all=
// 两者合并）。
func (h *Handler) adminExportAIAgentPackages(c *gin.Context) {
	format := strings.TrimSpace(c.DefaultQuery("format", "json"))
	if format != "json" && format != "yaml" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "format must be json or yaml"})
		return
	}
	scope := strings.TrimSpace(c.DefaultQuery("scope", "platform"))
	var packs []settings.AIAgentPackageDef
	switch scope {
	case "platform":
		list, err := h.settings.AIAgentPackages()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load ai agent packages"})
			return
		}
		packs = list
	case "builtin", "all":
		for _, p := range h.agentPackagesForKind("") {
			if scope == "builtin" && !strings.HasPrefix(p.ID, "builtin-") {
				continue
			}
			packs = append(packs, p)
		}
		if scope == "all" {
			list, err := h.settings.AIAgentPackages()
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load ai agent packages"})
				return
			}
			packs = append(packs, list...)
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "scope must be platform, builtin or all"})
		return
	}
	if packs == nil {
		packs = []settings.AIAgentPackageDef{}
	}
	ext, mime := "json", "application/json"
	if format == "yaml" {
		ext, mime = "yaml", "text/yaml"
	}
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%s.%s", aiPackageExportFile, ext))
	c.Header("Content-Type", mime+"; charset=utf-8")
	envelope := map[string]any{"packages": packs, "exported_at": time.Now().UTC().Format(time.RFC3339), "scope": scope}
	if format == "yaml" {
		// 结构体无 yaml tag——直接 yaml.Marshal 会用小写字段名（systemextra）
		// 漂移 snake_case 契约；经 JSON roundtrip（map 键名来自 json tag）
		// 保持导出键名与 JSON 完全一致。
		raw, err := json.Marshal(envelope)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to marshal yaml"})
			return
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to marshal yaml"})
			return
		}
		out, err := yaml.Marshal(m)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to marshal yaml"})
			return
		}
		c.String(http.StatusOK, string(out))
		return
	}
	c.JSON(http.StatusOK, envelope)
}

// adminImportAIAgentPackages POST /api/v1/admin/settings/ai/agent-packages/
// import {format:'json'|'yaml', content, mode:'upsert'|'replace'}：技能包
// 导入（I2）。upsert（缺省）按 id 合并（incoming 覆盖同 id 平台包）；
// replace 整块替换。builtin- 前缀 id 拒收（内置包编译期内置不可覆盖）。
// 返回 {imported, updated, skipped:[{id,reason}], total}。
func (h *Handler) adminImportAIAgentPackages(c *gin.Context) {
	if h.settings == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	var req struct {
		Format  string `json:"format"`
		Content string `json:"content"`
		Mode    string `json:"mode"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Content) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content is required"})
		return
	}
	if len(req.Content) > aiPackageImportMaxBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content too large (max 256KB)"})
		return
	}
	format := strings.TrimSpace(req.Format)
	if format == "" {
		format = "json"
	}
	if format != "json" && format != "yaml" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "format must be json or yaml"})
		return
	}
	mode := strings.TrimSpace(req.Mode)
	if mode == "" {
		mode = "upsert"
	}
	if mode != "upsert" && mode != "replace" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mode must be upsert or replace"})
		return
	}

	// 解析为通用结构（envelope 或裸数组均接受；YAML 走 map 中转保持键名）。
	var raw any
	if format == "yaml" {
		if err := yaml.Unmarshal([]byte(req.Content), &raw); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid yaml: " + err.Error()})
			return
		}
	} else {
		if err := json.Unmarshal([]byte(req.Content), &raw); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json: " + err.Error()})
			return
		}
	}
	listRaw := raw
	if m, ok := raw.(map[string]any); ok {
		v, _ := m["packages"]
		listRaw = v
	}
	roundtrip, err := json.Marshal(listRaw)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unable to normalize packages"})
		return
	}
	var incoming []settings.AIAgentPackageDef
	if err := json.Unmarshal(roundtrip, &incoming); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "packages shape mismatch (expect array of package objects)"})
		return
	}

	existing, err := h.settings.AIAgentPackages()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load ai agent packages"})
		return
	}
	// upsert 从现有列表合并出发；replace 整块替换（现有列表仅用于计数
	// updated——被覆盖的同 id 计入 updated 而非 imported）。
	byID := make(map[string]settings.AIAgentPackageDef, len(existing))
	for _, p := range existing {
		if mode == "replace" {
			continue
		}
		byID[p.ID] = p
	}
	existingIDs := make(map[string]bool, len(existing))
	for _, p := range existing {
		existingIDs[p.ID] = true
	}
	type skip struct {
		ID     string `json:"id"`
		Reason string `json:"reason"`
	}
	skipped := make([]skip, 0)
	imported, updated := 0, 0
	for _, p := range incoming {
		id := strings.TrimSpace(p.ID)
		if id == "" {
			skipped = append(skipped, skip{ID: p.ID, Reason: "id 为空"})
			continue
		}
		if strings.HasPrefix(id, "builtin-") {
			skipped = append(skipped, skip{ID: id, Reason: "内置包不可导入覆盖（id 保留 builtin- 前缀）"})
			continue
		}
		p.ID = id
		if existingIDs[id] {
			updated++
		} else {
			imported++
		}
		byID[id] = p
	}
	merged := make([]settings.AIAgentPackageDef, 0, len(byID))
	for _, p := range byID {
		merged = append(merged, p)
	}
	// 排序稳定（按 id），避免 map 迭代顺序导致的无谓 diff。
	sort.Slice(merged, func(i, j int) bool { return merged[i].ID < merged[j].ID })
	saved, err := h.settings.SetAIAgentPackages(merged, userID(c))
	if err != nil {
		if errors.Is(err, settings.ErrInvalidValue) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_PACKAGES"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai agent packages"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"imported": imported, "updated": updated, "skipped": skipped, "total": len(saved), "packages": saved})
}

// ---------- 用户记忆（ai_memory，本人维度） ----------

// aiMemoryContextLimit include_memory 注入时取的最近记忆条数。
const aiMemoryContextLimit = 20

// aiMemoryTitleRunes 标题列表中单条记忆的截取长度（rune 计，v7.15 A7：
// system 只带标题不再全量注入）。20 条 ×≤48 字符 ≈ 千字符内（~200 tok），
// 替代旧的全量注入（≤6000 字符常驻）；详情由模型按需 dd_read_memory。
const aiMemoryTitleRunes = 48

// aiMemoryStore 抽象记忆存取（生产实现 *auth.UserStore，NewHandler 装配；
// 接口化便于单测注入内存实现，模式同 aiPrefsStore）。
type aiMemoryStore interface {
	ListAIMemory(userID uuid.UUID, limit int) ([]auth.AIMemory, error)
	CreateAIMemory(userID uuid.UUID, kind, content string) (auth.AIMemory, error)
	UpdateAIMemory(userID, id uuid.UUID, content string) (auth.AIMemory, bool, error)
	DeleteAIMemory(userID, id uuid.UUID) (bool, error)
}

var _ aiMemoryStore = (*auth.UserStore)(nil)

// aiMemoryContextBlock 拼装记忆上下文块（include_memory 开启时经
// appendContextSystem 并入首条 system 消息，v7.15 A7 工具式记忆）：
// 只注入最近 20 条的「标题列表」（每条截 aiMemoryTitleRunes 字符，时间
// 正序阅读自然）+ 工具用法提示——完整内容由模型在需要时 dd_read_memory
// 按需读取，用户明确表达新偏好时 dd_write_memory 记录。标题列表为用户
// 自述数据（AI 亦可代写），整体经 ai.UntrustedBlock 围栏隔离（J2）。
// 未装配存储 / 读取失败 / 无记忆返回空串（静默降级，不阻塞对话）。
func (h *Handler) aiMemoryContextBlock(user uuid.UUID) string {
	if h.aiMemory == nil {
		return ""
	}
	items, err := h.aiMemory.ListAIMemory(user, aiMemoryContextLimit)
	if err != nil || len(items) == 0 {
		return ""
	}
	var b strings.Builder
	for i := len(items) - 1; i >= 0; i-- { // List 为倒序，注入反转为时间正序
		title := []rune(items[i].Content)
		if len(title) > aiMemoryTitleRunes {
			title = append(title[:aiMemoryTitleRunes], []rune("…")...)
		}
		b.WriteString("\n- " + string(title))
	}
	return "以下是用户的长期偏好记忆标题列表（完整内容用 dd_read_memory 工具按关键词查询；用户明确表达值得长期记住的偏好时用 dd_write_memory 记录）：\n" +
		ai.UntrustedBlock("用户记忆标题", strings.TrimPrefix(b.String(), "\n"))
}

// aiMemoryList GET /api/v1/ai/memory：本人记忆列表（最新在前，≤200 条）。
func (h *Handler) aiMemoryList(c *gin.Context) {
	if h.aiMemory == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai memory is not configured"})
		return
	}
	items, err := h.aiMemory.ListAIMemory(userID(c), 200)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load ai memory"})
		return
	}
	if items == nil {
		items = []auth.AIMemory{}
	}
	c.JSON(http.StatusOK, gin.H{"memories": items})
}

// aiMemoryCreate POST /api/v1/ai/memory {content, kind?}：新增一条手动
// 记忆（kind 缺省 manual；auto 为服务端自动提取专用值，API 拒绝——
// 内部写入走 auth.UserStore.CreateAutoAIMemory，见 ai_memory_auto.go）。
func (h *Handler) aiMemoryCreate(c *gin.Context) {
	if h.aiMemory == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai memory is not configured"})
		return
	}
	var req struct {
		Content string `json:"content"`
		Kind    string `json:"kind"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	item, err := h.aiMemory.CreateAIMemory(userID(c), strings.TrimSpace(req.Kind), req.Content)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidAIMemory) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_MEMORY"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai memory"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"memory": item})
}

// aiMemoryDelete DELETE /api/v1/ai/memory/:id：删除本人一条记忆；不存在
// /非本人 404（不区分，避免越权探测）。
func (h *Handler) aiMemoryDelete(c *gin.Context) {
	if h.aiMemory == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai memory is not configured"})
		return
	}
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	found, err := h.aiMemory.DeleteAIMemory(userID(c), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to delete ai memory"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "ai memory not found"})
		return
	}
	c.Status(http.StatusNoContent)
}

// aiMemoryUpdate PUT /api/v1/ai/memory/:id {content}：编辑本人一条记忆的
// content（kind 不变）。不存在/非本人 404（不区分，避免越权探测——语义
// 同 DELETE）；校验失败 400 INVALID_AI_MEMORY（语义同 POST）。
func (h *Handler) aiMemoryUpdate(c *gin.Context) {
	if h.aiMemory == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai memory is not configured"})
		return
	}
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	item, found, err := h.aiMemory.UpdateAIMemory(userID(c), id, req.Content)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidAIMemory) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_MEMORY"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to update ai memory"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "ai memory not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"memory": item})
}

// ---------- 外部 MCP 服务器（ai.mcp） ----------

// mcpSettingsStore 为 ai.mcp 键的读写切片（*settings.Store 天然满足）。
// 刻意不并入 admin.go 的 settingsService 接口：以类型断言解耦，旧测试
// fake 不实现这两个方法时端点按「未配置」降级（空数组/503）。
type mcpSettingsStore interface {
	AIMCPServices() ([]settings.AIMCPServiceDef, error)
	SetAIMCPServices(list []settings.AIMCPServiceDef, actor uuid.UUID) ([]settings.AIMCPServiceDef, error)
}

// h.mcpStore 返回支持 ai.mcp 读写的 settings 服务；未装配或不支持返回
// nil（GET /ai/mcp 降级空数组）。
func (h *Handler) mcpStore() mcpSettingsStore {
	if h.settings == nil {
		return nil
	}
	store, ok := h.settings.(mcpSettingsStore)
	if !ok {
		return nil
	}
	return store
}

// aiMCPList GET /api/v1/ai/mcp（登录可用）：启用中的 MCP 服务 [{id,name}]
// （热读取；不泄 URL/auth_header——前端 use_mcp 开关展示用。配置数据
// best-effort：未装配/读取失败返回空数组，不随 AI 总开关 404）。
func (h *Handler) aiMCPList(c *gin.Context) {
	services := []gin.H{}
	store := h.mcpStore()
	if store != nil {
		if list, err := store.AIMCPServices(); err == nil {
			for _, svc := range list {
				if svc.Enabled {
					services = append(services, gin.H{"id": svc.ID, "name": svc.Name})
				}
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"services": services})
}

// aiMCPServiceView 管理端 MCP 服务视图：auth_header / headers 值只写
// 不读，仅回显 configured 布尔与 headers 键名列表（照 search.tavily 与
// 个人 MCP 的掩码模式）。
type aiMCPServiceView struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Description          string   `json:"description,omitempty"`
	URL                  string   `json:"url"`
	Enabled              bool     `json:"enabled"`
	AuthHeaderConfigured bool     `json:"auth_header_configured"`
	AuthHeaders          []string `json:"auth_headers,omitempty"`
	HeadersConfigured    bool     `json:"headers_configured"`
	TimeoutSec           int      `json:"timeout_sec,omitempty"`
	DisabledTools        []string `json:"disabled_tools,omitempty"`
}

func aiMCPServiceViews(list []settings.AIMCPServiceDef) []aiMCPServiceView {
	out := make([]aiMCPServiceView, 0, len(list))
	for _, svc := range list {
		view := aiMCPServiceView{
			ID: svc.ID, Name: svc.Name, Description: svc.Description, URL: svc.URL,
			Enabled: svc.Enabled, AuthHeaderConfigured: svc.AuthHeader != "",
			TimeoutSec: svc.TimeoutSec, DisabledTools: svc.DisabledTools,
			HeadersConfigured: len(svc.Headers) > 0,
		}
		if len(svc.Headers) > 0 {
			keys := make([]string, 0, len(svc.Headers))
			for k := range svc.Headers {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			view.AuthHeaders = keys
		}
		out = append(out, view)
	}
	return out
}

// adminGetAIMCPServices GET /api/v1/admin/settings/ai/mcp：读 MCP 服务
// 列表（auth_header 掩码为 configured 布尔）。
func (h *Handler) adminGetAIMCPServices(c *gin.Context) {
	store := h.mcpStore()
	if store == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	list, err := store.AIMCPServices()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load ai mcp services"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"services": aiMCPServiceViews(list)})
}

// adminPutAIMCPServices PUT /api/v1/admin/settings/ai/mcp {services:[...]}：
// 整块替换（auth_header 留空 = 按 ID 继承现值；校验失败 400
// INVALID_AI_MCP，≤8 条、id 1..64 唯一、name 1..64、url http(s) ≤500）。
func (h *Handler) adminPutAIMCPServices(c *gin.Context) {
	store := h.mcpStore()
	if store == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	var req struct {
		Services []settings.AIMCPServiceDef `json:"services"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	list, err := store.SetAIMCPServices(req.Services, userID(c))
	if err != nil {
		if errors.Is(err, settings.ErrInvalidValue) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_MCP"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai mcp services"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"services": aiMCPServiceViews(list)})
}

// aiMCPTestTimeout 连接测试总超时（覆盖 initialize → initialized →
// tools/list 全程，单请求仍受 mcpclient 的默认超时约束）。
const aiMCPTestTimeout = 15 * time.Second

// aiMCPTestToolsLimit 响应回显的工具详情上限（全量工具预览供「禁用单个
// 工具」选择；超大列表截断，tools 计数仍为全量）。
const aiMCPTestToolsLimit = 200

// aiMCPTestDescLimit 单工具描述回显截断（rune 计）。
const aiMCPTestDescLimit = 300

// adminTestAIMCP POST /api/v1/admin/settings/ai/mcp/test {url, auth_header?,
// headers?, timeout_sec?}：用给定参数（支持测试未保存的草稿配置）实测
// MCP 服务器连通性（共用实现见 aiMCPTestRespond；个人侧同源）。返回全量
// 工具预览（name + description 截断）。
func (h *Handler) adminTestAIMCP(c *gin.Context) {
	var req struct {
		URL        string            `json:"url"`
		AuthHeader string            `json:"auth_header"`
		Headers    map[string]string `json:"headers"`
		TimeoutSec int               `json:"timeout_sec"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	aiMCPTestRespond(c, req.URL, req.AuthHeader, req.Headers, req.TimeoutSec)
}

// aiMCPTestRespond MCP 连通性实测的共用实现（平台单 auth_header 与个人
// auth_headers 多头共用）：initialize + tools/list，返回工具数、全量工具
// 预览（≤200 条，name+description）与前 10 个工具名（兼容旧 UI）与往返
// 延迟。HTTP 恒 200，连接失败的信息在 body（ok=false + error，中文
// 友好，来自 mcpclient）。
func aiMCPTestRespond(c *gin.Context, url, authHeader string, headers map[string]string, timeoutSec int) {
	url = strings.TrimSpace(url)
	if url == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "url is required"})
		return
	}
	client := &mcpclient.Client{URL: url, AuthHeader: strings.TrimSpace(authHeader), Headers: headers}
	if timeoutSec > 0 {
		client.Timeout = time.Duration(timeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), aiMCPTestTimeout)
	defer cancel()
	start := time.Now()
	tools, err := client.ListTools(ctx)
	// 实测必然有耗时；本地环回可能整段 <1ms，下限取 1 保证延迟语义非零。
	latency := max(int64(1), time.Since(start).Milliseconds())
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"ok": false, "tools": 0, "names": []string{}, "tool_list": []gin.H{},
			"latency_ms": latency, "error": err.Error(),
		})
		return
	}
	toolList := make([]gin.H, 0, min(len(tools), aiMCPTestToolsLimit))
	names := make([]string, 0, min(len(tools), 10))
	for i, t := range tools {
		if i < aiMCPTestToolsLimit {
			desc := []rune(strings.TrimSpace(t.Description))
			if len(desc) > aiMCPTestDescLimit {
				desc = append(desc[:aiMCPTestDescLimit], []rune("…")...)
			}
			toolList = append(toolList, gin.H{"name": t.Name, "description": string(desc)})
		}
		if len(names) < 10 {
			names = append(names, t.Name)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"ok": true, "tools": len(tools), "names": names, "tool_list": toolList, "latency_ms": latency,
	})
}

// ---------- MCP JSON 快速导入 / 导出（{mcpServers} 通用格式） ----------

// aiMCPImportMaxBytes 导入载荷上限。
const aiMCPImportMaxBytes = 64 << 10

// aiMCPImportEntry {mcpServers} 格式的单服务条目（兼容 stdio 字段——
// 命令型条目跳过并说明理由）。
type aiMCPImportEntry struct {
	URL         string            `json:"url"`
	Command     string            `json:"command"`
	Args        []string          `json:"args"`
	Env         map[string]string `json:"env"`
	Headers     map[string]string `json:"headers"`
	Description string            `json:"description"`
}

// adminImportAIMCP POST /api/v1/admin/settings/ai/mcp/import {content}：
// 粘贴 {"mcpServers":{name:{url,headers,...}}} 快速导入（Claude/Cherry
// 通用的 mcpServers 格式）。stdio 条目（有 command 无 url）跳过并说明；
// http(s) 条目 upsert（同名 id 覆盖）；密钥值不导入（headers 值留空 =
// 继承现值，新键需在编辑框补值）。返回 {imported, updated, skipped}。
func (h *Handler) adminImportAIMCP(c *gin.Context) {
	store := h.mcpStore()
	if store == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Content) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content is required"})
		return
	}
	if len(req.Content) > aiMCPImportMaxBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content too large (max 64KB)"})
		return
	}
	var parsed struct {
		MCPServers map[string]aiMCPImportEntry `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(req.Content), &parsed); err != nil || len(parsed.MCPServers) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json: expect {\"mcpServers\":{name:{url,...}}}"})
		return
	}
	existing, err := store.AIMCPServices()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load ai mcp services"})
		return
	}
	type skip struct {
		Name   string `json:"name"`
		Reason string `json:"reason"`
	}
	skipped := make([]skip, 0)
	byID := make(map[string]settings.AIMCPServiceDef, len(existing))
	order := make([]string, 0, len(existing))
	for _, svc := range existing {
		if _, ok := byID[svc.ID]; !ok {
			order = append(order, svc.ID)
		}
		byID[svc.ID] = svc
	}
	// 名称稳定排序（map 迭代随机，导入结果须可复现）。
	names := make([]string, 0, len(parsed.MCPServers))
	for name := range parsed.MCPServers {
		names = append(names, name)
	}
	sort.Strings(names)
	imported, updated := 0, 0
	for _, name := range names {
		entry := parsed.MCPServers[name]
		id := strings.TrimSpace(name)
		if entry.URL == "" {
			if entry.Command != "" {
				skipped = append(skipped, skip{Name: name, Reason: "stdio 命令型服务不支持（仅 Streamable HTTP）"})
			} else {
				skipped = append(skipped, skip{Name: name, Reason: "缺少 url"})
			}
			continue
		}
		if id == "" || len([]rune(id)) > settings.AIPlatformMaxIDRunes {
			skipped = append(skipped, skip{Name: name, Reason: "名称作为 id 须为 1..64 字符"})
			continue
		}
		svc := settings.AIMCPServiceDef{
			ID: id, Name: id, URL: strings.TrimSpace(entry.URL), Enabled: true,
			Description: strings.TrimSpace(entry.Description),
		}
		// headers 值按导入原文（空值 = 继承现值语义交给 SetAIMCPServices）。
		if len(entry.Headers) > 0 {
			headers := make(map[string]string, len(entry.Headers))
			for k, v := range entry.Headers {
				headers[strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
			svc.Headers = headers
		}
		if _, exists := byID[id]; exists {
			updated++
		} else {
			imported++
			order = append(order, id)
		}
		byID[id] = svc
	}
	merged := make([]settings.AIMCPServiceDef, 0, len(order))
	for _, id := range order {
		merged = append(merged, byID[id])
	}
	saved, err := store.SetAIMCPServices(merged, userID(c))
	if err != nil {
		if errors.Is(err, settings.ErrInvalidValue) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "INVALID_AI_MCP"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to save ai mcp services"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"imported": imported, "updated": updated, "skipped": skipped,
		"services": aiMCPServiceViews(saved), "total": len(saved),
	})
}

// adminExportAIMCP GET /api/v1/admin/settings/ai/mcp/export：导出
// {"mcpServers":{name:{url,headers:{key:""}}}}——结构对齐通用导入格式；
// 密钥不导出（headers 值恒空串，导入侧补值）。
func (h *Handler) adminExportAIMCP(c *gin.Context) {
	store := h.mcpStore()
	if store == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settings service is not configured"})
		return
	}
	list, err := store.AIMCPServices()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load ai mcp services"})
		return
	}
	servers := make(map[string]gin.H, len(list))
	for _, svc := range list {
		entry := gin.H{"url": svc.URL}
		if svc.Description != "" {
			entry["description"] = svc.Description
		}
		if len(svc.Headers) > 0 {
			headers := make(map[string]string, len(svc.Headers))
			for k := range svc.Headers {
				headers[k] = "" // 密钥不导出
			}
			entry["headers"] = headers
		}
		servers[svc.Name] = entry
	}
	c.Header("Content-Disposition", "attachment; filename=docdyne-mcp-servers.json")
	c.JSON(http.StatusOK, gin.H{"mcpServers": servers, "exported_at": time.Now().UTC().Format(time.RFC3339)})
}

// agentPackagesForKind 返回编辑器 Agent 技能包（内置 + 平台定义合并；
// kind 非空时过滤适用包）。内置包按编辑类型提供领域专家规范（多段式：
// 角色定位 / 操作纪律 / 输出规范 / 自检清单）。
func (h *Handler) agentPackagesForKind(kind string) []settings.AIAgentPackageDef {
	packs := []settings.AIAgentPackageDef{
		{
			ID: "builtin-excel-analyst", Name: "Excel 报表专家", Kinds: []string{"text"}, Version: 2,
			Description: "整表产出导向的 Excel 规范：数据理解 → write_table 一次成型 → 格式与校验",
			SystemExtra: "你是 Excel 报表专家，目标是产出用户可直接使用的整表（而非零散单元格）。\n\n" +
				"【数据理解纪律】\n" +
				"- 动笔前先 read_range 扫描表头与前几行样例，确认每列语义；列义不明时先向用户确认，不要猜测。\n" +
				"- 用户给出的是行式数据时，整理为「首行表头 + 一行一条记录」的标准形态。\n\n" +
				"【写表规范】\n" +
				"- 整表一律用 write_table：给含表头行的完整二维数组（行列全 1 基：[1,1]=A1），由机制保证行列不偏移；禁止逐格 write_cells 拼整表。\n" +
				"- 数字/百分比/货币/日期列设置 numberFormat（如 0.00%、#,##0、yyyy-mm-dd）；关键行可加条件格式突出；表头冻结。\n" +
				"- 合计/占比等派生值优先自行计算后写入结果值（必要时附公式列），避免整表跨引用的脆弱公式链。\n\n" +
				"【自检清单（硬性）】完成后 read_range 回读核对：行列数与预期一致、表头完整、numberFormat 生效、抽查 2-3 个合计值正确；发现问题先修复再交付。\n\n" +
				"【输出约定】过程说明与总结使用中文；末尾用 ≤3 行说明产出了什么表、做了哪些格式化。",
		},
		{
			ID: "builtin-diagram-architect", Name: "图表架构师", Kinds: []string{"excalidraw-json", "drawio-xml"}, Version: 2,
			Description: "白板/图示方法论：视觉模式选型 → 分节插入 → 连线纪律 → 重读自检",
			SystemExtra: "你是图表架构师（成熟 excalidraw/drawio skill 方法论）。\n\n" +
				"【规划先行】动笔前 read_scene/list_cells 掌握现状；新图先在心中列出元素清单与层级（谁是焦点、谁分组），再开始插入。\n\n" +
				"【视觉模式速查】图要论证而非罗列——每个概念选匹配其行为的视觉模式：层级/从属→树；流程/时序→时间线箭头链；因果/依赖→有向箭头；中心辐射→扇出；对比→并排+分隔；忌等大的盒子阵列。留白即层级：焦点元素最大、周围最空。\n\n" +
				"【插入与连线纪律】\n" +
				"- 新增优先 insert_elements/insert_cells（大图分节多次插入，可用 at 锚点精确落点），禁止整图重画。\n" +
				"- 加连线一律 connect {fromId,toId}（白板）或带 source/target 的边（drawio），勿手算坐标。\n" +
				"- 改色改字用 update_elements/update_cells；重构连线=只删旧箭头再重连，节点不动。\n\n" +
				"【自检循环（硬性）】每完成一节/一次修改后必须重读（read_scene/list_cells）验证：无重叠、无悬空连线、标签完整未截断、间距均匀、对齐网格；发现问题先修复再继续，全部通过才 FINAL。\n\n" +
				"【输出约定】始终使用中文（过程说明与总结）。",
		},
		{
			ID: "builtin-doc-reviewer", Name: "文档审校", Kinds: []string{"richtext-patch", "text"}, Version: 2,
			Description: "最小改动审校：检查维度清单 → 唯一片段定位 → 逐条输出 → 回读自检",
			SystemExtra: "你是严谨的文档审校（成熟 docx/pdf skill 方法论）。\n\n" +
				"【检查维度清单】错别字与语病 / 术语全文一致（同一概念同一译名）/ 数字与单位准确 / 标点全半角统一 / 标题层级连续（不跳级）/ 列表风格统一（顿号/圆点不混用）/ 中英文之间留空格。\n\n" +
				"【定位纪律】逐条定位修改点：find/search_text 用 10-80 字的原文唯一片段，逐字复制（含原文的空格与标点），禁止凭记忆转写。\n\n" +
				"【最小改动原则】\n" +
				"- 格式调整优先 format_text/set_block_type/set_paragraph_style，不整段替换正文。\n" +
				"- 嵌入占位行（[DocDyne-Embed …] 等 [DocDyne-*] 标记）一律原样保留、逐字不动。\n" +
				"- 不擅自增删段落内容；确需增删时先向用户说明理由。\n\n" +
				"【输出格式】逐条输出「位置 - 问题 - 建议/已改动」；无法定位的问题单列说明。\n\n" +
				"【自检循环（硬性）】每批修改后 read_document 抽查改动点：格式未破坏、无重复段落、占位行完整；发现问题先修复再继续。语言：始终使用中文。",
		},
	}
	if h.settings != nil {
		if svc, ok := h.settings.(interface {
			AIAgentPackages() ([]settings.AIAgentPackageDef, error)
		}); ok {
			if extra, err := svc.AIAgentPackages(); err == nil {
				packs = append(packs, extra...)
			}
		}
	}
	if kind == "" {
		return packs
	}
	out := packs[:0]
	for _, p := range packs {
		if len(p.Kinds) == 0 {
			out = append(out, p)
			continue
		}
		for _, k := range p.Kinds {
			if k == kind {
				out = append(out, p)
				break
			}
		}
	}
	return out
}
