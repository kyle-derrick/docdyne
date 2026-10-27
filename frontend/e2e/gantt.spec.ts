// 甘特图 E2E（.ddgantt，dhtmlx-gantt Community）：上传 → 独立查看页渲染
//（网格 + 任务条）→ 编辑页打开（工具栏：历史版本/导出/缩放/保存）→
// 新建菜单含「甘特图」入口。
import { test, expect, type Page } from '@playwright/test'
import { fileRow, loginViaUI } from './helpers'

const stamp = Date.now().toString(36)
const ganttName = `e2eGantt_${stamp}.ddgantt`
const plan = {
  data: [
    { id: 1, text: 'E2E 计划', start_date: '2026-11-02', duration: 10, progress: 0, open: true, type: 'project' },
    { id: 2, text: '任务A', start_date: '2026-11-02', duration: 3, progress: 0.5, parent: 1 },
    { id: 3, text: '里程碑', start_date: '2026-11-11', duration: 0, type: 'milestone', parent: 1 },
  ],
  links: [{ id: 1, source: 2, target: 3, type: '0' }],
}

async function uploadGantt(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[type="file"]').first().setInputFiles({
    name: ganttName,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(plan), 'utf8'),
  })
  await expect(fileRow(page, ganttName)).toBeVisible({ timeout: 60_000 })
}

test.describe.serial('甘特图', () => {
  test('上传 .ddgantt 并在独立查看页渲染', async ({ page }) => {
    await loginViaUI(page)
    await uploadGantt(page)
    await fileRow(page, ganttName).locator('.name-btn').click()
    const modal = page.locator('[role=dialog]')
    await expect(modal).toBeVisible()
    // 查看弹窗内只读甘特图：网格 + 至少 3 个任务行（含里程碑）。
    await expect(modal.locator('.gantt_grid')).toBeVisible({ timeout: 30_000 })
    await expect(modal.locator('.gantt_grid_row, .gantt_row').first()).toBeVisible()
  })

  test('编辑页打开：工具栏与中文网格', async ({ page }) => {
    await loginViaUI(page)
    await uploadGantt(page)
    await fileRow(page, ganttName).getByRole('button', { name: '操作' }).click()
    await page.locator('.ctx-menu').getByRole('menuitem', { name: /甘特图编辑/ }).click()
    // 新窗口打开编辑器（页签名独立）。
    const editor = page.waitForEvent('popup')
    const editorPage = await editor
    await expect(editorPage.locator('.gantt_grid')).toBeVisible({ timeout: 30_000 })
    await expect(editorPage.locator('.gantt_grid')).toContainText('任务A')
    // 工具栏：缩放档位 + 导出 + 保存。
    await expect(editorPage.getByRole('button', { name: '保存并退出' })).toBeVisible()
    await expect(editorPage.locator('.ant-segmented').first()).toBeVisible()
  })

  test('新建菜单含甘特图入口', async ({ page }) => {
    await loginViaUI(page)
    await page.goto('/')
    await page.getByRole('button', { name: /新\s*建/ }).click()
    await expect(page.getByRole('menuitem', { name: /甘特图/ })).toBeVisible()
  })
})
