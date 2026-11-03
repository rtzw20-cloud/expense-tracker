import { parseAmount, parseDate, planImport, toCSV } from './parser.js';
import { createVault, decrypt, encrypt, unlockVault } from './crypto.js';
import * as db from './db.js';

const MIN_PASSCODE_LENGTH = 6;
const UNNAMED = '未填写';

const state = { key: null, entries: [], month: '' };
const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('expense-tracker') : null;
let toastTimer;

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const money = (cents) => `RM ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Local-time parts on purpose: toISOString() would give the wrong day in UTC+8.
const monthOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const nowLocal = (d = new Date()) => `${monthOf(d)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const monthEntries = () => state.entries.filter((e) => e.date.startsWith(state.month));

// All user data reaches the DOM through textContent, never as markup.
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

const safely = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (error) {
    console.error(error);
    toast(`操作失败:${error.message}`);
  }
};

/* ---------- Auth ---------- */

async function showAuth() {
  const isSetup = !(await db.getMeta('auth'));
  $('boot').hidden = true;
  $('app').hidden = true;
  $('auth').hidden = false;
  $('auth-error').textContent = '';
  $('auth-hint').textContent = isSetup
    ? `首次使用,请设置至少 ${MIN_PASSCODE_LENGTH} 位密码。密码用于加密数据,忘记后无法恢复。`
    : '请输入密码解锁。';
  $('auth-submit').textContent = isSetup ? '设置密码' : '解锁';
  $('confirm-row').hidden = !isSetup;
  $('passcode-confirm').required = isSetup;
  $('passcode').autocomplete = isSetup ? 'new-password' : 'current-password';
  $('passcode').focus();
}

async function submitAuth(event) {
  event.preventDefault();
  const passcode = $('passcode').value;
  const auth = await db.getMeta('auth');
  const fail = (message) => { $('auth-error').textContent = message; };

  if (!auth) {
    if ([...passcode].length < MIN_PASSCODE_LENGTH) return fail(`密码至少需要 ${MIN_PASSCODE_LENGTH} 位`);
    if (passcode !== $('passcode-confirm').value) return fail('两次输入的密码不一致');
  }
  $('auth-submit').disabled = true;
  $('auth-error').textContent = '';
  try {
    if (auth) {
      state.key = await unlockVault(passcode, auth);
      if (!state.key) {
        $('passcode').select();
        return fail('密码错误');
      }
    } else {
      const vault = await createVault(passcode);
      await db.setMeta('auth', vault.auth);
      state.key = vault.key;
      navigator.storage?.persist?.(); // Ask the browser not to evict the data.
    }
  } finally {
    $('auth-submit').disabled = false;
  }
  $('auth-form').reset();
  state.month = monthOf(new Date());
  $('auth').hidden = true;
  $('app').hidden = false;
  await reload();
}

async function lock() {
  state.key = null;
  state.entries = [];
  $('entry-dialog').close();
  for (const id of ['report', 'total', 'count', 'chart', 'daily-table', 'by-merchant', 'by-card', 'list']) {
    $(id).replaceChildren();
  }
  $('report').hidden = true;
  $('corrupt').hidden = true;
  $('daily-details').open = false;
  $('entry-form').reset();
  await showAuth();
}

/* ---------- Data ---------- */

async function reload() {
  const results = await Promise.allSettled((await db.allEntries()).map((r) => decrypt(state.key, r)));
  const entries = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  state.entries = entries.sort((a, b) => b.date.localeCompare(a.date));
  const unreadable = results.length - entries.length;
  $('corrupt').hidden = !unreadable;
  $('corrupt').textContent = unreadable ? `有 ${unreadable} 条记录无法解密,可能已损坏。` : '';
  render();
}

async function saveEntry(entry) {
  await db.putEntry(await encrypt(state.key, entry.id, entry));
  await reload();
}

async function loadSeen() {
  const record = await db.getMeta('seen');
  return new Set(record ? await decrypt(state.key, record) : []);
}

