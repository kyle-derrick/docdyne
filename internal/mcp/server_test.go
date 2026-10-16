package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kyle-derrick/docdyne/internal/ai"
	"github.com/kyle-derrick/docdyne/internal/files"
	"github.com/kyle-derrick/docdyne/internal/search"
	"github.com/kyle-derrick/docdyne/internal/space"
)

// ---------- 测试替身 ----------

// fakeFiles 是 FileStore 的最小内存实现：多数方法返回 notFound，
// CreateFolderIn 记录调用供断言。
type fakeFiles struct {
	root     files.File
	created  []string
	notFound bool
}

func (f *fakeFiles) DefaultSpaceRoot(user uuid.UUID) (files.File, error) {
	if f.root.OwnerID == user {
		return f.root, nil
	}
	return files.File{}, files.ErrNotFound
}
func (f *fakeFiles) ListSpace(spaceID, parent uuid.UUID, limit int, sort files.SpaceListFilter) ([]files.File, error) {
	return nil, nil
}
func (f *fakeFiles) Get(user, id uuid.UUID) (files.File, error) {
	return files.File{}, files.ErrNotFound
}
func (f *fakeFiles) CreateFolderIn(user, parent uuid.UUID, name string) (files.File, error) {
	if f.notFound {
		return files.File{}, files.ErrNotFound
	}
	f.created = append(f.created, name)
	return files.File{ID: uuid.New(), Name: name, OwnerID: user, SpaceID: f.root.SpaceID, Type: "folder"}, nil
}
func (f *fakeFiles) Rename(user, id uuid.UUID, name string) (files.File, error) {
	return files.File{}, files.ErrNotFound
}
func (f *fakeFiles) Copy(user, id, parent uuid.UUID, name string) (files.File, error) {
	return files.File{}, files.ErrNotFound
}
func (f *fakeFiles) Delete(user, id uuid.UUID) error { return files.ErrNotFound }
func (f *fakeFiles) Restore(user, id uuid.UUID) (files.File, error) {
	return files.File{}, files.ErrNotFound
}
func (f *fakeFiles) ListTrashSpace(user, spaceID uuid.UUID, limit int) ([]files.File, error) {
	return nil, nil
}
func (f *fakeFiles) ListVersions(user, fileID uuid.UUID) ([]files.VersionDetail, error) {
	return nil, files.ErrNotFound
}
func (f *fakeFiles) SetCurrentVersion(user, fileID, versionID uuid.UUID) (files.File, files.FileVersion, error) {
	return files.File{}, files.FileVersion{}, files.ErrNotFound
}
func (f *fakeFiles) ReadVersion(user, fileID, versionID uuid.UUID) (files.File, files.FileVersion, files.ObjectBlob, error) {
	return files.File{}, files.FileVersion{}, files.ObjectBlob{}, files.ErrNotFound
}
func (f *fakeFiles) CurrentVersion(owner, fileID uuid.UUID) (files.FileVersion, files.ObjectBlob, error) {
	return files.FileVersion{}, files.ObjectBlob{}, files.ErrNoVersion
}
func (f *fakeFiles) ResolveReadablePath(actor uuid.UUID, nsType string, scopeID uuid.UUID, path string) (files.File, []files.File, error) {
	return files.File{}, nil, files.ErrNotFound
}
func (f *fakeFiles) SpaceRoot(spaceID uuid.UUID) (files.File, error) {
	if f.root.SpaceID == spaceID {
		return f.root, nil
	}
	return files.File{}, files.ErrNotFound
}
func (f *fakeFiles) GetSpaceFolder(spaceID, id uuid.UUID) (files.File, error) {
	return files.File{}, files.ErrNotFound
}
func (f *fakeFiles) BatchMove(user uuid.UUID, ids []uuid.UUID, target uuid.UUID) ([]files.BatchItemResult, error) {
	return nil, files.ErrNotFound
}

// fakeSpaces 是 SpaceService 的最小内存实现（默认空间解析与读权限）。
type fakeSpaces struct {
	owner   uuid.UUID
	spaceID uuid.UUID
}

func (s *fakeSpaces) ListSpaces(user uuid.UUID) ([]space.Space, error) { return nil, nil }
func (s *fakeSpaces) CanRead(user, spaceID uuid.UUID) (bool, error) {
	return user == s.owner && spaceID == s.spaceID, nil
}
func (s *fakeSpaces) DefaultSpace(owner uuid.UUID) (space.Space, error) {
	if owner == s.owner {
		return space.Space{ID: s.spaceID, Name: "默认空间", OwnerID: owner}, nil
	}
	return space.Space{}, space.ErrNotFound
}

