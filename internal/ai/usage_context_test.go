package ai

import (
	"testing"

	"github.com/google/uuid"
)

// G2：请求类型归一 + 会话上下文 sink 包装（usageContextSink）。
func TestUsageKindNormalize(t *testing.T) {
	cases := map[string]string{
		"":        "chat",
		"chat":    "chat",
		"agent":   "agent",
		"summary": "summary",
		"ocr":     "ocr",
		"hacker":  "chat", // 未知值归 chat，防脏值撑宽列
	}
	for in, want := range cases {
		if got := UsageKindNormalize(in); got != want {
			t.Errorf("UsageKindNormalize(%q) = %q, want %q", in, got, want)
		}
	}
}

type recordingSink struct{ entries []UsageEntry }

func (r *recordingSink) Record(e UsageEntry) error { r.entries = append(r.entries, e); return nil }

func TestUsageContextSink(t *testing.T) {
	inner := &recordingSink{}
	convID := uuid.New()
	sink := usageContextSink{inner: inner, conversation: uuid.NullUUID{UUID: convID, Valid: true}, kind: "agent"}

	// 空值补上下文（常规路径：recordUsage 只填 provider/model/tokens）。
	if err := sink.Record(UsageEntry{ProviderID: "p", Model: "m"}); err != nil {
		t.Fatalf("record: %v", err)
	}
	// 已带值的不会被覆盖（OCR 等直填 kind 的路径）。
	if err := sink.Record(UsageEntry{Kind: "ocr"}); err != nil {
		t.Fatalf("record: %v", err)
	}
	if len(inner.entries) != 2 {
		t.Fatalf("inner entries = %d, want 2", len(inner.entries))
	}
	first := inner.entries[0]
	if !first.ConversationID.Valid || first.ConversationID.UUID != convID {
		t.Errorf("entry0 conversation = %+v, want %s", first.ConversationID, convID)
	}
	if first.Kind != "agent" {
		t.Errorf("entry0 kind = %q, want agent", first.Kind)
	}
	second := inner.entries[1]
	if second.Kind != "ocr" {
		t.Errorf("entry1 kind = %q, want ocr（已带值不覆盖）", second.Kind)
	}

	// nil 内层安全（未接线静默跳过）。
	var nop usageContextSink
	if err := nop.Record(UsageEntry{}); err != nil {
		t.Fatalf("nil inner record: %v", err)
	}
}
