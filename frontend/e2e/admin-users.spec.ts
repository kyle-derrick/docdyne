// 手动创建用户 E2E（无 SMTP 开户路径）：管理端 API 创建 → 新用户可登录 →
// 文件页正常（默认空间自动创建，不因缺省空间 500）。
import { test, expect } from '@playwright/test'
import { cfg, e2eSeed } from './helpers'

const stamp = Date.now().toString(36)
const username = `e2euser_${stamp}`
const password = 'E2eUserPass12345'

test.describe('手动创建用户', () => {
  test('管理员创建 → 新用户登录 → 文件页可用', async ({ page, request }) => {
    // 1) seed 管理员登录拿 token（E2E 种子账号为 admin）。
    const login = await request.post(`${cfg.backendURL + '/api/v1'}/auth/login`, {
      data: { email: e2eSeed().email, password: e2eSeed().password },
    })
    expect(login.ok()).toBeTruthy()
    const { access_token: adminTok } = (await login.json()) as { access_token: string }

    // 2) 手动开户（无邮箱；占位 local.invalid）。
    const create = await request.post(`${cfg.backendURL + '/api/v1'}/admin/users`, {
      headers: { Authorization: `Bearer ${adminTok}` },
      data: { username, password, nickname: 'E2E 手动用户' },
    })
    expect(create.status()).toBe(201)
    const created = (await create.json()) as { email: string; storage_quota: number }
    expect(created.email).toBe(`${username}@local.invalid`)
    expect(created.storage_quota).toBeGreaterThan(0)

    // 3) 新用户用户名登录 → 文件页（默认空间自动创建，不再 500）。
    await page.goto('/login')
    await page.getByLabel('邮箱').fill(username)
    await page.getByLabel('密码').fill(password)
    await page.getByRole('button', { name: /登\s*录/ }).click()
    await expect(page).toHaveURL(`${cfg.frontendBaseURL}/`)
    await expect(page.locator('.user-menu-trigger')).toBeVisible()
  })
})