// fakeSearch 记录查询关键词的搜索替身。
type fakeSearch struct {
	queries []string
}

func (s *fakeSearch) Query(user uuid.UUID, opts search.QueryOptions) ([]search.Result, error) {
	s.queries = append(s.queries, opts.Q)
	return []search.Result{{ID: uuid.New(), Name: opts.Q + ".md", Type: "file", UpdatedAt: time.Now()}}, nil
}

// fakeAI 为开关可翻转的 AI 替身（验证 ServerCache 按 Available 快照重建）。
type fakeAI struct{ enabled bool }

func (a *fakeAI) Enabled() bool { return a.enabled }
func (a *fakeAI) AskDocs(ctx context.Context, user uuid.UUID, query string, topK int, spaceID *uuid.UUID) (string, []ai.Source, error) {
	return "", nil, nil
}
func (a *fakeAI) SummarizeFile(ctx context.Context, user, fileID uuid.UUID) (string, error) {
	return "", nil
}
func (a *fakeAI) Chat(ctx context.Context, user uuid.UUID, messages []ai.Message) (string, error) {
	return "", nil
}

// newTestHandler 构造与生产同构的传输 handler（官方 SDK
// StreamableHTTPHandler，stateless + JSONResponse）与最小依赖替身。
func newTestHandler(withSearch bool) (http.Handler, *fakeFiles, *fakeSearch) {
	user := uuid.New()
	spaceID := uuid.New()
	ff := &fakeFiles{root: files.File{ID: uuid.New(), Name: "根目录", OwnerID: user, SpaceID: spaceID, Type: "folder", IsRoot: true}}
	fs := &fakeSearch{}
	deps := &Deps{Files: ff, Spaces: &fakeSpaces{owner: user, spaceID: spaceID}}
	if withSearch {
		deps.Search = fs
	}
	cache := NewServerCache(deps)
	return mcpsdk.NewStreamableHTTPHandler(func(*http.Request) *mcpsdk.Server {
		return cache.Server()
	}, &mcpsdk.StreamableHTTPOptions{Stateless: true, JSONResponse: true}), ff, fs
}

func testIdentity() Identity { return Identity{UserID: uuid.New()} }

