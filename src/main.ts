import './style.css';
import { codeAt, MAX_ACCOUNTS, parseInput, prepareKey, remaining, validateParameters, type Account, type Algorithm } from './totp.ts';
import { createVault, MAX_BACKUP_BYTES, openVault, parseBackup, sealVault, type VaultData } from './vault.ts';
import { ConflictError, readVault, writeVault, type StoredVault } from './storage.ts';

const paths: Record<string, string> = {
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.3 2.3 4.7-4.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  copy: '<rect x="9" y="9" width="11" height="12" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z"/>',
  settings: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3H9Z"/><circle cx="12" cy="12" r="3"/>',
};
const icon = (name: string, className = '') => `<svg class="${className}" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ''}</svg>`;
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const root = document.querySelector<HTMLDivElement>('#app')!;
const toastNode = document.querySelector<HTMLDivElement>('#toast')!;
let record: StoredVault | null = null;
let session: { key: CryptoKey; data: VaultData; keys: Map<string, CryptoKey> } | null = null;
let epoch = 0;
let busy = false;
let toastTimer: ReturnType<typeof setTimeout>;
let dialog: HTMLDialogElement | null = null;
let query = '';
let tickRunning = false;
const codes = new Map<string, { counter: number; code: string }>();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('cznail-totp-changes') : null;
class SessionChanged extends Error {}

function toast(message: string) {
  clearTimeout(toastTimer);
  toastNode.textContent = message;
  toastNode.classList.add('visible');
  toastTimer = setTimeout(() => toastNode.classList.remove('visible'), 4000);
}
function report(error: unknown, form?: HTMLFormElement) {
  if (error instanceof SessionChanged) { if (!session) render(); void refreshFromStorage(); return; }
  if (error instanceof ConflictError) { void refreshFromStorage(); closeDialog(); }
  const message = error instanceof Error ? error.message : '操作失败，请重试。';
  const node = form?.querySelector<HTMLElement>('.form-error');
  if (node && node.isConnected) { node.textContent = message; node.focus(); }
  else toast(message);
}
async function action(task: () => Promise<void>, form?: HTMLFormElement) {
  if (busy) return;
  busy = true;
  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const previous = button?.innerHTML;
  if (button) { button.disabled = true; button.textContent = '处理中…'; }
  form?.querySelector('.form-error')?.replaceChildren();
  try { await task(); } catch (error) { report(error, form); }
  finally { busy = false; if (button?.isConnected) { button.disabled = false; button.innerHTML = previous!; } }
}
function pinField(id: string, label: string, autocomplete = 'current-password') {
  return `<label for="${id}">${label}</label><input class="pin-input" id="${id}" name="${id}" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="${autocomplete}" required placeholder="输入 6 位数字" />`;
}
const errorRegion = '<p class="form-error" role="alert" tabindex="-1"></p>';
function closeDialog() {
  if (!dialog) return;
  dialog.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.value = ''; });
  dialog.close();
  dialog.remove();
  dialog = null;
}
function showDialog(title: string, body: string) {
  closeDialog();
  dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  dialog.innerHTML = `<div class="modal-top"><h2 id="dialog-title">${title}</h2><button type="button" class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div>${body}`;
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) closeDialog(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && !busy) closeDialog(); });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
function notify() { channel?.postMessage({ type: 'changed' }); }
function lock(message?: string) {
  epoch++;
  session = null;
  codes.clear();
  query = '';
  closeDialog();
  render();
  if (message) toast(message);
}
async function refreshFromStorage() {
  try {
    const next = await readVault();
    if ((next?.revision ?? null) !== (record?.revision ?? null)) {
      record = next;
      lock('本地账号库已更新，请重新解锁。');
    }
  } catch (error) { lock(); report(error); }
}
channel?.addEventListener('message', () => { void refreshFromStorage(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refreshFromStorage(); void tick(); } });
window.addEventListener('pagehide', () => { lock(); });
window.addEventListener('pageshow', event => { if (event.persisted) void refreshFromStorage(); });