async function runImport(file) {
  const text = await file.text();
  // The lock stops two tabs overwriting each other's dedupe set.
  const withLock = navigator.locks
    ? (fn) => navigator.locks.request('expense-import', fn)
    : (fn) => fn();
  const { plan, newest } = await withLock(async () => {
    const seen = await loadSeen();
    const planned = await planImport(text, seen);
    const records = await Promise.all(planned.rows.map(({ key, entry }) => {
      seen.add(key);
      const id = crypto.randomUUID();
      return encrypt(state.key, id, { ...entry, id, source: 'import' });
    }));
    if (records.length) await db.commitImport(records, await encrypt(state.key, 'seen', [...seen]));
    return { plan: planned, newest: planned.rows.map((r) => r.entry.date).sort().at(-1) };
  });
  if (newest) state.month = newest.slice(0, 7); // Otherwise new rows may be off-screen.
  await reload();
  renderReport(plan);
}

function renderReport({ rows, skipped, failed }) {
  const summary = el('p', { className: 'report-summary' }, `新增 ${rows.length} 条 · 跳过 ${skipped} 条 · 失败 ${failed.length} 条`);
  const children = [summary];
  if (failed.length) {
    children.push(el('details', {},
      el('summary', {}, '查看失败的行'),
      el('ul', { className: 'failed' }, ...failed.map((f) => el('li', {}, `第 ${f.line} 行(${f.error}):${f.raw}`)))));
  }
  $('report').replaceChildren(...children);
  $('report').hidden = false;
}

