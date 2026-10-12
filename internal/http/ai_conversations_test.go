package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/docflow/docflow/internal/auth"
)

// ---------- AI 会话记录（/ai/conversations，migration 053）----------

// fakeAIConvoStore 内存实现（列表排序 + 上限裁剪语义与生产一致）。
type fakeAIConvoStore struct {
	rows []auth.AIConversation
}

func (f *fakeAIConvoStore) match(userID uuid.UUID, fileID *uuid.UUID, source string) []auth.AIConversation {
	var out []auth.AIConversation
	for _, r := range f.rows {
		if r.UserID != userID || r.Source != source {
			continue
		}
		if (r.FileID == nil) != (fileID == nil) {
			continue
		}
		if fileID != nil && *r.FileID != *fileID {
			continue
		}
		out = append(out, r)
	}
	// updated_at 倒序。
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].UpdatedAt.After(out[j-1].UpdatedAt); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func (f *fakeAIConvoStore) ListAIConversations(userID uuid.UUID, fileID *uuid.UUID, source string, limit int) ([]auth.AIConversationMeta, error) {
	if err := auth.ValidateAIConvoSource(source); err != nil {
		return nil, err
	}
	rows := f.match(userID, fileID, source)
	if limit <= 0 || limit > auth.AIConvoKeepPerScope {
		limit = auth.AIConvoKeepPerScope
	}
	if len(rows) > limit {
		rows = rows[:limit]
	}
	out := make([]auth.AIConversationMeta, 0, len(rows))
	for _, r := range rows {
		var arr []json.RawMessage
		_ = json.Unmarshal(r.Messages, &arr)
		out = append(out, auth.AIConversationMeta{ID: r.ID, FileID: r.FileID, Source: r.Source, Title: r.Title, MessageCount: len(arr), UpdatedAt: r.UpdatedAt})
	}
	return out, nil
}

func (f *fakeAIConvoStore) CreateAIConversation(userID uuid.UUID, fileID *uuid.UUID, source, title string) (auth.AIConversation, error) {
	if err := auth.ValidateAIConvoSource(source); err != nil {
		return auth.AIConversation{}, err
	}
	if err := auth.ValidateAIConvoTitle(title); err != nil {
		return auth.AIConversation{}, err
	}
	row := auth.AIConversation{ID: uuid.Must(uuid.NewV7()), UserID: userID, FileID: fileID, Source: source, Title: title, Messages: json.RawMessage("[]"), CreatedAt: time.Now(), UpdatedAt: time.Now()}
	f.rows = append(f.rows, row)
	return row, nil
}

func (f *fakeAIConvoStore) GetAIConversation(userID, id uuid.UUID) (auth.AIConversation, bool, error) {
	for _, r := range f.rows {
		if r.ID == id && r.UserID == userID {
			return r, true, nil
		}
	}
	return auth.AIConversation{}, false, nil
}

func (f *fakeAIConvoStore) UpdateAIConversation(userID, id uuid.UUID, title *string, messages json.RawMessage) (bool, error) {
	for i := range f.rows {
		if f.rows[i].ID != id || f.rows[i].UserID != userID {
			continue
		}
		if title != nil {
			if err := auth.ValidateAIConvoTitle(*title); err != nil {
				return false, err
			}
			f.rows[i].Title = *title
		}
		if messages != nil {
			if err := auth.ValidateAIConvoMessages(messages); err != nil {
				return false, err
			}
			f.rows[i].Messages = messages
		}
		f.rows[i].UpdatedAt = time.Now()
		return true, nil
	}
	return false, nil
}

