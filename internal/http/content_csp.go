// content_csp.go：/content/* 与 /raw/* 的动态 CSP 沙箱头。
//
// 替代 Caddyfile 的静态 CSP——从 system_settings 的 content.allow_same_origin
// 键热读取（管理页 Toggle 即时生效，无需重启/reload Caddy）：
//
//	false（默认）= sandbox allow-scripts（严格隔离，禁 localStorage）
//	true         = sandbox allow-scripts allow-same-origin（localStorage 可用）
package http

import (
	"log"

	"github.com/gin-gonic/gin"

	"github.com/kyle-derrick/docdyne/internal/settings"
)

// contentCSP 返回 /content/* 与 /raw/* 的 CSP 中间件。
func (h *Handler) contentCSP() gin.HandlerFunc {
	return func(c *gin.Context) {
		csp := "sandbox allow-scripts"
		if h.settings == nil {
			log.Printf("[contentCSP] settings service is nil, using default CSP")
		} else {
			allow, err := h.settings.GetBool(settings.KeyContentAllowSameOrigin)
			if err != nil {
				log.Printf("[contentCSP] GetBool(%s) error: %v", settings.KeyContentAllowSameOrigin, err)
			} else if allow {
				csp = "sandbox allow-scripts allow-same-origin"
			} else {
				log.Printf("[contentCSP] GetBool(%s) = false (setting not enabled)", settings.KeyContentAllowSameOrigin)
			}
		}
		c.Header("Content-Security-Policy", csp)
		c.Header("X-Content-Type-Options", "nosniff")
		c.Next()
	}
}
