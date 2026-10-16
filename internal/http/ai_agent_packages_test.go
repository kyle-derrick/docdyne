// ai_agent_packages_test.go：Agent 技能包管理端点测试（I 批次）——
// 管理端 CRUD（校验 400 INVALID_AI_PACKAGES）、导出 json/yaml、导入
// upsert/replace 与 builtin- 拒收。
package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// newAIAgentPackagesRouter 组装技能包管理端点测试路由。
func newAIAgentPackagesRouter(fake *fakeSettingsService, actor uuid.UUID) *gin.Engine {
	gin.SetMode(gin.TestMode)
	h := NewHandler(nil, nil, nil, nil, nil, nil, nil, false, "", time.Hour)
	h.settings = fake
	withUser := func(handle gin.HandlerFunc) gin.HandlerFunc {
		return func(c *gin.Context) {
			c.Set("user_id", actor)
			handle(c)
		}
	}
	r := gin.New()
	r.GET("/api/v1/admin/settings/ai/agent-packages", withUser(h.adminAIAgentPackagesList))
	r.PUT("/api/v1/admin/settings/ai/agent-packages", withUser(h.adminPutAIAgentPackages))
	r.GET("/api/v1/admin/settings/ai/agent-packages/export", withUser(h.adminExportAIAgentPackages))
	r.POST("/api/v1/admin/settings/ai/agent-packages/import", withUser(h.adminImportAIAgentPackages))
	return r
}

// TestAIAgentPackagesCRUD：GET 空态空数组 → PUT 保存（含 version/
// changelog）→ 回读一致；非法 changelog date → 400 INVALID_AI_PACKAGES。
func TestAIAgentPackagesCRUD(t *testing.T) {
	actor := uuid.New()
	r := newAIAgentPackagesRouter(&fakeSettingsService{}, actor)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings/ai/agent-packages", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"packages":[]`) {
		t.Fatalf("empty list = %d %s", w.Code, w.Body.String())
	}

	// 非法 changelog date → 400 INVALID_AI_PACKAGES（错误含字段定位）。
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings/ai/agent-packages", strings.NewReader(
		`{"packages":[{"id":"p1","name":"P1","version":2,"changelog":[{"version":1,"date":"2026-13-99","note":"bad"}]}]}`))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "INVALID_AI_PACKAGES") {
		t.Fatalf("bad date = %d %s", w.Code, w.Body.String())
	}

	// 合法载荷（version + changelog + tools/kinds）→ 200 回读。
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings/ai/agent-packages", strings.NewReader(
		`{"packages":[{"id":"p1","name":"P1","system_extra":"extra","tools":["dd_read_file"],"kinds":["text"],"version":2,"changelog":[{"version":1,"date":"2026-10-01","note":"init"},{"version":2,"note":"tune"}]}]}`))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("put = %d %s", w.Code, w.Body.String())
	}
	for _, want := range []string{`"id":"p1"`, `"version":2`, `"note":"init"`, `"note":"tune"`, `"dd_read_file"`} {
		if !strings.Contains(w.Body.String(), want) {
			t.Fatalf("put body %s must contain %s", w.Body.String(), want)
		}
	}
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings/ai/agent-packages", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"version":2`) {
		t.Fatalf("get back = %d %s", w.Code, w.Body.String())
	}
}

// TestAIAgentPackagesExport：json 返回 envelope（packages/exported_at/
// scope）；yaml 为人读文本（键名 snake_case 一致）。
func TestAIAgentPackagesExport(t *testing.T) {
	actor := uuid.New()
	fake := &fakeSettingsService{}
	r := newAIAgentPackagesRouter(fake, actor)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings/ai/agent-packages", strings.NewReader(
		`{"packages":[{"id":"p1","name":"P1","system_extra":"s","version":3}]}`))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("put = %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings/ai/agent-packages/export?format=json", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("export json = %d %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	for _, want := range []string{`"packages"`, `"exported_at"`, `"scope":"platform"`, `"system_extra":"s"`, `"version":3`} {
		if !strings.Contains(body, want) {
			t.Fatalf("json export %s must contain %s", body, want)
		}
	}
	if disp := w.Header().Get("Content-Disposition"); !strings.Contains(disp, "docdyne-agent-packages.json") {
		t.Fatalf("content-disposition = %q", disp)
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings/ai/agent-packages/export?format=yaml", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("export yaml = %d %s", w.Code, w.Body.String())
	}
	ybody := w.Body.String()
	for _, want := range []string{"packages:", "system_extra: s", "version: 3"} {
		if !strings.Contains(ybody, want) {
			t.Fatalf("yaml export %s must contain %s", ybody, want)
		}
	}

	// 非法 format → 400。
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings/ai/agent-packages/export?format=xml", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad format = %d", w.Code)
	}
}

// TestAIAgentPackagesImport：upsert 按 id 合并（builtin- 拒收进 skipped）；
// replace 整块替换；yaml 内容两侧通吃。
func TestAIAgentPackagesImport(t *testing.T) {
	actor := uuid.New()
	fake := &fakeSettingsService{}
	r := newAIAgentPackagesRouter(fake, actor)

	// 预置一条平台包 p1。
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings/ai/agent-packages", strings.NewReader(
		`{"packages":[{"id":"p1","name":"P1"}]}`))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("put = %d %s", w.Code, w.Body.String())
	}

	// upsert：新增 p2 + 覆盖 p1 + builtin- 拒收。
	importJSON := `{"packages":[{"id":"p2","name":"P2"},{"id":"p1","name":"P1-v2"},{"id":"builtin-x","name":"B"}]}`
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/settings/ai/agent-packages/import", strings.NewReader(
		`{"format":"json","content":`+escapeJSONString(importJSON)+`,"mode":"upsert"}`))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("import upsert = %d %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	for _, want := range []string{`"imported":1`, `"updated":1`, `"total":2`, `"id":"builtin-x"`, `"name":"P1-v2"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("import result %s must contain %s", body, want)
		}
	}

	// yaml 裸数组导入（replace）：整块替换为单条 y1。
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/settings/ai/agent-packages/import", strings.NewReader(
		`{"format":"yaml","content":"- id: y1\n  name: Y1\n  system_extra: hi\n","mode":"replace"}`))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("import yaml replace = %d %s", w.Code, w.Body.String())
	}
	body = w.Body.String()
	if !strings.Contains(body, `"total":1`) || !strings.Contains(body, `"id":"y1"`) {
		t.Fatalf("yaml replace result = %s", body)
	}

	// 空 content → 400。
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/settings/ai/agent-packages/import", strings.NewReader(
		`{"format":"json","content":"  "}`))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty content = %d", w.Code)
	}
}

// escapeJSONString 把任意文本编成 JSON 字符串字面量（嵌入测试载荷）。
func escapeJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
