package http

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/audit"
	"github.com/kyle-derrick/docdyne/internal/auth"
)

// 本文件实现管理端用户管理（C6，设计 6.2.1/9.1.1，仅 admin 组）：
//   GET  /api/v1/admin/users                      用户列表（q 前缀检索 + 分页）
//   PATCH /api/v1/admin/users/:id                  禁用/启用/改配额/改角色
//   POST /api/v1/admin/users/:id/reset-password    重置密码（撤销全部会话）
//
// 设计 DELETE /users/:id 以软禁用（status=disabled）替代：删除用户会级联
// 失效其名下文件/分享/会话等引用行，破坏审计与数据完整性；禁用立即撤销全部
// 会话并阻止登录，达到同等的「账号不可用」效果（取舍见设计 6.2.1）。

// adminUserMaxQuota 为管理端可设置的单用户配额上限（1 PiB）。
const adminUserMaxQuota int64 = 1 << 50

// adminUserJSON 序列化管理端用户视图（脱敏：不含 password_hash；全字段
// 含 status/quota/used/locked）。group_names 由列表端点按页聚合补齐。
func adminUserJSON(u auth.User) gin.H {
	return gin.H{
		"id": u.ID, "username": u.Username, "email": u.Email,
		"role": u.Role, "status": u.Status,
		"storage_quota":      u.StorageQuota,
		"storage_used":       u.StorageUsed,
		"failed_login_count": u.FailedLoginCount,
		"locked_until":       u.LockedUntil,
		"profile": gin.H{
			"nickname":   u.Nickname,
			"department": u.Department,
			"position":   u.Position,
			"phone":      u.Phone,
			"bio":        u.Bio,
			"language":   u.Language,
			"timezone":   u.Timezone,
		},
		"created_at": u.CreatedAt,
		"updated_at": u.UpdatedAt,
	}
}

