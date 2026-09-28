/**
 * UI language: English or Simplified Chinese. Text is written in English in the code and
 * wrapped in t(); the Chinese strings live in ZH below, keyed by the English text. Missing
 * entries fall back to English (a test checks that every t() literal has one).
 *
 * Bot-facing text stays English on purpose: static-check findings and bot-log messages are
 * meant to be pasted back to the AI that wrote the bot.
 */

export type Lang = 'en' | 'zh';

const LANG_KEY = 'harena.lang';

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    // No storage: fall through to the browser language.
  }
  return typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language) ? 'zh' : 'en';
}

let current: Lang = detectLang();

export function getLang(): Lang {
  return current;
}

/** Mark the page's language (screen readers, fonts, spell checking). */
export function applyLang(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
}

/** Switch and remember the language; pages mounted afterwards use it. */
export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not remembered; lasts until the page reloads.
  }
  applyLang();
}

/** Locale for dates and numbers: Chinese, or the browser's own for English. */
export function locale(): string | undefined {
  return current === 'zh' ? 'zh-CN' : undefined;
}

/** Translate `text` and fill `{name}` placeholders from `params`. */
export function t(text: string, params?: Record<string, string | number>): string {
  const template = current === 'zh' ? ZH[text] ?? text : text;
  return params ? template.replace(/\{(\w+)\}/g, (m, key: string) => (key in params ? String(params[key]) : m)) : template;
}

