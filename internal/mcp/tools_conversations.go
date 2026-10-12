// Package mcp —— tools_conversations.go：AI 会话外控与平台技能开放（C4）。
//
// 把平台的 AI 编辑会话（ai_conversations，source=assistant/editor/plugin 按
// 文件分域）暴露给外部 agent：读列表/读正文（files:read）+ 追加事件
//（files:write，外部 agent 可把方案/结论灌进会话）；df_platform_skills
// 返回内置领域知识（drawio XML / excalidraw 骨架 / Office 编辑规范）——
// 外部 agent 拿到与站内 Agent 同等的提示词知识即可直接产出合法文件内容
//（配合 df_write_file / df_write_version 落地）。
package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/docflow/docflow/internal/auth"
)

// ConvoStore 抽象会话存取（生产 *auth.UserStore；HTTP 装配注入）。
type ConvoStore interface {
	ListAIConversations(userID uuid.UUID, fileID *uuid.UUID, source string, limit int) ([]auth.AIConversationMeta, error)
	GetAIConversation(userID, id uuid.UUID) (auth.AIConversation, bool, error)
	AppendAIConvoEvent(userID, id uuid.UUID, kind string, payload json.RawMessage) (bool, error)
}

// platformSkillsDoc 内置领域知识（与站内 Agent 提示词同源精编，对外开放）。
const platformSkillsDoc = `DocFlow 内置 AI 领域知识（与站内编辑 Agent 同源）：

## drawio（.drawio 即 XML，df_write_file/df_write_version 直接写文本即编辑）
- 结构：<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>…cells…</root></mxGraphModel>（完整 <mxfile> 亦可）。
- 节点：<mxCell id="2" value="标签" style="…" vertex="1" parent="1"><mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>——先定义节点再被边引用。
- 边：<mxCell id="5" value="是" style="edgeStyle=orthogonalEdgeStyle;rounded=0;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>。
- 常用 style：rounded=1;whiteSpace=wrap;html=1;（圆角矩形）/ ellipse;…（椭圆）/ rhombus;…（菱形）/ text;html=1;（纯文本）；fillColor/strokeColor/fontSize/fontStyle=1（粗体）。
- 布局：自左向右或自上而下，节点间距 ≥40，主流向步长 160-200、交叉向 100；网格对齐（20 的倍数）；每个顶点必须带显式 mxGeometry（x/y/width/height）。
- 边完整性（硬性）：source/target 必须引用同模型中已定义（且先于该边）的 id；两个节点包围盒不得相交；改既有图时保留未变元素 id，不要整体重编号。
- XML 必须 well-formed；value 属性内 < > & " ' 需转义。

## excalidraw（.excalidraw 即 JSON）
- 元素骨架数组（官方 convertToExcalidrawElements 语义）：每元素必含 type 与数值 x/y；短字符串 id（n1/n2…）供箭头引用。
- 形状：rectangle/diamond/ellipse（带 width/height 与可选 label{text,fontSize}）；text（独立文本，勿设宽高）。
- 连线：arrow 用 start:{id}/end:{id} 绑定节点 id（不得引用未定义 id）；line 用相对 points:[[0,0],[dx,dy]]。
- 约定：颜色十六进制串（描边 #1e1e1e，强调色对 #1971c2/#a5d8ff 蓝、#2f9e44/#d3f9d8 绿、#e8590c/#ffe8cc 橙、#c2255c/#ffdeeb 粉）；fillStyle solid|hachure；粗细 2；字号 16-28；布局在 1200×800 内、间距 ≥40、20 网格对齐、无重叠。
- 不输出 seed/version/versionNonce/isDeleted/updated/groupIds/boundElements。

## Office（经 OnlyOffice 编辑；站内 Agent 工具语义参考）
- Excel：坐标一律 1 基（[行,列]，[1,1]=A1）；整表含表头用二维数组一次写入并给表头加样式（加粗+底纹+居中）；公式以 = 开头英文函数名；数字/百分比/日期列设 numberFormat（0.00% / #,##0 / yyyy-mm-dd）。
- Word：元素序号 1 基；Markdown 子集（#/##/###、- 与 1. 列表、**粗**、|表格|、代码块）可直转文档元素；表格首行为表头（加粗+底纹）。
- PPT：页码 1 基；一页一次成型（标题+要点）；文本框坐标 pt（页约 960×540）。

## 平台文件操作（配合技能落地）
- df_write_file 建文件 / df_write_version 覆盖为新版本（drawio/excalidraw/md/mermaid/svg 等文本格式均可直写）。
- 编辑会话读写：df_list_conversations / df_get_conversation / df_append_conversation（本文件工具集）。`

