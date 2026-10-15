package ai

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// H4：平台工具执行超时护栏（读 30s / 写 60s、请求取消、panic 恢复）。
func TestExecToolWithTimeout(t *testing.T) {
	oldRead, oldWrite := platformToolReadTimeout, platformToolWriteTimeout
	platformToolReadTimeout, platformToolWriteTimeout = 50*time.Millisecond, 80*time.Millisecond
	defer func() { platformToolReadTimeout, platformToolWriteTimeout = oldRead, oldWrite }()

	// 正常完成：透传结果。
	out, err := execToolWithTimeout(context.Background(), func(name string, args json.RawMessage) (string, error) {
		return "ok:" + name, nil
	}, PlatformToolReadFile, nil)
	if err != nil || out != "ok:"+PlatformToolReadFile {
		t.Fatalf("fast path = (%q, %v)", out, err)
	}

	// 读类超时：文案引导缩小范围/换读工具。
	slow := func(name string, args json.RawMessage) (string, error) {
		time.Sleep(2 * time.Second)
		return "late", nil
	}
	_, err = execToolWithTimeout(context.Background(), slow, PlatformToolSearch, nil)
	if err == nil || !strings.Contains(err.Error(), "执行超时") || strings.Contains(err.Error(), "写操作") {
		t.Fatalf("read timeout err = %v, want 读类超时文案", err)
	}

	// 写类超时：文案提示可能已执行、需读校验。
	_, err = execToolWithTimeout(context.Background(), slow, PlatformToolWriteFile, nil)
	if err == nil || !strings.Contains(err.Error(), "写操作可能已完成") {
		t.Fatalf("write timeout err = %v, want 写类超时文案", err)
	}

	// 请求取消（用户停止）：立即返回，不等超时。
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err = execToolWithTimeout(ctx, slow, PlatformToolReadFile, nil)
	if err == nil || !strings.Contains(err.Error(), "请求已取消") {
		t.Fatalf("cancel err = %v, want 请求已取消", err)
	}
	if elapsed := time.Since(start); elapsed > platformToolReadTimeout {
		t.Fatalf("cancel took %s, should return before timeout", elapsed)
	}

	// panic 恢复：转错误文本，不炸整个循环。
	_, err = execToolWithTimeout(context.Background(), func(name string, args json.RawMessage) (string, error) {
		panic("boom")
	}, PlatformToolListDir, nil)
	if err == nil || !strings.Contains(err.Error(), "工具执行异常") {
		t.Fatalf("panic err = %v, want 工具执行异常", err)
	}
}

// isWritePlatformTool 分类与常量同步。
func TestIsWritePlatformTool(t *testing.T) {
	for _, name := range []string{PlatformToolWriteFile, PlatformToolMkdir, PlatformToolWriteMemory} {
		if !isWritePlatformTool(name) {
			t.Errorf("isWritePlatformTool(%q) = false, want true", name)
		}
	}
	for _, name := range []string{PlatformToolListDir, PlatformToolReadFile, PlatformToolSearch, PlatformToolSearchHistory, PlatformToolReadMemory} {
		if isWritePlatformTool(name) {
			t.Errorf("isWritePlatformTool(%q) = true, want false", name)
		}
	}
}
