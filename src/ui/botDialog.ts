import { staticCheck } from '../review/staticCheck.ts';
import { extractBotCode, fixRequest } from './botCode.ts';
import { readMeta, saveLocalBot, type BotEntry } from './bots.ts';
import { t } from './i18n.ts';

/** Everything an AI needs to write a bot: the task, then the full BOT_API.md. */
export async function botPrompt(): Promise<string> {
  const { default: spec } = await import('../../BOT_API.md?raw');
  return [
    'Write a bot for Harena, a top-down 2D arena game where bots written by different AIs fight each other.',
    'The complete specification is below, between <spec> tags. Read all of it, then write the strongest bot you can.',
    '',
    'Requirements:',
    '- Reply with ONE complete JavaScript file in a single ```js code block.',
    '- Export init(info) and decide(state) exactly as the spec describes, plus meta = { name, author } with your own model name as the author.',
    '- No imports, network, timers or async code. decide() must stay well within the time budget.',
    '',
    '<spec>',
    spec,
    '</spec>',
  ].join('\n');
}

/** Copy text to the clipboard; false when the browser refuses (then show it for manual copying). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Modal showing a long text to copy by hand (clipboard access denied). */
export function openCopyFallback(title: string, text: string): void {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `
    <div class="modal wide" role="dialog" aria-label="${escapeHtml(title)}">
      <h2>${escapeHtml(title)}</h2>
      <p class="muted">${t('The browser blocked automatic copying. Select all the text below (Ctrl/⌘ + A) and copy it (Ctrl/⌘ + C).')}</p>
      <textarea class="code-input" readonly></textarea>
      <div class="modal-actions"><button class="primary">${t('Close')}</button></div>
    </div>`;
  document.body.appendChild(root);
  const area = root.querySelector('textarea')!;
  area.value = text;
  area.focus();
  area.select();
  root.querySelector('button')!.onclick = () => root.remove();
  root.addEventListener('keydown', (e) => e.stopPropagation());
}

/**
 * Modal to add a bot by pasting code (or a whole AI reply) or picking a .js file, or to
 * edit a bot saved in this browser. The static check runs as you type.
 */
export function openBotEditor(existing: BotEntry | null, onSaved: (bot: BotEntry) => void): void {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  const title = existing ? t('Edit bot') : t('Add a bot');
  root.innerHTML = `
    <div class="modal wide" role="dialog" aria-label="${title}">
      <h2>${title}</h2>
      <p class="muted">${t("Paste the AI's reply (the code block is picked out automatically) or the bot's code, or load a <code>.js</code> file. The bot is saved in this browser only.")}</p>
      <label class="field">${t('Name')} <input type="text" id="bot-name" maxlength="40" placeholder="${t('taken from the code')}" /></label>
      <textarea class="code-input" id="bot-code" spellcheck="false" placeholder="${t('Paste the bot code here…')}"></textarea>
      <div id="bot-check" class="bot-check"></div>
      <div class="modal-actions">
        <button id="bot-file-btn" class="left">${t('Load .js file…')}</button>
        <input type="file" id="bot-file" accept=".js,.mjs,.txt,text/javascript,text/plain" hidden />
        <button id="bot-cancel">${t('Cancel')}</button>
        <button id="bot-save" class="primary">${existing ? t('Save') : t('+ Add bot')}</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const nameInput = $<HTMLInputElement>('bot-name');
  const codeInput = $<HTMLTextAreaElement>('bot-code');
  const check = $('bot-check');
  const save = $<HTMLButtonElement>('bot-save');
  const fileInput = $<HTMLInputElement>('bot-file');
  if (existing) {
    nameInput.value = existing.name;
    codeInput.value = existing.source;
  }

  const close = () => root.remove();
  $('bot-cancel').onclick = close;
  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep game shortcuts out
    if (e.key === 'Escape') close();
  });

  /** Re-run the static check and show what the bot would be listed as. */
  const update = () => {
    const code = extractBotCode(codeInput.value);
    save.disabled = code === '';
    if (code === '') {
      check.innerHTML = '';
      return;
    }
    nameInput.placeholder = readMeta(code, 'name') ?? t('taken from the code');
    const result = staticCheck(code);
    const errors = result.findings.filter((f) => f.severity === 'error').map((f) => `${f.message}${f.line ? ` (line ${f.line})` : ''}`);
    const warnings = result.findings.filter((f) => f.severity === 'warning').map((f) => `${f.message}${f.line ? ` (line ${f.line})` : ''}`);
    check.innerHTML = errors.length
      ? `<div class="bad">${t("⛔ This bot can't play yet:")}</div>${errors.map((e) => `<div>· ${escapeHtml(e)}</div>`).join('')}
         <div class="fix-row"><button id="copy-fix">${t('📋 Copy a fix request for the AI')}</button> <span class="muted" id="fix-status"></span></div>`
      : `<div class="good">${warnings.length ? t('✓ Passes the static check (with warnings).') : t('✓ Passes the static check.')}</div>${warnings.map((w) => `<div class="muted">⚠ ${escapeHtml(w)}</div>`).join('')}`;
    const copyFix = root.querySelector<HTMLButtonElement>('#copy-fix');
    if (copyFix) {
      copyFix.onclick = async () => {
        const text = fixRequest(errors);
        if (await copyText(text)) root.querySelector('#fix-status')!.textContent = t('Copied. Paste it into the AI chat.');
        else openCopyFallback(t('Fix request'), text);
      };
    }
  };
  codeInput.oninput = update;

  $('bot-file-btn').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    codeInput.value = await file.text();
    update();
  };

  save.onclick = () => {
    const code = extractBotCode(codeInput.value);
    if (!code) return;
    try {
      onSaved(saveLocalBot(nameInput.value, code, existing?.file));
      close();
    } catch (err) {
      check.insertAdjacentHTML('afterbegin', `<div class="bad">${escapeHtml((err as Error).message)}</div>`);
    }
  };

  update();
  requestAnimationFrame(() => (existing ? nameInput : codeInput).focus());
}