async function exportCSV() {
  const name = `expenses-${nowLocal().slice(0, 10)}.csv`;
  const file = new File([toCSV(state.entries)], name, { type: 'text/csv;charset=utf-8' });
  // In an installed iOS app the share sheet is the dependable way to save a file.
  if (matchMedia('(display-mode: standalone)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
    return;
  }
  const url = URL.createObjectURL(file);
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(`已导出 ${state.entries.length} 条记录`);
}

async function wipeAll() {
  const answer = prompt('此操作将永久删除全部记录和密码,且无法恢复。\n如确认,请输入“清除”:');
  if (answer === null) return;
  if (answer.trim() !== '清除') return toast('输入不匹配,未清除任何数据');
  await db.wipe();
  tabs?.postMessage('lock');
  await lock();
  toast('全部数据已清除');
}

/* ---------- Rendering ---------- */

function render() {
  const entries = monthEntries();
  const total = entries.reduce((sum, e) => sum + e.cents, 0);
  $('month').value = state.month;
  $('total').textContent = money(total);
  $('count').textContent = `共 ${entries.length} 笔`;
  renderBreakdown($('by-merchant'), entries, 'merchant');
  renderBreakdown($('by-card'), entries, 'card');
  renderChart();
  renderList(entries);
}

function renderBreakdown(container, entries, field) {
  const totals = new Map();
  for (const e of entries) {
    const name = e[field] || UNNAMED;
    totals.set(name, (totals.get(name) ?? 0) + e.cents);
  }
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return container.replaceChildren(el('p', { className: 'muted' }, '暂无数据'));
  const max = ranked[0][1];
  container.replaceChildren(...ranked.map(([name, cents]) => {
    const fill = el('div', { className: 'meter-fill' });
    fill.style.width = `${(cents / max) * 100}%`;
    return el('div', { className: 'breakdown-row' },
      el('span', { className: 'name' }, name),
      el('span', { className: 'num' }, money(cents)),
      el('div', { className: 'meter' }, fill));
  }));
}

function renderList(entries) {
  if (!entries.length) return $('list').replaceChildren(el('li', { className: 'muted' }, '本月暂无记录'));
  $('list').replaceChildren(...entries.map((e) => el('li', {},
    el('div', { className: 'item-main' },
      el('span', { className: 'name' }, e.merchant || UNNAMED),
      el('span', { className: 'muted' }, `${e.date.slice(5)}${e.card ? ` · ${e.card}` : ''}`)),
    el('span', { className: 'num' }, money(e.cents)),
    el('div', { className: 'item-actions' },
      el('button', { className: 'small', onclick: () => openEntryDialog(e) }, '编辑'),
      el('button', { className: 'small', onclick: safely(() => removeEntry(e)) }, '删除')))));
}

// Picks a 1/2/5 x 10^n step in sen giving about three gridlines.
function niceStep(max) {
  const rough = Math.max(max / 3, 1);
  const base = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((m) => m * base).find((s) => s >= rough);
}

function tickLabel(cents) {
  const value = cents / 100;
  return value >= 10_000 ? `${value / 1000}K` : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function barPath(x, y, width, baseline) {
  const r = Math.min(4, width / 2, baseline - y);
  return `M${x} ${baseline}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + width - r}Q${x + width} ${y} ${x + width} ${y + r}V${baseline}Z`;
}

function renderChart() {
  const box = $('chart');
  const [year, month] = state.month.split('-').map(Number);
  const days = new Date(year, month, 0).getDate();
  const daily = Array(days).fill(0);
  for (const e of monthEntries()) daily[Number(e.date.slice(8, 10)) - 1] += e.cents;
  const label = (i) => `${month}月${i + 1}日`;

  $('daily-table').replaceChildren(...daily.flatMap((cents, i) => (cents
    ? [el('tr', {}, el('td', {}, label(i)), el('td', { className: 'num' }, money(cents)))]
    : [])));

  const peak = Math.max(...daily);
  const width = box.clientWidth;
  if (!peak) return box.replaceChildren(el('p', { className: 'muted' }, '本月暂无支出'));
  if (!width) return;

  const height = 200;
  const left = 44, right = 4, top = 22, bottom = 22;
  const baseline = height - bottom;
  const band = (width - left - right) / days;
  const barWidth = Math.min(24, Math.max(band - 2, 2));
  const step = niceStep(peak);
  const ceiling = Math.ceil(peak / step) * step;
  const yOf = (cents) => baseline - (cents / ceiling) * (baseline - top);
  const xOf = (i) => left + i * band + (band - barWidth) / 2;
  const peakDay = daily.indexOf(peak);

  const chart = svg('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`, tabindex: 0, role: 'img',
    'aria-label': `每日支出柱状图。最高 ${label(peakDay)},${money(peak)}。可用左右方向键查看,完整数据见下方每日明细。`,
  });

  for (let v = 0; v <= ceiling; v += step) {
    chart.append(
      svg('line', { x1: left, x2: width - right, y1: yOf(v), y2: yOf(v), class: v ? 'grid' : 'axis' }),
      svg('text', { x: left - 6, y: yOf(v) + 4, 'text-anchor': 'end', class: 'tick' }, tickLabel(v)),
    );
  }

  const hoverBand = svg('rect', { y: top, width: band, height: baseline - top, class: 'hover-band', visibility: 'hidden' });
  chart.append(hoverBand);

  daily.forEach((cents, i) => {
    if (cents) chart.append(svg('path', { d: barPath(xOf(i), Math.min(yOf(cents), baseline - 1), barWidth, baseline), class: 'bar' }));
    const day = i + 1;
    if (day === 1 || day % 5 === 0 || day === days) {
      chart.append(svg('text', { x: xOf(i) + barWidth / 2, y: height - 6, 'text-anchor': 'middle', class: 'tick' }, day));
    }
  });

  // Only the peak gets a direct label; the tooltip and the table carry the rest.
  const peakX = Math.min(Math.max(xOf(peakDay) + barWidth / 2, left + 30), width - 34);
  chart.append(svg('text', { x: peakX, y: yOf(peak) - 6, 'text-anchor': 'middle', class: 'peak' }, money(peak)));

  const tooltip = el('div', { className: 'tooltip', hidden: true });
  let current = -1;

  const show = (i) => {
    current = i;
    hoverBand.setAttribute('x', left + i * band);
    hoverBand.setAttribute('visibility', 'visible');
    tooltip.textContent = `${label(i)} · ${money(daily[i])}`;
    tooltip.hidden = false;
    const center = left + (i + 0.5) * band;
    tooltip.style.left = `${Math.min(Math.max(center - tooltip.offsetWidth / 2, 0), width - tooltip.offsetWidth)}px`;
  };
  const hide = () => {
    current = -1;
    hoverBand.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };
  const showAtPointer = (event) => {
    const i = Math.floor((event.clientX - chart.getBoundingClientRect().left - left) / band);
    show(Math.min(Math.max(i, 0), days - 1));
  };

  chart.addEventListener('pointermove', showAtPointer);
  chart.addEventListener('pointerdown', showAtPointer);
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('blur', hide);
  chart.addEventListener('focus', () => show(peakDay));
  chart.addEventListener('keydown', (event) => {
    const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!move) return;
    event.preventDefault();
    show(Math.min(Math.max(current + move, 0), days - 1));
  });

  box.replaceChildren(chart, tooltip);
}

