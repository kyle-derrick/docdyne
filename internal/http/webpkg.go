package http

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/kyle-derrick/docdyne/internal/files"
	"github.com/kyle-derrick/docdyne/internal/webpkg"
)

// webpkgCSP 为 /content 端点的严格 CSP：
//   - default-src 'none'：默认禁止一切外联加载；
//   - style-src 'self' 'unsafe-inline'：静态页内联样式普遍存在，放开内联；
//   - script-src 'self'：仅允许同前缀脚本文件（内联脚本被拒绝）；
//   - img-src 'self' data：支持 data: 内嵌小图；
//   - font-src 'self'：自托管字体；
//   - sandbox allow-scripts：文档进入唯一化 origin 的沙箱（不含
//     allow-same-origin），直接导航也无法触碰主站源与 Cookie——
//     该路径在 /api/v1 之外，天然不携带主站 refresh cookie。
// CSP 只做资源白名单兜底（object-src/base-uri 硬禁），脚本/样式/图片/
// 字体/连接等放行到与历史有效策略（sandbox-only）等同的兼容面——导出的
// 网页包普遍含内联 script/外域资源（统计代码、CDN 字体、API 轮询），
// 收紧 script-src 会直接让页面无法引导（曾经的真实回归：策略长期被
// Caddy 静态头掩盖，Caddy 移除静态下发后首次真正生效即白屏）。
// 隔离由 sandbox 指令 + iframe sandbox 属性 + 剥 Cookie 共同保证。
// 注意：本常量必须以「sandbox allow-scripts」结尾——contentCSPValue 的
// 追加语义是在策略末尾（即 sandbox 指令）补 allow-same-origin。
const webpkgCSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; font-src * data:; connect-src *; media-src * data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; sandbox allow-scripts"

// webpkgContent GET /content/:pid/*filepath：网页包子资源提供端点。
// 无 Bearer、无 Cookie 依赖（独立按 IP 轻限流 WEBPKG_RATE_LIMIT_PER_MIN）；
// 子资源仅从本内容路径提供。任何解析失败统一 404，不泄露细节。
//
// svg 的处置选择：内联（无 Content-Disposition: attachment）。理由：
// CSP 中的 sandbox 指令使直接导航进入唯一化 origin 的沙箱文档，
// 其中脚本既不能访问主站源（同源判定失败）也带不上主站 Cookie，
// 导航型 XSS 的攻击面已被覆盖；改用 attachment 反而破坏 <img> 场景一致性，
// 故与 html/css 等同以内联 + 同一最严格 CSP 提供。
func (h *Handler) webpkgContent(c *gin.Context) {
	pid := c.Param("pid")
	rel := strings.TrimPrefix(c.Param("filepath"), "/")
	rc, contentType, ok := h.webpkg.Resolve(pid, rel)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	defer rc.Close()
	c.Header("Content-Security-Policy", h.contentCSPValue(webpkgCSP))
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "private, max-age=300")
	c.DataFromReader(http.StatusOK, -1, contentType, rc, nil)
}

// extractWebpkg POST /api/v1/files/:id/webpkg/extract：手动（重）解包。
// 权限同「覆盖为新版本」目标校验（个人 owner / 团队 CanWrite）；
// 重复执行幂等重建（先删旧 key 再解包，public_id 保持稳定）。
// 安全校验未通过时返回 200 + status=blocked（附原因，供 owner 排障）。
func (h *Handler) extractWebpkg(c *gin.Context) {
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	if _, err := h.files.ValidateReplaceTarget(userID(c), id); err != nil {
		h.fileError(c, err)
		return
	}
	pkg, err := h.webpkg.ExtractForFile(id)
	if err != nil && pkg.Status != webpkg.StatusBlocked {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "web package extraction failed"})
		return
	}
	c.JSON(http.StatusOK, webpkgJSON(pkg))
}

func webpkgJSON(p webpkg.Package) gin.H {
	out := gin.H{
		"file_id":     p.FileID,
		"status":      p.Status,
		"entry_count": p.EntryCount,
		"total_size":  p.TotalSize,
		"created_at":  p.CreatedAt,
		"updated_at":  p.UpdatedAt,
	}
	if p.Status == webpkg.StatusReady {
		out["public_id"] = p.PublicID
	}
	if p.Error != nil {
		out["error"] = *p.Error
	}
	return out
}

// tryWebpkgPreview 预览联动：zip 候选文件存在 ready 解包包时改返 JSON 指引
// （kind=webpkg，前端以 sandbox iframe 加载 /content/<pid>/index.html），
// 返回 true 表示已写出响应。无 ready 包时回退原预览路径（zip 最终 415）。
func (h *Handler) tryWebpkgPreview(c *gin.Context, f files.File, blob files.ObjectBlob, incrementView func() error) bool {
	if h.webpkg == nil || !webpkg.ZipCandidate(blob.MimeType, f.Name) {
		return false
	}
	pid, ok := h.webpkg.ReadyPackage(f.ID)
	if !ok {
		return false
	}
	if incrementView != nil {
		if err := incrementView(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to record preview"})
			return true
		}
	}
	// same_origin：平台设置 content.allow_same_origin 热读取——前端 iframe
	// 的 sandbox 属性须据此同步加 allow-same-origin，否则 iframe 沙箱与 CSP
	// 沙箱取交集，后端 CSP 单方面放行 localStorage 不生效。
	c.JSON(http.StatusOK, gin.H{"kind": "webpkg", "url": "/content/" + pid + "/index.html", "same_origin": h.contentAllowSameOrigin()})
	return true
}