async function prepareAccounts(data: VaultData) {
  const entries = await Promise.all(data.accounts.map(async account => [account.id, await prepareKey(account)] as const));
  return new Map(entries);
}
async function installSession(data: VaultData, key: CryptoKey, expectedEpoch: number) {
  const keys = await prepareAccounts(data);
  if (epoch !== expectedEpoch) throw new SessionChanged();
  session = { data, key, keys };
  codes.clear();
  query = '';
  closeDialog();
  render();
}
async function persist(data: VaultData) {
  if (!session || !record) throw new SessionChanged();
  const current = session;
  const expected = record.revision;
  const expectedEpoch = epoch;
  const keys = await prepareAccounts(data);
  const envelope = await sealVault(data, current.key, record.envelope.kdf);
  if (epoch !== expectedEpoch) throw new SessionChanged();
  const next = await writeVault(expected, envelope);
  notify();
  record = next;
  if (epoch !== expectedEpoch) throw new SessionChanged();
  session = { ...current, data, keys };
  codes.clear();
  closeDialog();
  render();
}

function render() {
  if (session) { renderAccounts(); return; }
  const isNew = !record;
  root.innerHTML = `<section class="gate-layout">
    <div class="gate-intro"><p class="eyebrow"><span class="tiny-line"></span> 随手可用的小工具</p><h1>TOTP 验证器<span>动态码，留在你手边。</span></h1><p class="intro-copy">把常用账号放在一起。用一个 PIN 解锁，<br class="desktop-break" />随时查看、复制你的动态验证码。</p>
      <div class="privacy-label">${icon('shield')}<span>本地计算，加密保存在当前浏览器</span></div>
      <div class="locked-preview" aria-hidden="true"><div class="preview-top"><span class="preview-dot"></span><span>YOUR ACCOUNTS</span>${icon('lock')}</div><div class="preview-row"><span class="preview-avatar">G</span><div><b>常用账号</b><span>••• •••</span></div><i></i></div><div class="preview-row"><span class="preview-avatar teal">W</span><div><b>工作账号</b><span>••• •••</span></div><i></i></div><p>${icon('lock')} 解锁后，验证码在这里等你</p></div>
    </div>
    <section class="gate-card" aria-labelledby="gate-title"><div class="gate-icon">${icon(isNew ? 'shield' : 'lock')}</div><p class="eyebrow">${isNew ? '从这里开始' : '欢迎回来'}</p><h2 id="gate-title">${isNew ? '创建你的本地账号库' : '解锁你的验证码'}</h2><p class="muted gate-description">${isNew ? '设置一个 6 位 PIN，之后每次打开时使用。' : '输入 6 位 PIN，查看已保存的账号。'}</p>
      <form id="gate-form">${pinField('pin', isNew ? '设置 PIN' : '解锁 PIN', isNew ? 'new-password' : 'current-password')}${isNew ? pinField('pin-confirm', '再次输入 PIN', 'new-password') : ''}${errorRegion}<button type="submit" class="button primary full">${icon(isNew ? 'plus' : 'lock')}${isNew ? '创建账号库' : '解锁'}</button></form>
      <p class="gate-note">${isNew ? 'PIN 提供基础保护，忘记后无法找回。' : '刷新或关闭页面后，需要重新输入 PIN。'}</p>
      <div class="gate-divider"><span>${isNew ? '已有加密备份？' : '管理本地数据'}</span></div><button class="text-button" data-action="import">${icon('upload')}从备份恢复</button>${isNew ? '' : '<button class="text-button" data-action="export">导出加密备份</button><details class="forgot"><summary>忘记 PIN？</summary><p>PIN 无法找回。备份仍需要导出时使用的 PIN；你也可以清空本机数据，重新开始。</p><button class="text-button danger-text" data-action="reset">清空本机数据</button></details>'}
    </section></section><p class="gate-footnote">无需注册，不上传密钥。清理浏览器数据会删除账号，请保留加密备份。</p>`;
  const form = document.querySelector<HTMLFormElement>('#gate-form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    void action(async () => {
      const input = form.querySelector<HTMLInputElement>('#pin')!;
      const pin = input.value;
      const confirm = form.querySelector<HTMLInputElement>('#pin-confirm');
      const confirmation = confirm?.value;
      input.value = '';
      if (confirm) confirm.value = '';
      if (isNew && pin !== confirmation) throw new Error('两次输入的 PIN 不一致，请重新输入。');
      const expectedEpoch = epoch;
      const expectedRevision = record?.revision ?? null;
      if (isNew) {
        const created = await createVault(pin);
        if (epoch !== expectedEpoch) throw new SessionChanged();
        record = await writeVault(null, created.envelope);
        notify();
        await installSession({ version: 1, accounts: [] }, created.key, expectedEpoch);
      } else {
        const opened = await openVault(pin, record!.envelope);
        const latest = await readVault();
        if (latest?.revision !== expectedRevision) throw new ConflictError();
        await installSession(opened.data, opened.key, expectedEpoch);
      }
    }, form);
  });
}