func (f *fakeAIConvoStore) DeleteAIConversation(userID, id uuid.UUID) (bool, error) {
	for i := range f.rows {
		if f.rows[i].ID == id && f.rows[i].UserID == userID {
			f.rows = append(f.rows[:i], f.rows[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func newAIConvoRouter(store aiConvoStore, actor uuid.UUID) *gin.Engine {
	gin.SetMode(gin.TestMode)
	h := NewHandler(nil, nil, nil, nil, nil, nil, nil, false, "", time.Hour)
	h.aiConversations = store
	r := gin.New()
	withUser := func(handle gin.HandlerFunc) gin.HandlerFunc {
		return func(c *gin.Context) {
			c.Set(auth.UserIDContextKey, actor)
			handle(c)
		}
	}
	r.GET("/api/v1/ai/conversations", withUser(h.aiConvoList))
	r.POST("/api/v1/ai/conversations", withUser(h.aiConvoCreate))
	r.GET("/api/v1/ai/conversations/:id", withUser(h.aiConvoGet))
	r.PUT("/api/v1/ai/conversations/:id", withUser(h.aiConvoUpdate))
	r.DELETE("/api/v1/ai/conversations/:id", withUser(h.aiConvoDelete))
	return r
}

// TestAIConversationsCRUD 全链路：新建（editor 域）→ 列表（file_id 过滤 +
// message_count）→ 读取正文 → 更新（非法 messages 400）→ 删除（404 复验）。
func TestAIConversationsCRUD(t *testing.T) {
	actor := uuid.New()
	store := &fakeAIConvoStore{}
	other := uuid.New()
	r := newAIConvoRouter(store, actor)

	// 新建：editor 域带 file_id。
	fileID := uuid.Must(uuid.NewV7())
	body, _ := json.Marshal(map[string]any{"source": "editor", "file_id": fileID, "title": "润色报告"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/ai/conversations", bytes.NewReader(body)))
	if w.Code != http.StatusCreated {
		t.Fatalf("create status = %d body %s", w.Code, w.Body.String())
	}
	var created struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.Conversation.ID == "" {
		t.Fatalf("create body 解析失败: %v %s", err, w.Body.String())
	}

	// 写入消息（messages 为前端回合数组，服务端不逐条解释）。
	msgs, _ := json.Marshal(map[string]any{"messages": []map[string]any{
		{"role": "user", "content": "把第二段改简洁"},
		{"role": "assistant", "content": "已通过 replace_text 完成"},
	}})
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/v1/ai/conversations/"+created.Conversation.ID, bytes.NewReader(msgs)))
	if w.Code != http.StatusOK {
		t.Fatalf("update status = %d body %s", w.Code, w.Body.String())
	}

	// 列表：file_id + source 过滤命中，message_count=2；他人 scope 不可见。
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/conversations?source=editor&file_id="+fileID.String(), nil))
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d body %s", w.Code, w.Body.String())
	}
	var list struct {
		Conversations []struct {
			ID           string `json:"id"`
			MessageCount int    `json:"message_count"`
			Title        string `json:"title"`
		} `json:"conversations"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("list body 解析失败: %v", err)
	}
	if len(list.Conversations) != 1 || list.Conversations[0].MessageCount != 2 || list.Conversations[0].Title != "润色报告" {
		t.Fatalf("list 期望 1 条（count=2, title=润色报告）: %+v", list.Conversations)
	}
	if got := len(store.match(other, &fileID, "editor")); got != 0 {
		t.Fatalf("他人应不可见，got %d", got)
	}

	// 读取正文。
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/conversations/"+created.Conversation.ID, nil))
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("replace_text")) {
		t.Fatalf("get status = %d body %s", w.Code, w.Body.String())
	}

	// 非法 messages（非数组）→ 400 INVALID_AI_CONVERSATION。
	bad, _ := json.Marshal(map[string]any{"messages": map[string]any{"nope": 1}})
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/v1/ai/conversations/"+created.Conversation.ID, bytes.NewReader(bad)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非法 messages 应 400: %d %s", w.Code, w.Body.String())
	}

	// 删除 → 204；再读 404。
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/ai/conversations/"+created.Conversation.ID, nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d body %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/conversations/"+created.Conversation.ID, nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("删除后应 404: %d", w.Code)
	}
}

// TestAIConversationsScopeValidation source 非法 400；assistant 域
//（file_id 为空）与 editor 域互不串扰。
func TestAIConversationsScopeValidation(t *testing.T) {
	actor := uuid.New()
	store := &fakeAIConvoStore{}
	r := newAIConvoRouter(store, actor)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/conversations?source=bogus", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非法 source 应 400: %d %s", w.Code, w.Body.String())
	}

	// assistant 域建一条；editor 域列表不应看到。
	if _, err := store.CreateAIConversation(actor, nil, "assistant", "全局会话"); err != nil {
		t.Fatalf("create: %v", err)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/conversations?source=assistant", nil))
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("全局会话")) {
		t.Fatalf("assistant 域应命中: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/ai/conversations?source=editor", nil))
	if w.Code != http.StatusOK || bytes.Contains(w.Body.Bytes(), []byte("全局会话")) {
		t.Fatalf("editor 域不应看到 assistant 会话: %d %s", w.Code, w.Body.String())
	}
}
