// content_csp.go：/content/* 与 /raw/* 的动态 CSP 沙箱头。
//
// 替代 Caddyfile 的静态 CSP——从 system_settings 的 content.allow_same_origin
// 键热读取（管理页 Toggle 即时生效，无需重启/reload Caddy）：
//
//	false（默认）= sandbox allow-scripts（严格隔离，禁 localStorage）
//	true         = sandbox allow-scripts allow-same-origin（localStorage 可用）
//
// 中间件先行设置基线值（覆盖 handler 未触及的错误/404 路径）；webpkg/raw
// handler 成功路径以各自更完整的基线 CSP（webpkgCSP/rawCSP）经 contentCSPValue
// 重新计算并覆盖——追加语义一致，均为 sandbox 指令末尾按需补 allow-same-origin。
package http

import (
	"log"

	"github.com/gin-gonic/gin"

	"github.com/kyle-derrick/docdyne/internal/settings"
)

// contentCSP 返回 /content/* 与 /raw/* 的 CSP 中间件。
func (h *Handler) contentCSP() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Content-Security-Policy", h.contentCSPValue("sandbox allow-scripts"))
		c.Header("X-Content-Type-Options", "nosniff")
		c.Next()
	}
}

// contentCSPValue 在 base CSP 的 sandbox 指令末尾按平台设置追加
// allow-same-origin（content.allow_same_origin 热读取）。仅读取异常时记日志
// （settings 缺失/键未配置均为正常态，静默回落 base，避免每请求刷屏）。
func (h *Handler) contentCSPValue(base string) string {
	if h.settings == nil {
		return base
	}
	allow, err := h.settings.GetBool(settings.KeyContentAllowSameOrigin)
	if err != nil {
		log.Printf("[contentCSP] GetBool(%s) error: %v", settings.KeyContentAllowSameOrigin, err)
		return base
	}
	if allow {
		return base + " allow-same-origin"
	}
	return base
}