function renderAccounts() {
  if (!session) return;
  const count = session.data.accounts.length;
  root.innerHTML = `<section class="vault-heading"><div><p class="eyebrow"><span class="tiny-line"></span>TOTP 验证器</p><h1>我的验证码 <span class="account-total">${count}</span></h1><p class="muted">常用账号，一处查看。</p></div><div class="vault-actions"><button class="button primary" data-action="add">${icon('plus')}添加账号</button><button class="button secondary" data-action="backup">${icon('download')}备份</button><button class="icon-button square" data-action="settings" aria-label="设置" title="设置">${icon('settings')}</button><button class="icon-button square" data-action="lock" aria-label="锁定账号库" title="锁定账号库">${icon('lock')}</button></div></section>
    <div class="vault-status"><span class="status-pill"><span></span>已解锁 · 本地加密</span><span class="time-note">验证码依照设备时间更新</span></div>
    ${count ? `<div class="list-toolbar"><label class="search-box">${icon('search')}<input id="search" type="search" aria-label="搜索账号" placeholder="搜索账号或服务" autocomplete="off" value="${escape(query)}" /></label><span id="result-count" class="muted small"></span></div><div id="account-grid" class="account-grid"></div>` : `<section class="empty-state"><div class="empty-icon">${icon('plus')}</div><h2>添加你的第一个账号</h2><p>粘贴验证器密钥或 otpauth 链接，<br />下一次就能直接在这里找到。</p><button class="button primary" data-action="add">${icon('plus')}添加账号</button><button class="text-button" data-action="import">已有备份？从备份恢复</button></section>`}
    <p class="vault-footnote">${icon('shield')}<span>账号仅保存在当前浏览器。定期导出备份，换设备也能恢复。</span></p>`;
  document.querySelector('#search')?.addEventListener('input', event => { query = (event.target as HTMLInputElement).value; renderGrid(); });
  renderGrid();
}
function renderGrid() {
  const grid = document.querySelector('#account-grid');
  if (!grid || !session) return;
  const filtered = session.data.accounts.filter(a => `${a.name} ${a.issuer}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  document.querySelector('#result-count')!.textContent = `${filtered.length} 个账号`;
  grid.innerHTML = filtered.length ? filtered.map(account => `<article class="account-card" data-account="${account.id}"><div class="account-top"><span class="account-avatar">${escape(Array.from(account.issuer || account.name)[0].toUpperCase())}</span><div class="account-label"><h2>${escape(account.issuer || account.name)}</h2><p>${escape(account.issuer ? account.name : '动态验证码')}</p></div><button class="icon-button edit-button" data-action="edit" data-id="${account.id}" aria-label="编辑 ${escape(account.name)}" title="编辑账号">${icon('edit')}</button></div><button class="code-button" data-action="copy" data-id="${account.id}" aria-label="复制 ${escape(account.name)} 的验证码"><span class="otp-code" data-code>··· ···</span><span class="copy-glyph">${icon('copy')}</span></button><div class="account-bottom"><span>${account.algorithm.replace('SHA', 'SHA-')} <span class="footer-dot">·</span> ${account.digits} 位</span><span class="countdown" data-countdown></span></div><div class="progress-track"><div data-progress></div></div></article>`).join('') : '<div class="no-results">没有找到匹配的账号，试试其他名称。</div>';
  void tick();
}
async function tick() {
  if (tickRunning || !session || document.hidden) return;
  tickRunning = true;
  const current = session;
  const currentEpoch = epoch;
  try {
    await Promise.all(current.data.accounts.map(async account => {
      const card = document.querySelector<HTMLElement>(`[data-account="${account.id}"]`);
      if (!card) return;
      const now = Date.now();
      const counter = Math.floor(now / 1000 / account.period);
      const seconds = remaining(account.period, now);
      card.querySelector('[data-countdown]')!.textContent = `${seconds} 秒后更新`;
      (card.querySelector('[data-progress]') as HTMLElement).style.width = `${seconds / account.period * 100}%`;
      card.classList.toggle('expiring', seconds <= 5);
      let cached = codes.get(account.id);
      if (!cached || cached.counter !== counter) {
        const code = await codeAt(current.keys.get(account.id)!, account, now);
        if (currentEpoch !== epoch || Math.floor(Date.now() / 1000 / account.period) !== counter) return;
        cached = { counter, code };
        codes.set(account.id, cached);
      }
      if (currentEpoch !== epoch || !card.isConnected) return;
      const split = cached.code.length / 2;
      card.querySelector('[data-code]')!.textContent = `${cached.code.slice(0, split)} ${cached.code.slice(split)}`;
    }));
  } catch { if (currentEpoch === epoch) lock('无法计算验证码，请重新解锁；并检查设备时间。'); }
  finally { tickRunning = false; }
}
setInterval(() => { void tick(); }, 250);

function addDialog() {
  if (!session) return;
  if (session.data.accounts.length >= MAX_ACCOUNTS) { toast(`最多支持 ${MAX_ACCOUNTS} 个账号。`); return; }
  const modal = showDialog('添加账号', `<p class="muted modal-description">粘贴服务提供的验证器密钥，或完整 otpauth 链接。</p><form id="add-form"><label for="source">验证器密钥或 otpauth 链接</label><div class="secret-field"><input id="source" name="source" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="4096" placeholder="例如 JBSWY3DPEHPK3PXP" required /><button class="icon-button" type="button" id="toggle-secret" aria-label="显示密钥" aria-pressed="false">${icon('eye')}</button></div><label for="account-name">账号名称</label><input id="account-name" name="account-name" maxlength="128" placeholder="例如 work@example.com" required /><label for="issuer">服务名称 <span class="optional">选填</span></label><input id="issuer" name="issuer" maxlength="128" placeholder="例如 GitHub" /><details id="advanced"><summary>高级参数</summary><div class="parameters"><div><label for="algorithm">算法</label><select id="algorithm"><option value="SHA1">SHA-1</option><option value="SHA256">SHA-256</option><option value="SHA512">SHA-512</option></select></div><div><label for="digits">位数</label><select id="digits"><option value="6">6 位</option><option value="8">8 位</option></select></div><div><label for="period">周期（秒）</label><input id="period" type="number" min="1" max="300" step="1" value="30" required /></div></div></details>${errorRegion}<div class="modal-actions"><button class="button secondary" type="button" data-action="close">取消</button><button class="button primary" type="submit">添加账号</button></div></form>`);
  const form = modal.querySelector<HTMLFormElement>('form')!;
  const field = (id: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
  modal.querySelector('#toggle-secret')!.addEventListener('click', event => {
    const input = field('source') as HTMLInputElement;
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    const button = event.currentTarget as HTMLButtonElement;
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥');
  });
  field('source').addEventListener('input', () => {
    if (!/^otpauth:/i.test(field('source').value.trim())) return;
    try {
      const parsed = parseInput(field('source').value);
      field('account-name').value = parsed.name;
      field('issuer').value = parsed.issuer;
      field('algorithm').value = parsed.algorithm;
      field('digits').value = String(parsed.digits);
      field('period').value = String(parsed.period);
      (modal.querySelector('#advanced') as HTMLDetailsElement).open = parsed.algorithm !== 'SHA1' || parsed.digits !== 6 || parsed.period !== 30;
    } catch { /* Report full validation on submit so pasting remains uninterrupted. */ }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void action(async () => {
      if (!session) throw new SessionChanged();
      const parsed = parseInput(field('source').value);
      const parameters = validateParameters({ ...parsed, algorithm: field('algorithm').value as Algorithm, digits: Number(field('digits').value) as 6 | 8, period: Number(field('period').value) });
      const name = field('account-name').value.trim();
      if (!name) throw new Error('请填写账号名称。');
      const existing = session.data.accounts.find(a => a.secret === parameters.secret && a.algorithm === parameters.algorithm && a.digits === parameters.digits && a.period === parameters.period);
      if (existing) throw new Error(`这个密钥和参数已经添加为「${existing.name}」。`);
      const account: Account = { ...parameters, id: crypto.randomUUID(), name, issuer: field('issuer').value.trim() };
      await persist({ version: 1, accounts: [...session.data.accounts, account] });
      toast('账号已加密保存');
    }, form);
  });
}
function editDialog(id: string) {
  const account = session?.data.accounts.find(a => a.id === id);
  if (!account) return;
  const modal = showDialog('编辑账号', `<form><label for="edit-name">账号名称</label><input id="edit-name" maxlength="128" required value="${escape(account.name)}" /><label for="edit-issuer">服务名称 <span class="optional">选填</span></label><input id="edit-issuer" maxlength="128" value="${escape(account.issuer)}" /><p class="parameter-note">${account.algorithm.replace('SHA', 'SHA-')} · ${account.digits} 位 · 每 ${account.period} 秒更新</p>${errorRegion}<div class="modal-actions split"><button type="button" class="text-button danger-text" id="delete-account">删除账号</button><div><button type="button" class="button secondary" data-action="close">取消</button><button type="submit" class="button primary">保存</button></div></div></form>`);
  const form = modal.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    void action(async () => {
      if (!session) throw new SessionChanged();
      const name = form.querySelector<HTMLInputElement>('#edit-name')!.value.trim();
      const issuer = form.querySelector<HTMLInputElement>('#edit-issuer')!.value.trim();
      if (!name) throw new Error('请填写账号名称。');
      await persist({ version: 1, accounts: session.data.accounts.map(a => a.id === id ? { ...a, name, issuer } : a) });
      toast('账号已更新');
    }, form);
  });
  modal.querySelector('#delete-account')!.addEventListener('click', () => {
    const confirmation = showDialog('删除这个账号？', `<p class="muted">将从本机账号库中删除「${escape(account.name)}」。这不会解除服务端的两步验证，请确认你仍有其他验证方式。</p><form>${errorRegion}<div class="modal-actions"><button class="button secondary" type="button" data-action="close">取消</button><button class="button danger" type="submit">确认删除</button></div></form>`);
    const deleteForm = confirmation.querySelector<HTMLFormElement>('form')!;
    deleteForm.addEventListener('submit', event => {
      event.preventDefault();
      void action(async () => {
        if (!session) throw new SessionChanged();
        await persist({ version: 1, accounts: session.data.accounts.filter(a => a.id !== id) });
        toast('账号已删除');
      }, deleteForm);
    });
  });
}
function exportBackup() {
  if (!record) return;
  const blob = new Blob([JSON.stringify(record.envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `totp-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('加密备份已导出，请保留导出时使用的 PIN');
}
function backupDialog() {
  showDialog('备份与恢复', `<p class="muted">备份包含全部账号的加密数据，恢复时需要导出时使用的 PIN。</p><button class="backup-option" data-action="export">${icon('download')}<span><b>导出加密备份</b><small>保存到文件，方便换设备或浏览器</small></span>${icon('arrow')}</button><button class="backup-option" data-action="import">${icon('upload')}<span><b>从备份恢复</b><small>使用文件中的账号替换本机账号库</small></span>${icon('arrow')}</button><p class="small muted backup-note">修改 PIN 后，旧备份仍需要原来的 PIN。</p>`);
}
function importDialog() {
  const expected = record?.revision ?? null;
  const modal = showDialog('从加密备份恢复', `<p class="muted">选择本工具导出的 JSON 文件。恢复后，使用这份备份的 PIN 解锁。</p><form><label for="backup-file">加密备份文件</label><input id="backup-file" type="file" accept=".json,application/json" required />${pinField('backup-pin', '这份备份的 PIN')}${record ? '<label class="checkbox-label"><input type="checkbox" id="replace-confirm" required /><span>我确认用备份替换本机全部账号，现有账号不会合并。建议先导出当前备份。</span></label>' : ''}${errorRegion}<div class="modal-actions"><button type="button" class="button secondary" data-action="close">取消</button><button type="submit" class="button primary">恢复账号库</button></div></form>`);
  const form = modal.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    void action(async () => {
      const expectedEpoch = epoch;
      const file = form.querySelector<HTMLInputElement>('#backup-file')!.files?.[0];
      if (!file) throw new Error('请选择加密备份文件。');
      if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件不能大于 2 MB。');
      const pinInput = form.querySelector<HTMLInputElement>('#backup-pin')!;
      const pin = pinInput.value;
      pinInput.value = '';
      const envelope = parseBackup(await file.text());
      const opened = await openVault(pin, envelope);
      // Re-encrypt restored copies with a fresh salt/key and IV before local storage.
      const created = await createVault(pin, opened.data);
      if (expectedEpoch !== epoch) throw new SessionChanged();
      record = await writeVault(expected, created.envelope);
      notify();
      await installSession(opened.data, created.key, expectedEpoch);
      toast(`已恢复 ${opened.data.accounts.length} 个账号`);
    }, form);
  });
}
function settingsDialog() {
  if (!session) return;
  showDialog('账号库设置', '<p class="muted">每次刷新或关闭页面后锁定，使用期间保持解锁。</p><button class="backup-option" data-action="change-pin"><span><b>修改解锁 PIN</b><small>重新加密当前浏览器里的账号库</small></span></button><button class="text-button danger-text reset-link" data-action="reset">清空本机数据</button>');
}
function changePinDialog() {
  if (!session || !record) return;
  const modal = showDialog('修改解锁 PIN', `<p class="muted">新 PIN 只影响当前账号库。请在修改后重新导出备份。</p><form>${pinField('old-pin', '当前 PIN')}${pinField('new-pin', '新 PIN', 'new-password')}${pinField('new-confirm', '再次输入新 PIN', 'new-password')}${errorRegion}<div class="modal-actions"><button type="button" class="button secondary" data-action="close">取消</button><button type="submit" class="button primary">修改 PIN</button></div></form>`);
  const form = modal.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    void action(async () => {
      if (!session || !record) throw new SessionChanged();
      const expectedEpoch = epoch;
      const expected = record.revision;
      const input = (id: string) => form.querySelector<HTMLInputElement>(`#${id}`)!;
      const oldPin = input('old-pin').value;
      const newPin = input('new-pin').value;
      const confirm = input('new-confirm').value;
      form.querySelectorAll('input').forEach(element => { element.value = ''; });
      if (newPin !== confirm) throw new Error('两次输入的新 PIN 不一致。');
      await openVault(oldPin, record.envelope);
      if (epoch !== expectedEpoch || !session) throw new SessionChanged();
      const data = session.data;
      const created = await createVault(newPin, data);
      if (epoch !== expectedEpoch) throw new SessionChanged();
      record = await writeVault(expected, created.envelope);
      notify();
      await installSession(data, created.key, expectedEpoch);
      toast('PIN 已修改，请重新导出备份');
    }, form);
  });
}
function resetDialog() {
  if (!record) return;
  const expected = record.revision;
  const modal = showDialog('清空本机数据', `<p class="muted">将永久删除当前浏览器保存的全部 TOTP 账号和 PIN 设置。请先确认已有备份或其他验证方式。</p><form><label for="reset-confirm">输入「清空」确认</label><input id="reset-confirm" required autocomplete="off" placeholder="清空" />${errorRegion}<div class="modal-actions"><button type="button" class="button secondary" data-action="close">取消</button><button type="submit" class="button danger">清空本机数据</button></div></form>`);
  const form = modal.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    void action(async () => {
      if (form.querySelector<HTMLInputElement>('#reset-confirm')!.value !== '清空') throw new Error('请输入「清空」两个字。');
      record = await writeVault(expected, null);
      notify();
      lock('本机账号库已清空');
    }, form);
  });
}
document.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]');
  if (!button) return;
  const command = button.dataset.action;
  if (command === 'close') { if (!busy) closeDialog(); return; }
  if (command === 'lock') { lock('账号库已锁定'); return; }
  if (busy) return;
  if (command === 'add') addDialog();
  if (command === 'edit') editDialog(button.dataset.id!);
  if (command === 'backup') backupDialog();
  if (command === 'export') exportBackup();
  if (command === 'import') importDialog();
  if (command === 'settings') settingsDialog();
  if (command === 'change-pin') changePinDialog();
  if (command === 'reset') resetDialog();
  if (command === 'copy') {
    const currentEpoch = epoch;
    const account = session?.data.accounts.find(a => a.id === button.dataset.id);
    if (!account || !session) return;
    const key = session.keys.get(account.id)!;
    void action(async () => {
      // Calculate at click time, instead of copying a code cached before a boundary.
      let now = Date.now();
      let code = await codeAt(key, account, now);
      if (Math.floor(now / 1000 / account.period) !== Math.floor(Date.now() / 1000 / account.period)) {
        now = Date.now(); code = await codeAt(key, account, now);
      }
      if (epoch !== currentEpoch) throw new SessionChanged();
      try { await navigator.clipboard.writeText(code); toast('验证码已复制'); }
      catch { throw new Error('浏览器未允许复制，请选中验证码手动复制。'); }
    });
  }
});

