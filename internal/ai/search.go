// Package ai —— search.go：联网搜索增强（chat 的 web_search 参数）。
//
// 成熟方案接入（不自研爬虫）：SearXNG（自托管元搜索引擎，JSON API）、
// Tavily（搜索 API）与内置免 Key 引擎 DuckDuckGo / Bing（非官方 HTML
// 页面解析——免 Key 但可能随页面改版失效；DDG 国内直连通常不可达，可经
// ai.search.proxy_url 出站代理）四种实现，经 settings 的 ai.search.* 键
// 热配置。搜索失败静默降级（不阻断对话，HTTP 层经 SSE meta 的
// search_failed 标注）；查询取对话中最后一条用户消息（截 400 字），结果
// 以「[n] 标题 + 链接 + 摘要」system 上下文块注入消息头部。
package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/kyle-derrick/docdyne/internal/settings"
)

// WebSearchTimeout 单次搜索请求超时（超时/网络错误静默降级）。
const WebSearchTimeout = 8 * time.Second

// WebSearchQueryMaxRunes 搜索查询长度上限（runes，取最后一条用户消息）。
const WebSearchQueryMaxRunes = 400

// WebSearchSnippetMaxRunes 单条结果摘要截断上限（runes）。
const WebSearchSnippetMaxRunes = 500

// TavilyBaseURL Tavily 搜索 API 基地址（测试可注入 httptest 地址覆盖）。
const TavilyBaseURL = "https://api.tavily.com"

// DuckDuckGoBaseURL DuckDuckGo HTML 端点基址（POST /html/，免 Key；
// 测试可注入 httptest 地址覆盖）。
const DuckDuckGoBaseURL = "https://html.duckduckgo.com"

// BingBaseURL Bing 搜索页基址（GET /search，免 Key、国内可直连；
// 测试可注入 httptest 地址覆盖）。
const BingBaseURL = "https://www.bing.com"

// webBrowserUA 内置引擎必备的浏览器 UA（DDG/Bing 对默认 Go UA 返回
// 验证页/403，属站点反爬基线而非伪装规避）。
const webBrowserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// outboundProxyClient 构造出站 HTTP 客户端：proxyURL 非空时走代理
// （克隆默认 Transport 保留连接池/超时基线，仅覆盖 Proxy）；空 = 直连
// 超时客户端（与既有 searcher 缺省一致）。
func outboundProxyClient(proxyURL string) *http.Client {
	if p := strings.TrimSpace(proxyURL); p != "" {
		if u, err := url.Parse(p); err == nil && u.Host != "" {
			t := http.DefaultTransport.(*http.Transport).Clone()
			t.Proxy = http.ProxyURL(u)
			return &http.Client{Timeout: WebSearchTimeout, Transport: t}
		}
	}
	return &http.Client{Timeout: WebSearchTimeout}
}

// WebSearchResult 为一条网络搜索结果（Content 为截断后的摘要）。
type WebSearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Content string `json:"content,omitempty"`
}

// WebSearcher 抽象联网搜索（生产实现 SearxngSearcher / TavilySearcher；
// 命名区别于 rag.go 的 Searcher——那是站内文档检索）。
type WebSearcher interface {
	Search(ctx context.Context, query string, maxResults int) ([]WebSearchResult, error)
}

// ---------- SearXNG ----------

// SearxngSearcher 为 SearXNG JSON API 实现（GET {base}/search?q=&format=json）。
type SearxngSearcher struct {
	BaseURL  string
	Client   *http.Client
	ProxyURL string // 出站代理（可选；Client 注入时忽略）
}

type searxngResponse struct {
	Results []struct {
		Title   string `json:"title"`
		URL     string `json:"url"`
		Content string `json:"content"`
	} `json:"results"`
}

func (s *SearxngSearcher) Search(ctx context.Context, query string, maxResults int) ([]WebSearchResult, error) {
	if maxResults <= 0 {
		maxResults = settings.AISearchMaxResultsDefault
	}
	q := url.Values{}
	q.Set("q", query)
	q.Set("format", "json")
	q.Set("language", "zh")
	endpoint := strings.TrimSuffix(s.BaseURL, "/") + "/search?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	client := s.Client
	if client == nil {
		client = outboundProxyClient(s.ProxyURL)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("searxng status %d: %s", resp.StatusCode, truncateBytes(raw, 200))
	}
	var out searxngResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return nil, err
	}
	results := make([]WebSearchResult, 0, len(out.Results))
	for _, r := range out.Results {
		if strings.TrimSpace(r.URL) == "" {
			continue
		}
		results = append(results, WebSearchResult{Title: r.Title, URL: r.URL, Content: clipRunes(r.Content, WebSearchSnippetMaxRunes)})
		if len(results) >= maxResults {
			break
		}
	}
	return results, nil
}

