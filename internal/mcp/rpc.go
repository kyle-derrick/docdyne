// Package mcp 实现 DocDyne 的 MCP（Model Context Protocol）服务端：
// 协议分发与 Streamable HTTP 传输由官方 SDK
// （github.com/modelcontextprotocol/go-sdk/mcp）承接（K6 迁移），DocDyne
// 只保留工具定义（tools.go 族）与服务依赖（Deps 接口）；调用方身份经
// 请求上下文注入（WithIdentity，HTTP 层 Bearer 鉴权后写入）。鉴权与权限
// 完全复用现有服务层（PAT ddpat_ 或用户 access token；PAT scope 沿用
// files:read / files:write 常量）。
package mcp

// CodeUnauthorized 认证失败（Bearer 凭证缺失或无效），HTTP 层 401。
// 其余 JSON-RPC 错误码由官方 SDK 传输层自行产生（语义破坏的请求在
// HTTP 层以 400 拒绝，未知工具为 -32602 envelope），DocDyne 不再自定义。
const CodeUnauthorized = -32001

// UnauthorizedResponse 返回认证失败的 JSON-RPC 应答体（-32001），供 HTTP
// 中间件在进入 SDK 传输前拒绝未认证请求（HTTP 401）。
func UnauthorizedResponse() []byte {
	return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"unauthorized: missing or invalid Bearer credential (ddpat_ PAT or access token)"}}`)
}
