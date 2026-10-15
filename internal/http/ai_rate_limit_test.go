package http

import (
	"testing"
	"time"
)

// H3 配额预警：DailyUsed 只读探测（含 AllowDaily 已计的本次）、窗口外
// 归零、不递增计数。
func TestDynamicRateLimiterDailyUsed(t *testing.T) {
	now := time.Date(2026, 10, 15, 10, 0, 0, 0, time.UTC)
	l := newDynamicRateLimiter()
	l.now = func() time.Time { return now }

	// 未计数 = 0，且 DailyUsed 本身不新建窗口。
	if got := l.DailyUsed("u|p"); got != 0 {
		t.Fatalf("empty DailyUsed = %d, want 0", got)
	}
	for i := 0; i < 8; i++ {
		if ok, _ := l.AllowDaily("u|p", 10); !ok {
			t.Fatalf("AllowDaily #%d rejected", i)
		}
	}
	if got := l.DailyUsed("u|p"); got != 8 {
		t.Fatalf("DailyUsed = %d, want 8（含本次）", got)
	}
	// 只读：再次探测计数不变。
	if got := l.DailyUsed("u|p"); got != 8 {
		t.Fatalf("DailyUsed repeat = %d, want 8", got)
	}

	// 跨日（UTC 窗口重置）：归零后重新计数。
	now = now.Add(25 * time.Hour)
	if ok, _ := l.AllowDaily("u|p", 10); !ok {
		t.Fatal("AllowDaily after reset rejected")
	}
	if got := l.DailyUsed("u|p"); got != 1 {
		t.Fatalf("DailyUsed after reset = %d, want 1", got)
	}
}

// H3 预警阈值：80% 边界（8/10 触发、7/10 不触发）在 aiRateLimit 侧由
// c.Set 注入——此处验证阈值常量与判定式一致性。
func TestAIQuotaWarnThreshold(t *testing.T) {
	const daily = 10
	if float64(7) >= float64(daily)*aiQuotaWarnThreshold {
		t.Error("7/10 不应触发预警")
	}
	if !(float64(8) >= float64(daily)*aiQuotaWarnThreshold) {
		t.Error("8/10 应触发预警")
	}
}