// ---------- Tavily ----------

// TavilySearcher 为 Tavily 搜索 API 实现（POST {base}/search）。
type TavilySearcher struct {
	BaseURL  string
	APIKey   string
	Client   *http.Client
	ProxyURL string // 出站代理（可选；Client 注入时忽略）
}

type tavilyResponse struct {
	Results []struct {
		Title   string `json:"title"`
		URL     string `json:"url"`
		Content string `json:"content"`
	} `json:"results"`
}

func (s *TavilySearcher) Search(ctx context.Context, query string, maxResults int) ([]WebSearchResult, error) {
	if maxResults <= 0 {
		maxResults = settings.AISearchMaxResultsDefault
	}
	base := s.BaseURL
	if base == "" {
		base = TavilyBaseURL
	}
	body, err := json.Marshal(map[string]any{
		"api_key":     s.APIKey,
		"query":       query,
		"max_results": maxResults,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/search", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := s.Client
	if client == nil {
		client = outboundProxyClient(s.ProxyURL)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("tavily status %d: %s", resp.StatusCode, truncateBytes(raw, 200))
	}
	var out tavilyResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return nil, err
	}
	results := make([]WebSearchResult, 0, len(out.Results))
	for _, r := range out.Results {
		if strings.TrimSpace(r.URL) == "" {
			continue
		}
		results = append(results, WebSearchResult{Title: r.Title, URL: r.URL, Content: clipRunes(r.Content, WebSearchSnippetMaxRunes)})
	}
	return results, nil
}

// ---------- 内置免 Key 引擎（DuckDuckGo / Bing，HTML 页面解析） ----------

// DuckDuckGoSearcher 为 DuckDuckGo HTML 端点实现（POST {base}/html/，
// form q=，免 Key）。Cherry Studio 同款内置免费引擎；解析 result__a /
// result__snippet 锚点，跳转链接经 uddg 参数解包，广告行（y.js）跳过。
type DuckDuckGoSearcher struct {
	BaseURL  string
	Client   *http.Client
	ProxyURL string
}

func (s *DuckDuckGoSearcher) Search(ctx context.Context, query string, maxResults int) ([]WebSearchResult, error) {
	if maxResults <= 0 {
		maxResults = settings.AISearchMaxResultsDefault
	}
	base := s.BaseURL
	if base == "" {
		base = DuckDuckGoBaseURL
	}
	form := url.Values{}
	form.Set("q", query)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/html/", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", webBrowserUA)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.5")
	client := s.Client
	if client == nil {
		client = outboundProxyClient(s.ProxyURL)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("duckduckgo status %d: %s", resp.StatusCode, truncateBytes(raw, 200))
	}
	return parseDuckDuckGoHTML(resp.Body, maxResults)
}