// adminCreateUser POST /api/v1/admin/users {username, password, email?,
// nickname?, department?, role?}：管理员手动开户——无 SMTP/未配置邮件的
// 环境不依赖邮箱邀请流程。用户名（auth.ValidateUsername）与密码强度
// （auth.ValidatePasswordStrength）规则与邀请注册一致；email 可选，留空时
// 以 {username}@local.invalid 占位（RFC 保留域，不可能是真实邮箱，天然
// 唯一）；role ∈ user|admin（缺省 user）。创建后确保默认空间（失败仅记
// 日志不阻断，与邀请注册路径同语义——否则新用户进文件页因无默认空间
// 500）。用户名/邮箱占用返回 409。
func (h *Handler) adminCreateUser(c *gin.Context) {
	var req struct {
		Username   string  `json:"username"`
		Password   string  `json:"password"`
		Email      string  `json:"email"`
		Nickname   *string `json:"nickname"`
		Department *string `json:"department"`
		Role       string  `json:"role"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	username := strings.TrimSpace(req.Username)
	if err := auth.ValidateUsername(username); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := auth.ValidatePasswordStrength(req.Password); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	role := strings.TrimSpace(req.Role)
	if role == "" {
		role = "user"
	}
	if role != "user" && role != "admin" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role must be user or admin"})
		return
	}
	email := auth.NormalizeEmail(strings.TrimSpace(req.Email))
	if email == "" {
		// 占位邮箱：.invalid 为 RFC 2606 保留 TLD，不可能与真实邮箱冲突。
		email = auth.NormalizeEmail(username + "@local.invalid")
	} else if err := auth.ValidateEmail(email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to create user"})
		return
	}
	now := time.Now().UTC()
	user := auth.User{
		ID: uuid.New(), Username: username, Email: email, PasswordHash: hash,
		Status: auth.StatusActive, Role: role,
		Nickname: req.Nickname, Department: req.Department,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := h.users.CreateUser(user); err != nil {
		if errors.Is(err, auth.ErrUserExists) {
			c.JSON(http.StatusConflict, gin.H{"error": "username or email already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to create user"})
		return
	}
	if h.spaces != nil {
		if _, _, serr := h.spaces.EnsureDefaultSpace(user.ID, user.Username); serr != nil {
			log.Printf("[admin] ensure default space for %s: %v", user.ID, serr)
		}
	}
	// 回读落库后的完整记录（CreateUser 内部回填默认配额/语言等，值拷贝
	// 不回传调用方）；读失败回退入参视图（用户已创建，不因回读失败报错）。
	if stored, err := h.users.GetByID(user.ID); err == nil {
		user = stored
	}
	if h.audit != nil {
		actor := userID(c)
		metadata, _ := json.Marshal(map[string]string{"username": username, "email": email, "role": role})
		_ = h.audit.Record(audit.Entry{UserID: &actor, Action: "user.create", ResourceType: audit.ResourceUser, ResourceID: user.ID.String(), Status: audit.StatusSuccess, Metadata: string(metadata)})
	}
	c.JSON(http.StatusCreated, adminUserJSON(user))
}

func (h *Handler) adminGetUser(c *gin.Context) {
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	user, err := h.users.GetByID(id)
	if errors.Is(err, auth.ErrUserNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load user"})
		return
	}
	c.JSON(http.StatusOK, adminUserJSON(user))
}

func (h *Handler) adminDeleteUser(c *gin.Context) {
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	if id == userID(c) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot disable your own account"})
		return
	}
	if err := h.users.AdminUpdateUser(id, auth.AdminUserUpdate{Status: func() *string { v := auth.StatusDisabled; return &v }()}); err != nil {
		if errors.Is(err, auth.ErrUserNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to disable user"})
		return
	}
	_ = h.auth.RevokeAllSessions(id)
	c.Status(http.StatusNoContent)
}

func (h *Handler) adminListUsers(c *gin.Context) {
	limit := 50
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit"})
			return
		}
		if n < 200 {
			limit = n
		} else {
			limit = 200
		}
	}
	offset := 0
	if raw := c.Query("offset"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset"})
			return
		}
		offset = n
	}
	users, total, err := h.users.AdminListUsers(c.Query("q"), limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to list users"})
		return
	}
	items := make([]gin.H, 0, len(users))
	for _, u := range users {
		item := adminUserJSON(u)
		item["group_names"] = []string{}
		items = append(items, item)
	}
	// 按页聚合所属组名（group_names；组服务未注入或聚合失败时保持空列表，
	// 不阻塞用户列表）。
	if h.groups != nil && len(users) > 0 {
		ids := make([]uuid.UUID, 0, len(users))
		for _, u := range users {
			ids = append(ids, u.ID)
		}
		if names, err := h.groups.NamesForUsers(ids); err == nil {
			for i := range items {
				if list := names[users[i].ID]; len(list) > 0 {
					items[i]["group_names"] = list
				}
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"users": items, "total": total, "limit": limit, "offset": offset})
}

type adminUpdateUserRequest struct {
	Status       *string `json:"status"`
	StorageQuota *int64  `json:"storage_quota"`
	Role         *string `json:"role"`
	// Nickname 为展示昵称（C21a 档案字段）：空串清空（写侧归一 NULL）。
	Nickname *string `json:"nickname"`
}

// adminUpdateUser PATCH /api/v1/admin/users/:id {status?, storage_quota?, role?, nickname?}：
// status ∈ active|disabled（禁用立即撤销其全部会话；置 active 视为解锁）；
// storage_quota ∈ [1, 1PiB]；role ∈ user|admin；nickname ≤64 字符。
// admin 不可禁用自己（400）。成功写 user.update 审计（含变更字段）并返回
// 更新后的用户视图。
func (h *Handler) adminUpdateUser(c *gin.Context) {
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	var request adminUpdateUserRequest
	if c.ShouldBindJSON(&request) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if request.Status != nil && *request.Status != auth.StatusActive && *request.Status != auth.StatusDisabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "status must be active or disabled"})
		return
	}
	if request.Role != nil && *request.Role != auth.RoleUser && *request.Role != auth.RoleAdmin {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role must be user or admin"})
		return
	}
	if request.StorageQuota != nil && (*request.StorageQuota < 1 || *request.StorageQuota > adminUserMaxQuota) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "storage_quota must be 1 byte to 1 PiB"})
		return
	}
	actor := userID(c)
	if request.Status != nil && *request.Status == auth.StatusDisabled && id == actor {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot disable your own account"})
		return
	}
	// 昵称走档案更新链路（ProfileUpdate 校验 + 写侧空串归一 NULL）。
	if request.Nickname != nil {
		update := auth.ProfileUpdate{Nickname: request.Nickname}
		if err := update.Validate(); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := h.users.UpdateProfile(id, update); err != nil {
			if errors.Is(err, auth.ErrUserNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to update user"})
			return
		}
	}
	if err := h.users.AdminUpdateUser(id, auth.AdminUserUpdate{
		Status:       request.Status,
		StorageQuota: request.StorageQuota,
		Role:         request.Role,
	}); err != nil {
		if errors.Is(err, auth.ErrUserNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to update user"})
		return
	}
	// 禁用立即撤销其全部会话（设计 6.2.1）：已在册的 refresh token 全部失效。
	if request.Status != nil && *request.Status == auth.StatusDisabled {
		if err := h.auth.RevokeAllSessions(id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "user updated but session revocation failed"})
			return
		}
	}
	user, err := h.users.GetByID(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to load user"})
		return
	}
	// 审计：仅记录本次变更的字段（不回显未变更值）。
	var meta []string
	if request.Status != nil {
		meta = append(meta, `"status":"`+*request.Status+`"`)
	}
	if request.StorageQuota != nil {
		meta = append(meta, `"storage_quota":`+strconv.FormatInt(*request.StorageQuota, 10))
	}
	if request.Role != nil {
		meta = append(meta, `"role":"`+*request.Role+`"`)
	}
	if request.Nickname != nil {
		// 只记录变更发生，不回显昵称内容（审计噪音控制）。
		meta = append(meta, `"nickname":true`)
	}
	h.recordAudit(c, audit.Entry{UserID: &actor, Action: audit.ActionUserUpdate, ResourceType: audit.ResourceUser, ResourceID: id.String(), Metadata: "{" + strings.Join(meta, ",") + "}"})
	c.JSON(http.StatusOK, adminUserJSON(user))
}

type adminResetPasswordRequest struct {
	NewPassword string `json:"new_password"`
}

// adminResetUserPassword POST /api/v1/admin/users/:id/reset-password
// {new_password}：强度校验（与自助改密同规则）后更新哈希并撤销该用户全部
// 会话（被重置者所有设备需以新密码重新登录）。成功 204，写 user.reset_password
// 审计（不记录密码任何形态）。
func (h *Handler) adminResetUserPassword(c *gin.Context) {
	id, ok := parseID(c, c.Param("id"))
	if !ok {
		return
	}
	var request adminResetPasswordRequest
	if c.ShouldBindJSON(&request) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if err := h.auth.AdminResetPassword(id, request.NewPassword); err != nil {
		switch {
		case errors.Is(err, auth.ErrPasswordTooShort), errors.Is(err, auth.ErrPasswordTooWeak):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case errors.Is(err, auth.ErrUserNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		case errors.Is(err, auth.ErrNotConfigured):
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "password reset is not configured"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to reset password"})
		}
		return
	}
	actor := userID(c)
	h.recordAudit(c, audit.Entry{UserID: &actor, Action: audit.ActionUserResetPassword, ResourceType: audit.ResourceUser, ResourceID: id.String()})
	c.Status(http.StatusNoContent)
}
