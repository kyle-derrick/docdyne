// AI 对话附件（v7.9）：对话内直接上传的文件落入每用户隐藏空间
// 「AI 对话附件」（space.EnsureAttachmentSpace），不在文件管理的用户
// 空间出现；上传复用既有 /uploads 会话管线（parent=附件空间根目录），
// 删除复用 DELETE /files/:id。会话删除时联动清理其上传附件
// （aiConvoDelete 内回放事件收集 user 回合 files[].upload 标记）。
package http

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// aiAttachmentSpace GET /api/v1/ai/attachment-space：确保当前用户的
// 「AI 对话附件」隐藏空间存在，返回 {space_id, root_id}（上传 parent）。
func (h *Handler) aiAttachmentSpace(c *gin.Context) {
	if h.spaces == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "spaces is not configured"})
		return
	}
	sp, root, err := h.spaces.EnsureAttachmentSpace(userID(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unable to ensure attachment space"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"space_id": sp.ID, "root_id": root.ID})
}

// collectUploadedAttachments 从会话消息（事件重放结果）收集上传附件的
// fileId（user 回合 files[] 中 upload=true 的条目；宽松解析，损坏条目跳过）。
func collectUploadedAttachments(messages json.RawMessage) []uuid.UUID {
	var turns []struct {
		Role  string `json:"role"`
		Files []struct {
			FileID string `json:"fileId"`
			Upload bool   `json:"upload"`
		} `json:"files"`
	}
	if err := json.Unmarshal(messages, &turns); err != nil {
		return nil
	}
	seen := make(map[uuid.UUID]bool, len(turns))
	var out []uuid.UUID
	for _, t := range turns {
		for _, f := range t.Files {
			if !f.Upload || f.FileID == "" {
				continue
			}
			id, err := uuid.Parse(f.FileID)
			if err != nil || seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// deleteConversationAttachments 会话删除后的附件联动清理（best-effort：
// 单个失败不阻断，附件空间文件本就仅会话引用）。
func (h *Handler) deleteConversationAttachments(userID uuid.UUID, messages json.RawMessage) {
	if h.files == nil {
		return
	}
	for _, fid := range collectUploadedAttachments(messages) {
		_ = h.files.Delete(userID, fid)
	}
}
