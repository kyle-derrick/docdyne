// content_csp_test.go：CSP 中间件功能测试——验证 content.allow_same_origin
// 设置切换后，/content/* 响应头即时变化（用户反馈「开关不生效」的回归）。
package http

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestContentCSPMiddleware 验证 content.allow_same_origin 开关切换后
// CSP 头即时变化（中间件热读取，无需重启）。
func TestContentCSPMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	fake := &fakeSettingsService{boolKeys: map[string]bool{}}
	h := NewHandler(nil, nil, nil, nil, nil, nil, nil, false, "", 0)
	h.settings = fake

	// 模拟 content 路由 + 中间件。
	r := gin.New()
	r.GET("/content/test", h.contentCSP(), func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	getCSP := func() string {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/content/test", nil))
		return w.Header().Get("Content-Security-Policy")
	}

	// 默认（未设置）：严格沙箱，无 allow-same-origin。
	if csp := getCSP(); csp != "sandbox allow-scripts" {
		t.Fatalf("默认 CSP = %q, want %q", csp, "sandbox allow-scripts")
	}

	// 开启后：追加 allow-same-origin。
	fake.boolKeys["content.allow_same_origin"] = true
	if csp := getCSP(); csp != "sandbox allow-scripts allow-same-origin" {
		t.Fatalf("开启后 CSP = %q, want %q", csp, "sandbox allow-scripts allow-same-origin")
	}

	// 关闭恢复。
	fake.boolKeys["content.allow_same_origin"] = false
	if csp := getCSP(); csp != "sandbox allow-scripts" {
		t.Fatalf("关闭后 CSP = %q, want %q", csp, "sandbox allow-scripts")
	}
}