export const ZH: Record<string, string> = {
  // Setup page
  'bot arena': 'AI 机器人竞技场',
  'Load replay…': '打开回放…',
  'Open a replay .json file': '打开一个回放 .json 文件',
  'Get a bot from any AI chat': '让任意 AI 帮你写一个机器人',
  '📋 Copy AI prompt': '📋 复制 AI 提示词',
  'and paste it into ChatGPT, DeepSeek, Doubao, Claude, Gemini…': '然后粘贴到豆包、DeepSeek、ChatGPT、Claude、Gemini 等任意 AI 聊天里',
  'Copied ✓': '已复制 ✓',
  "Copy the AI's whole reply.": '复制 AI 的完整回复。',
  '+ Add bot': '+ 添加机器人',
  'and paste it in.': '然后把回复粘贴进去。',
  'Optional: if the AI can run code, also give it the <a href="harena-sim.mjs" download>test kit</a> (the real engine in one file) so it can try its bot first.':
    '可选：如果 AI 能运行代码，可以把<a href="harena-sim.mjs" download>测试包</a>（单文件的真实引擎）也发给它，让它先自己测一测。',
  Bots: '机器人',
  'Other players': '其他玩家',
  '+ You (keyboard)': '+ 你自己（键盘）',
  '+ Dummy': '+ 假人',
  Match: '对局',
  Map: '地图',
  'Coloured dots: where each player starts with this seed.': '彩色圆点：在当前种子下每位玩家的出生位置。',
  Seed: '种子',
  'Random seed': '随机种子',
  'Time limit (s)': '时间限制（秒）',
  'Shrinking safe zone (from {s}s)': '安全区缩圈（第 {s} 秒开始）',
  'Debug rules (99 lives, cheat keys)': '调试规则（99 条命、作弊键）',
  Players: '玩家',
  'Start match': '开始对局',
  'reviewed ✓': '已审查 ✓',
  'review: warning': '审查：有警告',
  'review: danger': '审查：危险',
  blocked: '已拦截',
  'review failed': '审查失败',
  'changed since review': '审查后已修改',
  'not reviewed': '未审查',
  'checked ✓': '已检查 ✓',
  'reviewing…': '审查中…',
  'Passed the static check. Bots you add are not AI-reviewed.': '已通过静态检查。你添加的机器人不做 AI 审查。',
  'Click to rename': '点击改名',
  'saved in this browser': '保存在本浏览器',
  'renamed from {name}': '原名 {name}',
  Edit: '编辑',
  'Change the code or name': '修改代码或名字',
  'Delete from this browser': '从本浏览器删除',
  Review: '审查',
  'Static check + Jev AI review': '静态检查 + Jev AI 审查',
  '+ Add': '+ 加入',
  follows: '符合',
  partial: '部分符合',
  broken: '不符合',
  'quality {q}/{max} · interface: {i} · {date}': '质量 {q}/{max} · 接口：{i} · {date}',
  'No bots yet. Add one above, or put <code>.js</code> files in <code>bots/</code>.': '还没有机器人。在上方添加一个，或把 <code>.js</code> 文件放进 <code>bots/</code>。',
  'Delete "{name}" from this browser? This can\'t be undone.': '要从本浏览器删除“{name}”吗？删除后无法恢复。',
  'Review of {file} failed: {error}': '{file} 审查失败：{error}',
  'Could not open {file}: {error}': '无法打开 {file}：{error}',
  You: '你',
  'keyboard + mouse': '键盘 + 鼠标',
  '{kind} dummy': '{kind}假人',
  'scripted test opponent': '脚本控制的测试对手',
  'your bot': '你的机器人',
  Remove: '移除',
  'Add bots from the list.': '从左侧列表添加机器人。',
  'Add at least {n} player.': '至少需要 {n} 名玩家。',
  'Add at least {n} players (or enable debug rules to play alone).': '至少需要 {n} 名玩家（或开启调试规则单人游玩）。',
  idle: '木桩',
  strafe: '横移',
  brawler: '近战',
  shooter: '射手',
  Corridors: '走廊',
  Blockyard: '方块场',
  'Open Field': '开阔地',
  Duel: '决斗场',

  // Add-bot dialog
  'Add a bot': '添加机器人',
  'Edit bot': '编辑机器人',
  "Paste the AI's reply (the code block is picked out automatically) or the bot's code, or load a <code>.js</code> file. The bot is saved in this browser only.":
    '粘贴 AI 的回复（会自动提取其中的代码块）或机器人代码，也可以选择一个 <code>.js</code> 文件。机器人只保存在本浏览器里。',
  Name: '名字',
  'taken from the code': '从代码中读取',
  'Paste the bot code here…': '把机器人代码粘贴到这里…',
  'Load .js file…': '选择 .js 文件…',
  Cancel: '取消',
  Save: '保存',
  "⛔ This bot can't play yet:": '⛔ 这个机器人暂时不能上场：',
  '📋 Copy a fix request for the AI': '📋 复制给 AI 的修复请求',
  'Copied. Paste it into the AI chat.': '已复制，粘贴到 AI 聊天里即可。',
  '✓ Passes the static check.': '✓ 通过静态检查。',
  '✓ Passes the static check (with warnings).': '✓ 通过静态检查（有警告）。',
  'Fix request': '修复请求',
  'AI prompt': 'AI 提示词',
  'The browser blocked automatic copying. Select all the text below (Ctrl/⌘ + A) and copy it (Ctrl/⌘ + C).':
    '浏览器阻止了自动复制。请全选下面的文字（Ctrl/⌘ + A）再复制（Ctrl/⌘ + C）。',
  Close: '关闭',
  'This browser would not store the bot (storage is full or disabled, e.g. in a private window).':
    '浏览器无法保存这个机器人（存储空间已满或被禁用，例如无痕模式）。',

  // Arena pages
  '← Setup': '← 设置',
  Pause: '暂停',
  Resume: '继续',
  Step: '单步',
  Restart: '重开',
  'Debug (F3)': '调试 (F3)',
  REPLAY: '回放',
  'Bot log': '机器人日志',
  'All bots': '全部机器人',
  'No messages yet.': '暂无消息。',
  'starting bots…': '正在启动机器人…',
  'seed {seed}': '种子 {seed}',
  'no time limit': '无时间限制',
  'no zone': '无缩圈',
  'debug rules': '调试规则',
  'tick {tick} · {time}s': '第 {tick} 帧 · {time} 秒',
  ' · {s}s left': ' · 剩余 {s} 秒',
  'tick {tick} / {total}': '第 {tick} / {total} 帧',
  'recorded {date}': '录制于 {date}',
  keyboard: '键盘',
  'dummy: {kind}': '假人：{kind}',
  'human player': '真人玩家',
  '<b>WASD</b> move · <b>mouse</b> aim · <b>click/Space</b> attack<br /><b>1/2/3/4</b> knife/gun/launcher/laser · <b>Q</b> next weapon · <b>E/right click</b> mine · <b>F/C</b> throw smoke/gas to the cursor<br />':
    '<b>WASD</b> 移动 · <b>鼠标</b> 瞄准 · <b>左键/空格</b> 攻击<br /><b>1/2/3/4</b> 匕首/枪/榴弹/激光 · <b>Q</b> 切换武器 · <b>E/右键</b> 地雷 · <b>F/C</b> 往鼠标处丢烟雾弹/毒气弹<br />',
  '<b>P</b> pause · <b>N</b> step · <b>[ ]</b> speed · <b>R</b> restart · <b>F3</b> debug':
    '<b>P</b> 暂停 · <b>N</b> 单步 · <b>[ ]</b> 调速 · <b>R</b> 重开 · <b>F3</b> 调试',
  '<br />Cheats: <b>G</b> all weapons + ammo + mines · <b>H</b> heal + shield': '<br />作弊：<b>G</b> 全武器 + 弹药 + 地雷 · <b>H</b> 回血 + 护盾',
  '<b>P</b> pause · <b>N</b> step · <b>[ ]</b> speed · <b>← →</b> seek 5s · <b>R</b> restart · <b>F3</b> debug':
    '<b>P</b> 暂停 · <b>N</b> 单步 · <b>[ ]</b> 调速 · <b>← →</b> 前后 5 秒 · <b>R</b> 重开 · <b>F3</b> 调试',
  '🎬 Export video': '🎬 导出视频',
  'Render this replay to a video file': '把这段回放渲染成视频文件',
  '⚠ Desync at tick {tick}: the re-simulation no longer matches the recording (engine or config changed since it was recorded?).':
    '⚠ 第 {tick} 帧不同步：重新模拟的结果与录制不一致（录制之后引擎或规则改过？）。',
  'Checksums match the recording so far.': '目前为止校验值与录制一致。',
  '{n} debug cheat(s) recorded': '录制了 {n} 次调试作弊',

  // HUD
  eliminated: '已淘汰',
  'respawn in {s}s': '{s} 秒后复活',
  invulnerable: '无敌',
  knife: '匕首',
  gun: '枪',
  launcher: '榴弹',
  laser: '激光',
  mines: '地雷',
  lives: '生命',
  ' · zone shrinks in {s}s': ' · {s} 秒后开始缩圈',
  ' · zone shrinking': ' · 正在缩圈',
  ' · zone collapses in {s}s': ' · {s} 秒后最终收缩',
  ' · zone collapsing': ' · 最终收缩中',
  ' · zone closed': ' · 安全区已消失',
  ' blew themselves up': ' 把自己炸死了',
  ' was caught outside the zone': ' 死在了安全区外',
  ' was hit by their own laser': ' 被自己的激光打死了',
  ' died': ' 死了',
  ' is eliminated': ' 被淘汰',

  // Results
  'Time limit reached': '时间到',
  'Everyone is out': '全员出局',
  'Last one standing': '最后的幸存者',
  '🏆 {name} wins': '🏆 {name} 获胜',
  'Draw: {names}': '平局：{names}',
  '{s}s': '{s} 秒',
  'out at {s}s': '第 {s} 秒出局',
  'Hide (look at the final state)': '隐藏（查看最终局面）',
  Player: '玩家',
  Result: '结果',
  K: '杀',
  D: '死',
  kills: '击杀',
  deaths: '死亡',
  Dealt: '输出',
  Taken: '承伤',
  'damage dealt': '造成的伤害',
  'damage taken': '受到的伤害',
  'Gun acc.': '枪命中率',
  'gun accuracy': '枪的命中率',
  Knife: '匕首',
  Grenades: '榴弹',
  Laser: '激光',
  'laser hits / shots': '激光命中 / 发射数',
  Mines: '地雷',
  Items: '道具',
  Bot: '程序',
  'bot sandbox: average decide() time or failures': '机器人沙箱：decide() 平均耗时或失败次数',
  '{hit} / {fired} bullets': '{hit} / {fired} 发子弹',
  'swings that hit / swings': '命中次数 / 挥刀次数',
  'grenades that hurt an enemy / fired': '伤到敌人的榴弹 / 发射数',
  none: '无',
  '⚠ {n} fails': '⚠ 失败 {n} 次',
  '⚠ {n} fail': '⚠ 失败 {n} 次',
  'timeouts {t}, errors {e}, invalid {i}, restarts {r}, max {max} ms': '超时 {t}，报错 {e}，无效 {i}，重启 {r}，最长 {max} 毫秒',
  '▶ Watch replay': '▶ 观看回放',
  '⬇ Download replay': '⬇ 下载回放',
  'Rematch (same seed)': '再来一局（同种子）',
  'Rematch (new seed)': '再来一局（新种子）',
  'Back to setup': '返回设置',

  // Video export
  'Export video': '导出视频',
  '1920×1080 video of this replay with a title card and final results, rendered in your browser. MP4 (H.264) plays everywhere and can be uploaded to video sites.':
    '把这段回放导出为 1920×1080 视频，包含片头和最终结算，在你的浏览器里渲染。MP4（H.264）格式到处都能播放，可以直接上传到视频网站。',
  'Speed up quiet stretches (4× when nobody lands a hit)': '冷场快进（没人命中时 4 倍速）',
  Export: '导出',
  'Preparing…': '准备中…',
  'Rendering frame {done} / {total} ({pct}%)': '正在渲染第 {done} / {total} 帧（{pct}%）',
  'Saved {name} · {s} s long · {mb} MB · rendered in {took} s': '已保存 {name} · 时长 {s} 秒 · {mb} MB · 用时 {took} 秒',
  'Cancelled.': '已取消。',
  'Export failed: {error}': '导出失败：{error}',
  'This browser cannot encode video. Use a recent Chrome, Edge or Safari.': '这个浏览器无法编码视频，请使用较新的 Chrome、Edge 或 Safari。',
  'HARENA · AI BOT ARENA': 'HARENA · AI 机器人竞技场',
  'KILL FEED': '击杀播报',
  ' shot ': ' 击毙了 ',
  ' knifed ': ' 刀杀了 ',
  ' blew up ': ' 炸死了 ',
  ' lasered ': ' 用激光击杀了 ',
  '{time} time limit': '时间限制 {time}',
  'Everyone eliminated': '全员出局',
  'Time limit': '时间到',
  ' wins': ' 获胜',
  Draw: '平局',
  PLAYER: '玩家',
  RESULT: '结果',
  KILLS: '击杀',
  DEATHS: '死亡',
  DAMAGE: '伤害',
  'out at {time}': '{time} 出局',
  '♥ {lives} · {hp} hp': '♥ {lives} · {hp} 血',
  'mines {n}': '地雷 {n}',
  'smoke {n}': '烟雾 {n}',
  'gas {n}': '毒气 {n}',
  ' choked on their own gas': ' 被自己的毒气毒死了',
  ' gassed ': ' 用毒气毒死了 ',
};