// conversationTools 返回会话外控工具集（userStore 为 nil 时不注册）。
func conversationTools(userStore ConvoStore) []Tool {
	if userStore == nil {
		return nil
	}
	convosAvailable := func(deps *Deps) bool { return deps.Convos != nil }
	prop := func(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
	return []Tool{
		{
			Name:        "df_list_conversations",
			Description: "列出当前用户的 AI 会话（editor/plugin 域按文件；file_id 省略 + source=editor 时列出全部文件的编辑会话）。返回 id/title/source/file_id/message_count/updated_at。",
			Scope:       ScopeFilesRead,
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{
				"source":  prop("assistant|editor|plugin（缺省 assistant）"),
				"file_id": prop("编辑/插件域的文件 id（可省）"),
			}},
			Available: convosAvailable,
			Handler: func(ctx context.Context, deps *Deps, id Identity, args json.RawMessage) (any, error) {
				var req struct {
					Source string `json:"source"`
					FileID string `json:"file_id"`
				}
				_ = json.Unmarshal(args, &req)
				if req.Source == "" {
					req.Source = auth.AIConvoSourceAssistant
				}
				var fileID *uuid.UUID
				if req.FileID != "" {
					fid, err := uuid.Parse(req.FileID)
					if err != nil {
						return nil, fmt.Errorf("file_id 非法")
					}
					fileID = &fid
				}
				items, err := deps.Convos.ListAIConversations(id.UserID, fileID, req.Source, 0)
				if err != nil {
					return nil, err
				}
				return map[string]any{"conversations": items}, nil
			},
		},
		{
			Name:        "df_get_conversation",
			Description: "读取一个 AI 会话的完整内容（messages 为事件重放结果——外部 agent 可读取站内编辑会话上下文后接手继续干活）。",
			Scope:       ScopeFilesRead,
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{
				"id": prop("会话 id（df_list_conversations 获得）"),
			}, "required": []string{"id"}},
			Available: convosAvailable,
			Handler: func(ctx context.Context, deps *Deps, id Identity, args json.RawMessage) (any, error) {
				var req struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(args, &req); err != nil || req.ID == "" {
					return nil, fmt.Errorf("id 必填")
				}
				cid, err := uuid.Parse(req.ID)
				if err != nil {
					return nil, fmt.Errorf("id 非法")
				}
				row, found, err := deps.Convos.GetAIConversation(id.UserID, cid)
				if err != nil {
					return nil, err
				}
				if !found {
					return nil, fmt.Errorf("会话不存在")
				}
				return row, nil
			},
		},
		{
			Name:        "df_append_conversation",
			Description: "向 AI 会话追加事件（kind=turn 增量回合 / snapshot 全量替换）——外部 agent 可把结论/方案写入用户的编辑会话（站内「继续」可接着执行）。",
			Scope:       ScopeFilesWrite,
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{
				"id":       prop("会话 id"),
				"kind":     prop("turn|snapshot（缺省 turn）"),
				"messages": map[string]any{"type": "array", "description": "回合结构数组 [{role,content,…}]", "items": map[string]any{"type": "object"}},
			}, "required": []string{"id", "messages"}},
			Available: convosAvailable,
			Handler: func(ctx context.Context, deps *Deps, id Identity, args json.RawMessage) (any, error) {
				var req struct {
					ID       string          `json:"id"`
					Kind     string          `json:"kind"`
					Messages json.RawMessage `json:"messages"`
				}
				if err := json.Unmarshal(args, &req); err != nil || req.ID == "" || len(req.Messages) == 0 {
					return nil, fmt.Errorf("id 与 messages 必填")
				}
				cid, err := uuid.Parse(req.ID)
				if err != nil {
					return nil, fmt.Errorf("id 非法")
				}
				if req.Kind == "" {
					req.Kind = "turn"
				}
				ok, err := deps.Convos.AppendAIConvoEvent(id.UserID, cid, req.Kind, req.Messages)
				if err != nil {
					return nil, err
				}
				if !ok {
					return nil, fmt.Errorf("会话不存在")
				}
				return map[string]any{"ok": true}, nil
			},
		},
		{
			Name:        "df_platform_skills",
			Description: "返回 DocFlow 内置 AI 领域知识（drawio XML / excalidraw 元素骨架 / Office 编辑规范 / 会话与文件工具用法）——外部 agent 依据本知识可直接产出合法的图表/白板/文档内容并经 df_write_file 落地。",
			Scope:       ScopeFilesRead,
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
			Handler: func(ctx context.Context, deps *Deps, id Identity, args json.RawMessage) (any, error) {
				return map[string]any{"skills": platformSkillsDoc}, nil
			},
		},
	}
}
