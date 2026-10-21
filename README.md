# TOTP 验证器

个人使用的轻量本地验证器。6 位数字 PIN 解锁，多账号实时动态码，浏览器本地加密保存；无后端、无注册、无分析脚本或运行时外部依赖。

目标地址：<https://cznail.github.io/totp/>。主页仓库只维护工具入口，本仓库独立开发和部署。

## 使用

1. 首次打开，设置并确认 6 位数字 PIN。
2. 添加账号，粘贴 Base32 验证器密钥或 `otpauth://totp/…` 链接。链接会自动填写账号、服务和参数。
3. 点击验证码复制；倒计时结束后自动更新。支持 SHA-1 / SHA-256 / SHA-512、6 / 8 位和 1–300 秒周期。
4. 支持搜索、重命名、删除账号。使用期间保持解锁，点击锁定或刷新、关闭、离开页面后重新输入 PIN。
5. 在「备份」中导出加密 JSON。恢复需要备份当时的 PIN，会**替换**当前浏览器全部账号，确认后才执行。修改 PIN 后请重新导出备份；旧文件仍使用旧 PIN。

清理站点数据、更换浏览器或隐私窗口关闭后，账号可能丢失。PIN 无法找回；忘记后只能使用知道 PIN 的备份恢复，或清空本机数据重新开始。删除本地账号不会关闭服务端的两步验证。

页面加载完成后，断网仍能生成动态码；设备时间需准确。未实现 Service Worker，因此不保证断网时重新打开或刷新页面。不会从页面 URL 自动导入或接收密钥。不支持 HOTP、二维码扫描、云同步、手势或系统认证。

## 本地保护

- Web Crypto PBKDF2-SHA-256，600,000 次迭代、随机 16 字节盐，派生不可导出的 AES-256-GCM 密钥。
- 所有账号名称、服务、密钥、参数一起加密；IndexedDB 只保存加密封装和随机修订标识。每次保存使用新的随机 12 字节 IV，GCM 128 位认证标签，格式与 KDF 元数据作为附加认证数据。
- 不保存 PIN、派生密钥或明文账号。解锁所需数据仅存在当前页面内存；锁定时移除引用和敏感表单、验证码 DOM。JavaScript 运行时不保证物理内存清零。
- 导出仅包含同一加密封装。恢复时重新生成盐和 IV，修改 PIN 时重新派生密钥并加密。
- 同一事务中比较修订号后写入，阻止旧标签页覆盖新数据；标签页之间仅广播变更通知，不广播账号或密钥。
- 备份格式、账号数量、密钥和算法均校验；文件限制 2 MB，最多 200 个账号。导入校验或保存失败时保留原库。
- CSP 限制页面网络连接，不加载第三方字体、脚本或统计。主题偏好使用主页共用的 `localStorage` 键 `neil-homepage:theme`，不涉及账号。

6 位 PIN 是体验优先的基础保护：密文被复制后仍可能被离线枚举，PBKDF2 只增加成本；无法防御被控制的设备、扩展或页面脚本。独立仓库方便维护；GitHub Pages 上同一域名的不同路径仍属于同源。

## 开发与测试

需要 Node.js 24。

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

`npm run dev` 默认使用 Vite 的开发服务。生产 CSP 禁止网络连接，会阻止开发热更新的 WebSocket；常规页面刷新仍可用于调试。`npm run preview` 用于检查构建后的真实运行结果。

- `src/totp.ts`：Base32、otpauth 解析、HMAC 与动态码计算。
- `src/vault.ts`：PIN 派生、AES-GCM、备份和账号数据校验。
- `src/storage.ts`：IndexedDB 与原子修订检查。
- `src/main.ts`：界面、会话、复制、备份恢复、跨标签页处理。
- `tests/`：RFC 6238 三种算法全部 18 组标准向量、RFC 4226、边界、解析与加密校验。
- `e2e/`：真实 Chromium 中验证账号流程、存储内容、备份与 PIN 修改、冲突、写入失败、离线、移动布局和锁定。

算法参考：[RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)、[RFC 4226](https://www.rfc-editor.org/rfc/rfc4226)。加密使用浏览器原生 [Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)。

## GitHub Pages

1. 在仓库 **Settings → Pages → Build and deployment**，将 **Source** 设置为 **GitHub Actions**。
2. 合并到 `main` 后自动运行单元测试、类型检查、构建和浏览器测试，再部署 `dist/`。也可手动执行工作流。
3. Vite 的 `base` 为 `/totp/`；部署地址以 Actions 实际返回值为准。
4. 发布验证成功后，在 `cznail.github.io` 的 `src/data/tools.json` 中登记 `/totp/` 入口。