// parseDuckDuckGoHTML 解析 DDG HTML 结果页：文档序遍历锚点——
// result__a 开新条目（标题 + uddg 解包链接），result__snippet 补摘要；
// 广告（href 含 y.js）与非 http 结果跳过。
func parseDuckDuckGoHTML(r io.Reader, maxResults int) ([]WebSearchResult, error) {
	doc, err := html.Parse(r)
	if err != nil {
		return nil, err
	}
	results := make([]WebSearchResult, 0, maxResults)
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if len(results) >= maxResults {
			return
		}
		if n.Type == html.ElementNode && n.Data == "a" {
			classes := nodeClasses(n)
			switch {
			case classes["result__a"]:
				href := attrValue(n, "href")
				if !strings.Contains(href, "y.js") { // y.js = 广告跳转
					if u := unwrapDDGHref(href); u != "" {
						results = append(results, WebSearchResult{Title: strings.TrimSpace(nodeText(n)), URL: u})
					}
				}
			case classes["result__snippet"]:
				if len(results) > 0 {
					last := &results[len(results)-1]
					if last.Content == "" {
						last.Content = clipRunes(strings.TrimSpace(nodeText(n)), WebSearchSnippetMaxRunes)
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return results, nil
}

// unwrapDDGHref 解包 DDG 跳转链接（//duckduckgo.com/l/?uddg=<urlenc> →
// 原始 URL）；非 uddg 形态且为绝对 http(s) 时原样返回。
func unwrapDDGHref(href string) string {
	if !strings.Contains(href, "uddg=") {
		if u, err := url.Parse(href); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
			return href
		}
		return ""
	}
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	target := u.Query().Get("uddg")
	if target == "" {
		return ""
	}
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return ""
	}
	return target
}

// HTMLToText 解析 HTML 文档并抽取纯文本（script/style 剔除，文本节点
// 折叠为单空格连接）——dd_fetch_url 抓取网页正文用（导出供 HTTP 层复用）。
func HTMLToText(r io.Reader) (string, error) {
	doc, err := html.Parse(r)
	if err != nil {
		return "", err
	}
	return nodeText(doc), nil
}

// BingSearcher 为 Bing 搜索页实现（GET {base}/search?q=&mkt=zh-CN，
// 免 Key、国内可直连）。解析 li.b_algo 块的 h2>a 与摘要段落；Bing 站内
// 链接跳过。非官方接口：页面改版可能失效（失败走既有静默降级）。
type BingSearcher struct {
	BaseURL  string
	Client   *http.Client
	ProxyURL string
}

func (s *BingSearcher) Search(ctx context.Context, query string, maxResults int) ([]WebSearchResult, error) {
	if maxResults <= 0 {
		maxResults = settings.AISearchMaxResultsDefault
	}
	base := s.BaseURL
	if base == "" {
		base = BingBaseURL
	}
	q := url.Values{}
	q.Set("q", query)
	q.Set("mkt", "zh-CN")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(base, "/")+"/search?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", webBrowserUA)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.5")
	client := s.Client
	if client == nil {
		client = outboundProxyClient(s.ProxyURL)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("bing status %d: %s", resp.StatusCode, truncateBytes(raw, 200))
	}
	return parseBingHTML(resp.Body, maxResults)
}

// parseBingHTML 解析 Bing 结果页：li.b_algo 块内首个 h2 下锚点为标题与
// 链接、其后首个 p 为摘要；bing.com/microsoft 站内链接跳过。
func parseBingHTML(r io.Reader, maxResults int) ([]WebSearchResult, error) {
	doc, err := html.Parse(r)
	if err != nil {
		return nil, err
	}
	results := make([]WebSearchResult, 0, maxResults)
	var walkBlocks func(n *html.Node)
	walkBlocks = func(n *html.Node) {
		if len(results) >= maxResults {
			return
		}
		if n.Type == html.ElementNode && n.Data == "li" && nodeClasses(n)["b_algo"] {
			if r, ok := extractBingBlock(n); ok {
				results = append(results, r)
			}
			return // b_algo 子树不再递归（避免嵌套误取）
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walkBlocks(c)
		}
	}
	walkBlocks(doc)
	return results, nil
}

// extractBingBlock 从单个 b_algo 块提取标题链接与摘要。
func extractBingBlock(li *html.Node) (WebSearchResult, bool) {
	out := WebSearchResult{}
	foundLink := false
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "h2":
				if !foundLink {
					if a := firstAnchorIn(n); a != nil {
						href := attrValue(a, "href")
						if u, err := url.Parse(href); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" &&
							!strings.HasSuffix(u.Hostname(), "bing.com") && !strings.HasSuffix(u.Hostname(), "microsoft.com") {
							out.Title = strings.TrimSpace(nodeText(a))
							out.URL = href
							foundLink = true
						}
					}
				}
			case "p":
				if out.Content == "" {
					out.Content = clipRunes(strings.TrimSpace(nodeText(n)), WebSearchSnippetMaxRunes)
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(li)
	if !foundLink || strings.TrimSpace(out.Title) == "" {
		return WebSearchResult{}, false
	}
	return out, true
}

// firstAnchorIn 返回子树内第一个 <a> 元素。
func firstAnchorIn(n *html.Node) *html.Node {
	var found *html.Node
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if found != nil {
			return
		}
		if n.Type == html.ElementNode && n.Data == "a" {
			found = n
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return found
}

// nodeClasses 把元素 class 属性按空白拆分为集合。
func nodeClasses(n *html.Node) map[string]bool {
	out := map[string]bool{}
	for _, a := range n.Attr {
		if a.Key == "class" {
			for _, c := range strings.Fields(a.Val) {
				out[c] = true
			}
		}
	}
	return out
}

// attrValue 取元素属性值（无则空串）。
func attrValue(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// nodeText 拼接子树全部文本节点（script/style 排除）。
func nodeText(n *html.Node) string {
	var b strings.Builder
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && (n.Data == "script" || n.Data == "style") {
			return
		}
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(strings.Fields(b.String()), " ")
}

// NewWebSearcher 按配置构造联网搜索实现（provider 空/未知 = nil = 禁用）。
// ProxyURL 为出站代理（各引擎统一；由 HTTP 层把 env AI_OUTBOUND_PROXY
// 兜底合并进 cfg.ProxyURL 后传入）。
func NewWebSearcher(cfg settings.AISearchConfig) WebSearcher {
	switch cfg.Provider {
	case settings.AISearchProviderSearxng:
		return &SearxngSearcher{BaseURL: cfg.SearxngURL, ProxyURL: cfg.ProxyURL}
	case settings.AISearchProviderTavily:
		return &TavilySearcher{APIKey: cfg.TavilyAPIKey, ProxyURL: cfg.ProxyURL}
	case settings.AISearchProviderDuckDuckGo:
		return &DuckDuckGoSearcher{ProxyURL: cfg.ProxyURL}
	case settings.AISearchProviderBing:
		return &BingSearcher{ProxyURL: cfg.ProxyURL}
	default:
		return nil
	}
}

// ---------- chat 集成（查询提取 / 上下文注入 / 静默降级） ----------

// LastUserQuery 返回对话中最后一条 user 消息（截 400 字；无则空串）——
// web_search 的搜索查询提取。
func LastUserQuery(messages []Message) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			q := strings.TrimSpace(messages[i].Content)
			if q == "" {
				return ""
			}
			return clipRunes(q, WebSearchQueryMaxRunes)
		}
	}
	return ""
}

// clipRunes 无尾注截断（区别于 summarize 的 truncateRunes——搜索查询与
// 摘要片段不应带「内容过长」尾注）。
func clipRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

// webSearchIntro 网络搜索上下文块的导语（可信指令，置于围栏外）。
const webSearchIntro = "以下是网络搜索结果，供参考。回答时可引用编号 [n] 与对应链接；搜索结果可能过时或不准确，请结合问题自行判断。"

// BuildWebSearchContext 把搜索结果拼为 system 上下文块（[n] 标题 + 链接 +
// 摘要），供注入消息头部。外部网页内容为最高风险的不可信数据源——
// 结果条目整体经 UntrustedBlock 围栏隔离（J2 提示注入防护）。
func BuildWebSearchContext(results []WebSearchResult) string {
	var b strings.Builder
	for i, r := range results {
		fmt.Fprintf(&b, "\n[%d] %s\n%s\n", i+1, r.Title, r.URL)
		if snippet := strings.TrimSpace(r.Content); snippet != "" {
			b.WriteString("摘要：" + snippet + "\n")
		}
	}
	return webSearchIntro + "\n" + UntrustedBlock("网络搜索结果", b.String())
}

// ApplyWebSearch 执行联网搜索并注入上下文：查询取 messages 中最后一条
// user 消息（截 400 字；query 非空时优先，RAG 模式由 HTTP 层传检索 query）。
//   - cfg.Provider 为空（未配置/禁用）或无可用查询：静默跳过（原样返回）；
//   - 搜索失败（超时/网络/非 2xx）：failed=true，不注入、不报错（对话继续）；
//   - 成功：上下文块注入消息头部（并入既有 system 或新建首条 system）。
func (s *Service) ApplyWebSearch(ctx context.Context, cfg settings.AISearchConfig, query string, messages []Message) ([]Message, []WebSearchResult, bool) {
	searcher := NewWebSearcher(cfg)
	if searcher == nil || strings.TrimSpace(query) == "" {
		return messages, nil, false
	}
	sctx, cancel := context.WithTimeout(ctx, WebSearchTimeout)
	defer cancel()
	results, err := searcher.Search(sctx, query, cfg.MaxResults)
	if err != nil {
		return messages, nil, true // 搜索失败：静默降级（不阻断对话）
	}
	if len(results) == 0 {
		return messages, nil, false
	}
	return prependSystemMessage(messages, BuildWebSearchContext(results)), results, false
}

// prependSystemMessage 把上下文块并入首条 system 消息（无则新建于头部）。
func prependSystemMessage(messages []Message, block string) []Message {
	for i := range messages {
		if messages[i].Role == "system" {
			messages[i].Content += "\n\n" + block
			return messages
		}
	}
	out := make([]Message, 0, len(messages)+1)
	out = append(out, Message{Role: "system", Content: block})
	return append(out, messages...)
}
