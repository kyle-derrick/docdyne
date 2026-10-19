// ai_fetch_tool.go：dd_fetch_url 网页抓取工具执行器（联网搜索配套——
// 模型在搜索结果中选定链接后补读全文）。
//
// 安全边界（SSRF 防护，服务端工具直面公网输入的必备项）：
//   - 仅绝对 http(s) URL（≤500 字符），非 http(s) scheme 一律拒绝；
//   - 域名解析后逐 IP 校验：环回/私有段/链路本地/未指定地址拒绝（配合
//     代理时同样执行——代理是运维自配的受信出口，公网目标判定不变）；
//   - Content-Type 白名单（html/plain/json/markdown/xml/csv），二进制拒绝；
//   - 响应体 ≤2MB，正文截断 max_chars（默认 8000，上限 20000）。
package http

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/kyle-derrick/docdyne/internal/ai"
)

// fetch 工具边界常量。
const (
	// fetchURLMaxRunes url 长度上限（同 MCP url 边界）。
	fetchURLMaxRunes = 500
	// fetchTimeout 单次抓取超时。
	fetchTimeout = 10 * time.Second
	// fetchMaxBodyBytes 响应体读取上限（2MB）。
	fetchMaxBodyBytes = 2 << 20
	// fetchMaxCharsDefault 返回正文默认字符上限。
	fetchMaxCharsDefault = 8000
	// fetchMaxCharsLimit 返回正文字符上限硬顶。
	fetchMaxCharsLimit = 20000
)

// fetchAllowedContentTypes 正文白名单（前缀匹配 charset 参数）。
var fetchAllowedContentTypes = []string{
	"text/html", "text/plain", "application/json", "text/markdown",
	"application/xml", "text/xml", "text/csv", "application/yaml", "text/yaml",
}

// toolFetchURL 执行 dd_fetch_url：抓取网页并返回正文文本。出站代理取
// 生效搜索配置（ai.search.proxy_url > env AI_OUTBOUND_PROXY）。
func (p *platformToolCtx) toolFetchURL(rawURL string, maxChars int) (any, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return nil, fmt.Errorf("url 为必填参数")
	}
	if len([]rune(rawURL)) > fetchURLMaxRunes {
		return nil, fmt.Errorf("url 过长（≤%d 字符）", fetchURLMaxRunes)
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("url 须为绝对 http(s) 地址")
	}
	if err := fetchGuard(u); err != nil {
		return nil, err
	}
	if maxChars <= 0 {
		maxChars = fetchMaxCharsDefault
	}
	if maxChars > fetchMaxCharsLimit {
		maxChars = fetchMaxCharsLimit
	}
	proxy := ""
	if cfg, ok := p.h.aiSearchConfig(); ok {
		proxy = cfg.ProxyURL
	}
	client := &http.Client{Timeout: fetchTimeout}
	if p := strings.TrimSpace(proxy); p != "" {
		if pu, perr := url.Parse(p); perr == nil && pu.Host != "" {
			t := http.DefaultTransport.(*http.Transport).Clone()
			t.Proxy = http.ProxyURL(pu)
			client = &http.Client{Timeout: fetchTimeout, Transport: t}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.5")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("抓取失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("目标返回 HTTP %d", resp.StatusCode)
	}
	ctype := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Type")))
	if i := strings.IndexByte(ctype, ';'); i >= 0 {
		ctype = strings.TrimSpace(ctype[:i])
	}
	allowed := false
	for _, ct := range fetchAllowedContentTypes {
		if ctype == ct {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, fmt.Errorf("不支持的内容类型 %q（仅文本类页面/JSON/Markdown/XML/CSV）", ctype)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, fetchMaxBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("读取响应失败：%v", err)
	}
	content := string(body)
	if ctype == "text/html" || strings.HasSuffix(ctype, "+html") {
		if text, terr := ai.HTMLToText(strings.NewReader(content)); terr == nil {
			content = text
		} else {
			return nil, fmt.Errorf("HTML 解析失败：%v", terr)
		}
	}
	runes := []rune(content)
	truncated := len(runes) > maxChars
	if truncated {
		content = string(runes[:maxChars])
	}
	return gin.H{
		"url": rawURL, "content_type": ctype, "content": content, "truncated": truncated,
	}, nil
}

// fetchGuard 为 SSRF 守卫的可测试性注入点（生产恒为 fetchSSRFGuard；
// 测试替换以放行 httptest 的 127.0.0.1 目标——守卫本体另行直测）。
var fetchGuard = fetchSSRFGuard

// fetchSSRFGuard 校验目标主机不指向内网/本机：解析全部 A/AAAA 记录，
// 任一命中环回/私有/链路本地/未指定地址即拒绝（域名解析在服务端执行；
// 配置了出站代理时同样执行——判定目标是「不该被服务端访问的地址」，
// 与流量实际走向无关）。
func fetchSSRFGuard(u *url.URL) error {
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("url 缺少主机名")
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("域名解析失败：%v", err)
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			return fmt.Errorf("目标地址 %s 指向内网/本机，禁止抓取", ip)
		}
	}
	return nil
}
