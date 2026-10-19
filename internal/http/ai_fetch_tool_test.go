// Package http —— ai_fetch_tool_test.go：dd_fetch_url 网页抓取工具单测
// （HTML 剥离/截断、JSON 透传、Content-Type 白名单、SSRF 守卫、URL 校验）。
package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// publicPageURL 起一个返回固定 Content-Type/正文的 httptest 站点并返回
// 其 URL（守卫已在用例内放行 127.0.0.1）。
func publicPageURL(t *testing.T, ctype, body string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", ctype)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// callToolRaw 执行工具并返回 (ok, error, 原始结果 JSON)。
func callToolRaw(t *testing.T, ptc *platformToolCtx, name, args string) (bool, string, string) {
	t.Helper()
	out, err := ptc.executePlatformTool(name, json.RawMessage(args))
	if err != nil {
		return false, err.Error(), out
	}
	var res struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal([]byte(out), &res)
	return res.OK, res.Error, out
}

// unmarshalToolResult 把工具结果 JSON 解到目标结构。
func unmarshalToolResult(raw string, dst any) error {
	return json.Unmarshal([]byte(raw), dst)
}

// withFetchGuard 测试内替换 SSRF 守卫（放行 httptest 的 127.0.0.1 目标）
// 并在用例结束时恢复。
func withFetchGuard(t *testing.T, f func(*url.URL) error) {
	t.Helper()
	prev := fetchGuard
	fetchGuard = f
	t.Cleanup(func() { fetchGuard = prev })
}

// TestToolFetchURLHTML dd_fetch_url 抓 HTML 页：正文剥离标签、max_chars
// 截断并标注 truncated。
func TestToolFetchURLHTML(t *testing.T) {
	ptc, _, _, _ := newPlatformToolEnv(t)
	withFetchGuard(t, func(*url.URL) error { return nil })
	long := strings.Repeat("正", 100) + "<script>alert(1)</script>"
	ok, msg, raw := callToolRaw(t, ptc, "dd_fetch_url",
		`{"url":"`+publicPageURL(t, "text/html", "<html><body><h1>标题</h1><p>"+long+"</p></body></html>")+`","max_chars":50}`)
	if !ok {
		t.Fatalf("dd_fetch_url 失败: %s", msg)
	}
	var res struct {
		OK        bool   `json:"ok"`
		Content   string `json:"content"`
		Truncated bool   `json:"truncated"`
	}
	if err := unmarshalToolResult(raw, &res); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Content, "标题") {
		t.Fatalf("content 缺标题: %q", res.Content)
	}
	if strings.Contains(res.Content, "alert") {
		t.Fatalf("script 未剥离: %q", res.Content)
	}
	if !res.Truncated || len([]rune(res.Content)) != 50 {
		t.Fatalf("截断失败: truncated=%v len=%d", res.Truncated, len([]rune(res.Content)))
	}
}

// TestToolFetchURLJSON JSON 正文原样透传、不截断。
func TestToolFetchURLJSON(t *testing.T) {
	ptc, _, _, _ := newPlatformToolEnv(t)
	withFetchGuard(t, func(*url.URL) error { return nil })
	ok, msg, raw := callToolRaw(t, ptc, "dd_fetch_url",
		`{"url":"`+publicPageURL(t, "application/json", `{"a":1}`)+`"}`)
	if !ok {
		t.Fatalf("dd_fetch_url 失败: %s", msg)
	}
	var res struct {
		Content string `json:"content"`
	}
	if err := unmarshalToolResult(raw, &res); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(res.Content) != `{"a":1}` {
		t.Fatalf("json passthrough broken: %q", res.Content)
	}
}

// TestToolFetchURLRejects 非法输入与内容类型拒绝：ftp scheme / 二进制
// Content-Type / 空 url。
func TestToolFetchURLRejects(t *testing.T) {
	ptc, _, _, _ := newPlatformToolEnv(t)
	withFetchGuard(t, func(*url.URL) error { return nil })
	if ok, _ := callTool(t, ptc, "dd_fetch_url", `{"url":""}`); ok {
		t.Fatal("空 url 应拒绝")
	}
	if ok, msg := callTool(t, ptc, "dd_fetch_url", `{"url":"ftp://example.com/f"}`); ok {
		t.Fatalf("非 http(s) scheme 应拒绝: %s", msg)
	}
	bin := publicPageURL(t, "application/octet-stream", "\x00\x01")
	if ok, msg := callTool(t, ptc, "dd_fetch_url", `{"url":"`+bin+`"}`); ok {
		t.Fatalf("二进制 Content-Type 应拒绝: %s", msg)
	}
}

// TestFetchSSRFGuard 守卫本体：环回/私有/链路本地地址拒绝，公网 IP 放行
// （公网域名不解析依赖外网——用字面 IP 直测）。
func TestFetchSSRFGuard(t *testing.T) {
	for _, bad := range []string{
		"http://127.0.0.1/x", "http://localhost/x", "http://10.0.0.1/x",
		"http://192.168.1.1/x", "http://172.16.0.1/x", "http://169.254.1.1/x",
		"http://[::1]/x", "http://0.0.0.0/x",
	} {
		u, err := url.Parse(bad)
		if err != nil {
			t.Fatal(err)
		}
		if err := fetchSSRFGuard(u); err == nil {
			t.Fatalf("%s 应被 SSRF 守卫拒绝", bad)
		}
	}
	for _, good := range []string{"http://8.8.8.8/x", "https://1.1.1.1/x"} {
		u, err := url.Parse(good)
		if err != nil {
			t.Fatal(err)
		}
		if err := fetchSSRFGuard(u); err != nil {
			t.Fatalf("%s 不应被拒绝: %v", good, err)
		}
	}
}
