// SDK 适配层（K6 迁移）：把 DocDyne 的 Tool 定义挂到官方 MCP Go SDK
// （github.com/modelcontextprotocol/go-sdk/mcp）的 Server 上——协议分发、
// JSON-RPC 信封、Streamable HTTP 传输（stateless + JSONResponse）全部由
// SDK 承接；DocDyne 侧只保留 scope 门控、能力可用性标注与 handler 结果
// 到 text content 的转换。
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// identityKey 为请求上下文中的 MCP 调用方身份键。
type identityKey struct{}

// WithIdentity 把调用方身份挂到请求上下文（HTTP 层 Bearer 鉴权后、进入
// SDK 传输前注入；SDK 将 http.Request.Context() 传播进工具 handler）。
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, id)
}

// IdentityFromContext 取调用方身份；缺失返回零值（后续服务层按未授权
// 拒绝，不会静默放行）。
func IdentityFromContext(ctx context.Context) Identity {
	if id, ok := ctx.Value(identityKey{}).(Identity); ok {
		return id
	}
	return Identity{}
}

// allServerTools 汇总全部工具定义（dd_ 文件工具 + AI 工具 + 会话工具）。
func allServerTools(deps *Deps) []Tool {
	return append(append(allTools(), aiTools()...), conversationTools(deps.Convos)...)
}

// NewSDKServer 构造官方 SDK Server 并注册全部工具：不可用工具描述尾部
// 追加「（当前部署未启用）」（与迁移前 tools/list 行为一致）。
func NewSDKServer(deps *Deps) *mcpsdk.Server {
	if deps == nil {
		deps = &Deps{}
	}
	s := mcpsdk.NewServer(&mcpsdk.Implementation{Name: ServerName, Version: ServerVersion}, &mcpsdk.ServerOptions{
		Instructions: serverInstructions,
	})
	for _, t := range allServerTools(deps) {
		tool := t
		desc := tool.Description
		if tool.Available != nil && !tool.Available(deps) {
			desc += "（当前部署未启用）"
		}
		// 低层 AddTool：raw schema + raw arguments——入参校验保持各工具
		// handler 内的既有逻辑（badArgs），不被 SDK 的 schema 校验接管。
		s.AddTool(&mcpsdk.Tool{
			Name:        tool.Name,
			Description: desc,
			InputSchema: tool.InputSchema,
		}, adaptTool(deps, tool))
	}
	return s
}

// adaptTool 把 DocDyne Tool 适配为 SDK ToolHandler：scope 门控 → 可用性
// 门控 → 调用既有 handler → 结果转 text content。错误统一按 MCP 规范以
// isError 工具结果返回（agent 可读原因并自行调整策略）；K6 迁移把
// scope 不足与入参非法从协议级错误码（-32003/-32602）改为 isError——
// 与 SDK 官方 AddTool 包装层的错误约定一致（docs/mcp.md 已同步）。
func adaptTool(deps *Deps, tool Tool) func(context.Context, *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
	return func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
		identity := IdentityFromContext(ctx)
		if !identity.Allows(tool.Scope) {
			var res mcpsdk.CallToolResult
			res.SetError(fmt.Errorf("missing scope: %s (this PAT is not authorized for it; ask the owner to grant the scope or use an unscoped token)", tool.Scope))
			return &res, nil
		}
		if tool.Available != nil && !tool.Available(deps) {
			var res mcpsdk.CallToolResult
			res.SetError(errToolUnavailable)
			return &res, nil
		}
		args := req.Params.Arguments
		if len(args) == 0 {
			args = json.RawMessage("{}")
		}
		result, err := tool.Handler(ctx, deps, identity, args)
		if err != nil {
			var res mcpsdk.CallToolResult
			res.SetError(fmt.Errorf("%s", errorMessage(tool.Name, err)))
			return &res, nil
		}
		data, merr := json.MarshalIndent(result, "", "  ")
		if merr != nil {
			return nil, fmt.Errorf("result encoding failed: %w", merr)
		}
		return &mcpsdk.CallToolResult{
			Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: string(data)}},
		}, nil
	}
}

// ServerCache 按「能力可用性快照」缓存官方 SDK Server：AI 开关运行时可
// 切换（管理端启停 Provider），StreamableHTTPHandler 的 getServer 每请求
// 回调（stateless 模式逐请求建临时会话）时按快照变化重建——tools/list
// 描述中的「当前部署未启用」标注随之时效正确。
type ServerCache struct {
	deps *Deps

	mu     sync.Mutex
	cached *mcpsdk.Server
	sig    string
}

// NewServerCache 构造缓存（deps 须已完成装配；之后 deps 引用只读）。
func NewServerCache(deps *Deps) *ServerCache {
	return &ServerCache{deps: deps}
}

// Server 返回当前可用的 SDK Server（快照未变时复用；变化时重建）。
// SDK Server 无会话状态可失效（stateless 逐请求临时会话），重建安全。
func (c *ServerCache) Server() *mcpsdk.Server {
	sig := c.availabilitySig()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cached != nil && c.sig == sig {
		return c.cached
	}
	c.cached = NewSDKServer(c.deps)
	c.sig = sig
	return c.cached
}

// availabilitySig 汇总各条件可用工具的当前判定，作为重建依据。
func (c *ServerCache) availabilitySig() string {
	var b strings.Builder
	for _, t := range allServerTools(c.deps) {
		if t.Available != nil {
			fmt.Fprintf(&b, "%s=%v;", t.Name, t.Available(c.deps))
		}
	}
	return b.String()
}

// 编译期断言：SDK 传输 handler 满足 http.Handler（装配契约）。
var _ http.Handler = (*mcpsdk.StreamableHTTPHandler)(nil)