function setupTheme() {
  let theme = 'light';
  try { theme = (localStorage.getItem('neil-homepage:theme') || localStorage.getItem('theme')) === 'dark' ? 'dark' : 'light'; } catch { /* Storage may be disabled. */ }
  const button = document.querySelector<HTMLButtonElement>('#theme-toggle')!;
  function apply() {
    document.documentElement.dataset.theme = theme;
    button.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    button.setAttribute('aria-label', theme === 'dark' ? '切换浅色主题' : '切换深色主题');
  }
  apply();
  button.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('neil-homepage:theme', theme); } catch { /* The current page still changes. */ }
    apply();
  });
  window.addEventListener('storage', event => {
    if (event.key === 'neil-homepage:theme' && (event.newValue === 'dark' || event.newValue === 'light')) {
      theme = event.newValue; apply();
    }
  });
}
setupTheme();
async function boot() {
  try {
    if (!window.isSecureContext || !crypto.subtle || !window.indexedDB) throw new Error('需要在 HTTPS 或 localhost 环境中使用，并允许浏览器本地存储。');
    record = await readVault();
    render();
  } catch (error) {
    root.innerHTML = `<section class="fatal"><div class="gate-icon">${icon('lock')}</div><h1>暂时无法打开账号库</h1><p class="muted">${escape(error instanceof Error ? error.message : '请稍后重试。')}</p><button id="retry" class="button primary">重新尝试</button></section>`;
    root.querySelector('#retry')!.addEventListener('click', () => { void boot(); });
  }
}
void boot();