/* ---------- Entry dialog ---------- */

function openEntryDialog(entry) {
  $('entry-form').reset();
  $('entry-form').dataset.id = entry?.id ?? '';
  $('entry-title').textContent = entry ? '编辑记录' : '记一笔';
  $('entry-date').value = entry ? entry.date.replace(' ', 'T') : nowLocal();
  $('entry-amount').value = entry ? (entry.cents / 100).toFixed(2) : '';
  $('entry-merchant').value = entry?.merchant ?? '';
  $('entry-card').value = entry?.card ?? '';
  $('entry-error').textContent = '';
  $('entry-dialog').showModal();
}

async function submitEntry(event) {
  event.preventDefault();
  const fail = (message) => { $('entry-error').textContent = message; };
  const date = parseDate($('entry-date').value.replace('T', ' '));
  const cents = parseAmount($('entry-amount').value);
  const merchant = $('entry-merchant').value.trim();
  if (!date) return fail('请填写有效的时间');
  if (cents === null) return fail('金额无效,请输入大于 0 的金额');
  if (!merchant) return fail('请填写商户');

  const id = $('entry-form').dataset.id;
  const existing = state.entries.find((e) => e.id === id);
  const entry = { source: 'manual', ...existing, id: id || crypto.randomUUID(), date, cents, merchant, card: $('entry-card').value.trim() };
  state.month = date.slice(0, 7);
  await saveEntry(entry);
  $('entry-dialog').close();
}

// The dedupe key stays in the seen set, so a deleted import does not return on the next sync.
async function removeEntry(entry) {
  if (!confirm(`确定删除这笔记录吗?\n${entry.date} ${entry.merchant || UNNAMED} ${money(entry.cents)}`)) return;
  await db.deleteEntry(entry.id);
  await reload();
}

function shiftMonth(delta) {
  const [year, month] = state.month.split('-').map(Number);
  state.month = monthOf(new Date(year, month - 1 + delta, 1));
  render();
}

/* ---------- Wiring ---------- */

$('auth-form').addEventListener('submit', safely(submitAuth));
$('lock').addEventListener('click', safely(async () => {
  tabs?.postMessage('lock');
  await lock();
}));
$('sync').addEventListener('change', safely(async (event) => {
  const [file] = event.target.files;
  event.target.value = ''; // Otherwise re-selecting the same file fires no change event.
  if (file) await runImport(file);
}));
$('prev-month').addEventListener('click', () => shiftMonth(-1));
$('next-month').addEventListener('click', () => shiftMonth(1));
$('month').addEventListener('change', (event) => {
  if (event.target.value) {
    state.month = event.target.value;
    render();
  } else {
    event.target.value = state.month; // iOS's picker can clear the field.
  }
});
$('add').addEventListener('click', () => openEntryDialog());
$('entry-form').addEventListener('submit', safely(submitEntry));
$('entry-cancel').addEventListener('click', () => $('entry-dialog').close());
$('export').addEventListener('click', safely(exportCSV));
$('wipe').addEventListener('click', safely(wipeAll));
if (tabs) tabs.onmessage = safely(lock);
new ResizeObserver(() => { if (state.key) renderChart(); }).observe($('chart'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);

if (crypto.subtle) {
  safely(showAuth)();
} else {
  $('boot').textContent = '当前环境不支持加密功能,请通过 HTTPS 或 localhost 打开。';
}