// post 发起一次 POST /mcp（身份经 WithIdentity 注入请求上下文——生产链路
// 由 gin 鉴权中间件完成；SDK 把 http.Request.Context() 传播进工具 handler）。
func post(t *testing.T, h http.Handler, id Identity, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req = req.WithContext(WithIdentity(req.Context(), id))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// call 发起一次 tools/call 并解析 JSON 应答为通用 map。
func call(t *testing.T, h http.Handler, id Identity, name string, arguments string) map[string]any {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":` + arguments + `}}`
	rec := post(t, h, id, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("tools/call %s: status = %d (%s)", name, rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal response: %v (%s)", err, rec.Body.String())
	}
	return out
}

// toolResult 取 result 子对象（缺失返回 nil）。
func toolResult(out map[string]any) map[string]any {
	result, _ := out["result"].(map[string]any)
	return result
}

// ---------- 协议层测试 ----------

// initialize：协议版本回显（2025-03-26 受支持即返回同版本）、
// capabilities.tools、serverInfo、instructions。
func TestInitialize(t *testing.T) {
	h, _, _ := newTestHandler(false)
	body := `{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"tester","version":"0"}}}`
	rec := post(t, h, testIdentity(), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("initialize: status = %d (%s)", rec.Code, rec.Body.String())
	}
	var out struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id"`
		Result  struct {
			ProtocolVersion string         `json:"protocolVersion"`
			Capabilities    map[string]any `json:"capabilities"`
			ServerInfo      struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"serverInfo"`
			Instructions string `json:"instructions"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, rec.Body.String())
	}
	if out.JSONRPC != "2.0" || out.ID != 7 {
		t.Fatalf("envelope = %s id=%d", out.JSONRPC, out.ID)
	}
	if out.Result.ProtocolVersion != "2025-03-26" {
		t.Fatalf("protocolVersion = %q", out.Result.ProtocolVersion)
	}
	if _, ok := out.Result.Capabilities["tools"]; !ok {
		t.Fatalf("capabilities.tools missing: %v", out.Result.Capabilities)
	}
	if out.Result.ServerInfo.Name != ServerName || out.Result.ServerInfo.Version == "" {
		t.Fatalf("serverInfo = %+v", out.Result.ServerInfo)
	}
	if !strings.Contains(out.Result.Instructions, "DocDyne") {
		t.Fatalf("instructions = %q, want DocDyne guidance", out.Result.Instructions)
	}
}

// tools/list：至少 20 个工具；文件工具 dd_ 前缀，AI 工具
// （ask_docs/summarize_file/ai_chat，任务书命名）除外；inputSchema 为 object。
func TestToolsListAtLeast20(t *testing.T) {
	h, _, _ := newTestHandler(false)
	rec := post(t, h, testIdentity(), `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("tools/list: status = %d (%s)", rec.Code, rec.Body.String())
	}
	var out struct {
		Result struct {
			Tools []struct {
				Name        string         `json:"name"`
				Description string         `json:"description"`
				InputSchema map[string]any `json:"inputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, rec.Body.String())
	}
	if len(out.Result.Tools) < 20 {
		t.Fatalf("tools count = %d, want >= 20", len(out.Result.Tools))
	}
	aiToolNames := map[string]bool{"ask_docs": false, "summarize_file": false, "ai_chat": false}
	seen := map[string]bool{}
	for _, tool := range out.Result.Tools {
		if _, isAI := aiToolNames[tool.Name]; !strings.HasPrefix(tool.Name, "dd_") && !isAI {
			t.Fatalf("tool %q unexpected name (dd_ prefix or known AI tool required)", tool.Name)
		}
		if _, isAI := aiToolNames[tool.Name]; isAI {
			aiToolNames[tool.Name] = true
		}
		if seen[tool.Name] {
			t.Fatalf("duplicate tool %q", tool.Name)
		}
		seen[tool.Name] = true
		if tool.Description == "" {
			t.Fatalf("tool %q missing description", tool.Name)
		}
		if tool.InputSchema["type"] != "object" {
			t.Fatalf("tool %q inputSchema.type = %v", tool.Name, tool.InputSchema["type"])
		}
	}
	// 关键工具在场。
	for _, name := range []string{"dd_list_files", "dd_write_file", "dd_read_file", "dd_resolve_path", "dd_create_share", "dd_search_files"} {
		if !seen[name] {
			t.Fatalf("tool %q missing from tools/list", name)
		}
	}
	// AI 工具（任务书命名）全部在场。
	for name, present := range aiToolNames {
		if !present {
			t.Fatalf("ai tool %q missing from tools/list", name)
		}
	}
}

// 传输层拒绝（HTTP 400）：malformed payload / 未知方法。
// K6 迁移后语义破坏的请求由 SDK 在 HTTP 层拒绝（plain text），不再以
// JSON-RPC error envelope 应答。
func TestTransportRejects(t *testing.T) {
	h, _, _ := newTestHandler(false)
	for _, tc := range []struct{ name, body string }{
		{"parse-error", `{"jsonrpc":"2.0","id":1,"method":`},
		{"unknown-method", `{"jsonrpc":"2.0","id":2,"method":"docdyne/custom"}`},
	} {
		rec := post(t, h, testIdentity(), tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400 (%s)", tc.name, rec.Code, rec.Body.String())
		}
	}
}

// JSON-RPC 协议错误（HTTP 200 + error envelope）：未知工具 / 缺工具名
// 返回 -32602（JSON-RPC invalid params；SDK callTool 约定）。
func TestJSONRPCErrorCodes(t *testing.T) {
	const codeInvalidParams = -32602
	h, _, _ := newTestHandler(false)
	for _, tc := range []struct{ name, body string }{
		{"unknown-tool", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dd_nope"}}`},
		{"missing-tool-name", `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{}}`},
	} {
		rec := post(t, h, testIdentity(), tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (%s)", tc.name, rec.Code, rec.Body.String())
		}
		var out struct {
			Error struct {
				Code int `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s: unmarshal %v (%s)", tc.name, err, rec.Body.String())
		}
		if out.Error.Code != codeInvalidParams {
			t.Fatalf("%s: code = %d, want %d (%s)", tc.name, out.Error.Code, codeInvalidParams, rec.Body.String())
		}
	}
}

// 工具入参非法：按 SDK 约定转 isError 工具结果（agent 可读原因），
// K6 迁移后不再是协议级 -32602。
func TestBadArgsIsToolError(t *testing.T) {
	h, _, _ := newTestHandler(false)
	out := call(t, h, testIdentity(), "dd_get_file", `{"file_id":"not-a-uuid"}`)
	if out["error"] != nil {
		t.Fatalf("bad args must be a tool-level error, got rpc error: %v", out)
	}
	result := toolResult(out)
	if result == nil || result["isError"] != true {
		t.Fatalf("result.isError missing: %v", out)
	}
	if text := toolText(t, result); !strings.Contains(text, "file_id") {
		t.Fatalf("error text = %q, want file_id guidance", text)
	}
}

// notification（无 id / id null）：202 Accepted 无 body（SDK 传输约定）。
func TestNotificationNoResponse(t *testing.T) {
	h, _, _ := newTestHandler(false)
	for _, body := range []string{
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":null,"method":"notifications/initialized"}`,
	} {
		rec := post(t, h, testIdentity(), body)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("notification: status = %d, want 202 (%s)", rec.Code, rec.Body.String())
		}
		if rec.Body.Len() != 0 {
			t.Fatalf("notification must not have a body: %s", rec.Body.String())
		}
	}
}

// ping 返回空对象结果。
func TestPing(t *testing.T) {
	h, _, _ := newTestHandler(false)
	rec := post(t, h, testIdentity(), `{"jsonrpc":"2.0","id":9,"method":"ping"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("ping: status = %d (%s)", rec.Code, rec.Body.String())
	}
	var out struct {
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Result == nil {
		t.Fatalf("ping response = %s err=%v", rec.Body.String(), err)
	}
}

// PAT scope 不足：files:read PAT 调写工具 → isError 工具结果（missing
// scope，K6 迁移后不再用协议级 -32003）；读工具正常；未限定 scope 的 PAT
// 与 JWT 不受限。
func TestPATScopeEnforcement(t *testing.T) {
	h, ff, _ := newTestHandler(false)
	readOnly := Identity{UserID: uuid.New(), IsPAT: true, Scopes: []string{"files:read"}}
	// 写工具被拒。
	out := call(t, h, readOnly, "dd_create_folder", `{"name":"x"}`)
	if out["error"] != nil {
		t.Fatalf("scope denial must be a tool-level error, got rpc error: %v", out)
	}
	result := toolResult(out)
	if result == nil || result["isError"] != true {
		t.Fatalf("result.isError missing: %v", out)
	}
	if text := toolText(t, result); !strings.Contains(text, "missing scope") {
		t.Fatalf("error text = %q, want missing scope message", text)
	}
	// 未实际执行。
	if len(ff.created) != 0 {
		t.Fatalf("scope-denied call must not execute, created = %v", ff.created)
	}
	// 读工具走工具执行（isError 源自 fake 的 notFound，但不是 missing scope）。
	out = call(t, h, readOnly, "dd_get_file", `{"file_id":"`+uuid.New().String()+`"}`)
	if text := toolText(t, toolResult(out)); strings.Contains(text, "missing scope") {
		t.Fatalf("read tool must not be scope-denied: %v", out)
	}
	// 未限定 scope 的 PAT 可写。
	unscoped := Identity{UserID: ff.root.OwnerID, IsPAT: true}
	out = call(t, h, unscoped, "dd_create_folder", `{"name":"ok"}`)
	if out["error"] != nil {
		t.Fatalf("unscoped PAT write failed: %v", out)
	}
	if len(ff.created) != 1 || ff.created[0] != "ok" {
		t.Fatalf("created = %v", ff.created)
	}
	// JWT 可写。
	jwtID := Identity{UserID: ff.root.OwnerID}
	out = call(t, h, jwtID, "dd_create_folder", `{"name":"jwt"}`)
	if out["error"] != nil {
		t.Fatalf("jwt write failed: %v", out)
	}
}

// 未注入 search：tools/list 标注「当前部署未启用」，调用返回明确结构化错误。
func TestSearchUnavailable(t *testing.T) {
	h, _, _ := newTestHandler(false)
	// tools/list 标注。
	rec := post(t, h, testIdentity(), `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	var listing struct {
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listing); err != nil {
		t.Fatalf("unmarshal tools/list: %v (%s)", err, rec.Body.String())
	}
	found := false
	for _, tool := range listing.Result.Tools {
		if tool.Name == "dd_search_files" {
			found = true
			if !strings.Contains(tool.Description, "当前部署未启用") {
				t.Fatalf("dd_search_files description = %q, want unavailable marker", tool.Description)
			}
		}
	}
	if !found {
		t.Fatal("dd_search_files missing from tools/list")
	}
	// 调用返回 isError + 明确错误信息。
	out := call(t, h, testIdentity(), "dd_search_files", `{"query":"合同"}`)
	if out["error"] != nil {
		t.Fatalf("unavailable tool must be a tool-level error, got rpc error: %v", out)
	}
	result := toolResult(out)
	if result == nil || result["isError"] != true {
		t.Fatalf("result.isError missing: %v", out)
	}
	text := toolText(t, result)
	if !strings.Contains(text, "not available") {
		t.Fatalf("error text = %q, want capability-not-available message", text)
	}
}

// 注入 search：dd_search_files 正常返回。
func TestSearchAvailable(t *testing.T) {
	h, _, fs := newTestHandler(true)
	out := call(t, h, testIdentity(), "dd_search_files", `{"query":"合同"}`)
	result := toolResult(out)
	if result == nil || result["isError"] == true {
		t.Fatalf("search call failed: %v", out)
	}
	if len(fs.queries) != 1 || fs.queries[0] != "合同" {
		t.Fatalf("queries = %v", fs.queries)
	}
}

// AI 开关运行时切换：tools/list 的「当前部署未启用」标注随
// ServerCache 快照重建时效正确（ServerCache 的存在意义）。
func TestServerCacheRebuildsOnAIAvailabilityChange(t *testing.T) {
	user := uuid.New()
	spaceID := uuid.New()
	aiFake := &fakeAI{enabled: true}
	deps := &Deps{
		Files:  &fakeFiles{root: files.File{ID: uuid.New(), Name: "根目录", OwnerID: user, SpaceID: spaceID, Type: "folder", IsRoot: true}},
		Spaces: &fakeSpaces{owner: user, spaceID: spaceID},
		AI:     aiFake,
	}
	cache := NewServerCache(deps)
	h := mcpsdk.NewStreamableHTTPHandler(func(*http.Request) *mcpsdk.Server {
		return cache.Server()
	}, &mcpsdk.StreamableHTTPOptions{Stateless: true, JSONResponse: true})

	askDocsDescription := func() string {
		t.Helper()
		rec := post(t, h, testIdentity(), `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
		var listing struct {
			Result struct {
				Tools []struct {
					Name        string `json:"name"`
					Description string `json:"description"`
				} `json:"tools"`
			} `json:"result"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &listing); err != nil {
			t.Fatalf("unmarshal tools/list: %v (%s)", err, rec.Body.String())
		}
		for _, tool := range listing.Result.Tools {
			if tool.Name == "ask_docs" {
				return tool.Description
			}
		}
		t.Fatal("ask_docs missing from tools/list")
		return ""
	}

	if desc := askDocsDescription(); strings.Contains(desc, "当前部署未启用") {
		t.Fatalf("enabled AI must not carry unavailable marker: %q", desc)
	}
	aiFake.enabled = false
	if desc := askDocsDescription(); !strings.Contains(desc, "当前部署未启用") {
		t.Fatalf("disabled AI must carry unavailable marker: %q", desc)
	}
}

func toolText(t *testing.T, result map[string]any) string {
	t.Helper()
	if result == nil {
		return ""
	}
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		return ""
	}
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	return text
}

// Identity.Allows 语义矩阵（与 RequireScope 对齐）。
func TestIdentityAllows(t *testing.T) {
	cases := []struct {
		id   Identity
		want bool
	}{
		{Identity{UserID: uuid.New()}, true},                                               // JWT
		{Identity{UserID: uuid.New(), IsPAT: true}, true},                                  // 未限定 scope 的 PAT
		{Identity{UserID: uuid.New(), IsPAT: true, Scopes: []string{"files:read"}}, false}, // 只读 PAT 调写 scope
		{Identity{UserID: uuid.New(), IsPAT: true, Scopes: []string{"files:write"}}, true},
	}
	for i, tc := range cases {
		if got := tc.id.Allows(ScopeFilesWrite); got != tc.want {
			t.Fatalf("case %d: Allows(files:write) = %v, want %v", i, got, tc.want)
		}
	}
}

// 接口约束：确保测试替身满足依赖接口。
var (
	_ FileStore     = (*fakeFiles)(nil)
	_ SearchService = (*fakeSearch)(nil)
	_ AIAssistant   = (*fakeAI)(nil)
)
