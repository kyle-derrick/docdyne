package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"

	"github.com/docflow/docflow/internal/files"
	"github.com/docflow/docflow/internal/search"
	"github.com/docflow/docflow/internal/share"
	"github.com/docflow/docflow/internal/space"
	"github.com/docflow/docflow/internal/upload"
)

// ServerName / ServerVersion 为 serverInfo 字段取值（SDK Implementation）。
const (
	ServerName    = "docflow"
	ServerVersion = "1.0.0"
)

// Identity 为一次 MCP 请求的调用方身份（HTTP 层从 Bearer 凭证解析后经
// WithIdentity 注入请求上下文，SDK 会把 http.Request.Context() 传播进
// 工具 handler，见 streamable.go 的 connectStreamable 注释）。
type Identity struct {
	UserID uuid.UUID
	// IsPAT 表示凭证为 PAT（dfpat_）；JWT access token 不受 scope 限制。
	IsPAT bool
	// Scopes 为 PAT 授权 scope 列表；nil 表示不受限（JWT 或未限定 scope
	// 的 PAT），与 auth.RequireScope 的判定语义一致。
	Scopes []string
}

// Allows 判定身份是否具备 scope（files:read / files:write）：
// 非 PAT 或未限定 scope 的 PAT 不受限；限定 scope 的 PAT 逐项精确匹配。
func (id Identity) Allows(scope string) bool {
	if !id.IsPAT || id.Scopes == nil {
		return true
	}
	for _, s := range id.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

// PAT scope 常量（沿用 auth.AllowedPATScopes 的取值）。
const (
	ScopeFilesRead  = "files:read"
	ScopeFilesWrite = "files:write"
)

// FileStore 抽象 MCP 文件工具所需的文件服务能力（生产实现 *files.Store；
// 接口化便于单测注入内存实现，模式同 http 包 resolver/unpacker）。
// 全部方法自带用户级授权（authorizeFile* / 空间 ACL），MCP 层不做旁路。
type FileStore interface {
	// DefaultSpaceRoot 返回用户默认空间根目录（缺省空间入口）。
	DefaultSpaceRoot(user uuid.UUID) (files.File, error)
	ListSpace(spaceID, parent uuid.UUID, limit int, sort files.SpaceListFilter) ([]files.File, error)
	Get(user, id uuid.UUID) (files.File, error)
	CreateFolderIn(user, parent uuid.UUID, name string) (files.File, error)
	Rename(user, id uuid.UUID, name string) (files.File, error)
	Copy(user, id, parent uuid.UUID, name string) (files.File, error)
	Delete(user, id uuid.UUID) error
	Restore(user, id uuid.UUID) (files.File, error)
	ListTrashSpace(user, spaceID uuid.UUID, limit int) ([]files.File, error)
	ListVersions(user, fileID uuid.UUID) ([]files.VersionDetail, error)
	SetCurrentVersion(user, fileID, versionID uuid.UUID) (files.File, files.FileVersion, error)
	ReadVersion(user, fileID, versionID uuid.UUID) (files.File, files.FileVersion, files.ObjectBlob, error)
	CurrentVersion(owner, fileID uuid.UUID) (files.FileVersion, files.ObjectBlob, error)
	ResolveReadablePath(actor uuid.UUID, nsType string, scopeID uuid.UUID, path string) (files.File, []files.File, error)
	SpaceRoot(spaceID uuid.UUID) (files.File, error)
	GetSpaceFolder(spaceID, id uuid.UUID) (files.File, error)
	BatchMove(user uuid.UUID, ids []uuid.UUID, target uuid.UUID) ([]files.BatchItemResult, error)
}

// UploadService 抽象上传管线能力（生产实现 *upload.Service）：写入一律走
// UploadBytes / StartReplace+Append+Complete 管线（office 校验、病毒扫描、
// 配额、扩展名黑名单、版本与作用域均生效），MCP 层不旁路。
type UploadService interface {
	UploadBytes(user, parent uuid.UUID, name string, data []byte) (upload.UploadSession, error)
	StartReplace(user, target uuid.UUID, size int64, expected string) (upload.UploadSession, error)
	Append(id uuid.UUID, offset int64, r io.Reader) (upload.UploadSession, error)
	Complete(id uuid.UUID) (upload.UploadSession, error)
}

// ShareService 抽象分享能力（生产实现 *share.Service）。
type ShareService interface {
	ListWithFileNames(owner uuid.UUID, limit int) ([]share.ShareWithFile, error)
	CreatePublic(owner, fileID uuid.UUID, permission string, expiresIn time.Duration, maxDownloads *int, opts share.ShareOptions) (share.Share, string, error)
	CreatePrivateWithOptions(owner, fileID uuid.UUID, permission string, expiresIn time.Duration, maxDownloads *int, userIds, spaceIds []uuid.UUID, opts share.ShareOptions) (share.Share, error)
	Revoke(owner, shareID uuid.UUID) (share.Share, error)
}

// SpaceService 抽象空间能力（生产实现 *space.Service）。
type SpaceService interface {
	ListSpaces(user uuid.UUID) ([]space.Space, error)
	CanRead(userID, spaceID uuid.UUID) (bool, error)
	DefaultSpace(owner uuid.UUID) (space.Space, error)
}

// SearchService 抽象全文检索能力（生产实现 *search.Store；未启用时注入
// nil，对应工具在 tools/list 中标注且调用返回结构化错误）。
type SearchService interface {
	Query(user uuid.UUID, opts search.QueryOptions) ([]search.Result, error)
}

// Deps 为 MCP 工具的服务依赖集合；nil 的能力对应工具不可用（不注册旁路）。
type Deps struct {
	Files   FileStore
	Uploads UploadService
	Storage upload.Storage
	Shares  ShareService
	Spaces  SpaceService
	Search  SearchService
	// AI 为 AI 能力（ask_docs/summarize_file/ai_chat；AI 能力第一版）。
	AI AIAssistant
	// Convos 为 AI 会话存取（df_list/get/append_conversation；nil 不注册）。
	Convos ConvoStore
}

// Tool 为一个 MCP 工具定义：inputSchema 手写 JSON Schema（低层
// Server.AddTool 直接消费 raw schema，SDK 不做入参校验——校验仍在各
// 工具 handler 内，与迁移前一致）；Scope 为所需 PAT scope
// （files:read / files:write，JWT 不受限）；Available 返回 false 时该部署
// 未启用对应能力（tools/list 描述中标注，调用返回结构化错误），nil 表示
// 恒可用。
type Tool struct {
	Name        string
	Description string
	Scope       string
	InputSchema map[string]any
	Available   func(deps *Deps) bool
	Handler     func(ctx context.Context, deps *Deps, id Identity, args json.RawMessage) (any, error)
}

// argsError 表示工具入参非法（转 isError 工具结果，agent 可读）。
type argsError struct{ message string }

func (e *argsError) Error() string { return e.message }

// badArgs 构造入参错误（工具 handler 使用）。
func badArgs(format string, a ...any) error {
	return &argsError{message: fmt.Sprintf(format, a...)}
}

// errToolUnavailable 为能力未注入的哨兵（分发层转为结构化工具错误）。
var errToolUnavailable = errors.New("capability not available on this deployment")

// serverInstructions 为 initialize 应答的 instructions 字段（SDK
// ServerOptions.Instructions）。
const serverInstructions = "DocFlow 文档中台 MCP 服务端（统一空间模型）。工具均以 df_ 前缀命名；" +
	"文件操作按空间定位：space_id 缺省为你的默认空间，df_list_spaces 可列出全部可见空间。" +
	"写入走上传管线（office 校验/扫描/配额生效）；文本类（md/txt/xml/json/excalidraw 等）" +
	"可用 df_read_file 直读、df_write_version 覆盖编辑；drawio 的 .drawio 文件即 XML，" +
	"excalidraw 的 .excalidraw 即 JSON，均可按文本直接读写。"
