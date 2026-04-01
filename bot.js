// Copyright (c) 2026 Le Thuan. All rights reserved.
// Public portfolio version only. Unauthorized reuse, resale, or redistribution is prohibited.

process.env.NTBA_FIX_350 = 1
require('dotenv').config()

const { Telegraf, Markup } = require('telegraf')
const { Pool } = require('pg')
const cron = require('node-cron')
const ExcelJS = require('exceljs')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const bot = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_ID = Number(process.env.ADMIN_ID)
const DB_SSL_REJECT_UNAUTHORIZED = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: DB_SSL_REJECT_UNAUTHORIZED }
    : undefined
})

// ================= INIT DB =================
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id            SERIAL PRIMARY KEY,
      service       TEXT,
      name          TEXT,
      note          TEXT,
      start_date    TIMESTAMP,
      expiry_date   TIMESTAMP,
      monthly_remind BOOLEAN DEFAULT FALSE
    )
  `)
  // Migration an toàn cho DB cũ
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS monthly_remind BOOLEAN DEFAULT FALSE`)
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS note TEXT`)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS contact`)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS gmail`)
}
initDB()

// ================= HELPERS =================
function fmt(d) {
  return new Date(d).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
}
function daysLeft(d) {
  return Math.ceil((new Date(d) - Date.now()) / 86400000)
}
function addMonths(date, n) {
  const d = new Date(date)
  d.setMonth(d.getMonth() + n)
  return d
}
function todayVN() {
  const vn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return new Date(vn.getFullYear(), vn.getMonth(), vn.getDate())
}
function todayDayVN() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })).getDate()
}
function parseShortDate(text) {
  const t = text.trim().replace(/\D/g, '')
  let d, m, y
  if (t.length === 6) { d = +t.slice(0,2); m = +t.slice(2,4); y = 2000 + +t.slice(4,6) }
  else if (t.length === 8) { d = +t.slice(0,2); m = +t.slice(2,4); y = +t.slice(4,8) }
  else return null
  if (m<1||m>12||d<1||d>31||y<2000||y>2100) return null
  return new Date(y, m-1, d)
}
function parseDateVN(text) {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const d = +m[1], mo = +m[2], y = +m[3]
  if (mo<1||mo>12||d<1||d>31||y<2000||y>2100) return null
  return new Date(y, mo-1, d)
}
function isValidMonths(text) {
  const n = parseInt(text.trim())
  return !isNaN(n) && n > 0 && n <= 120 && String(n) === text.trim()
}
async function getCustomer(id) {
  const r = await db.query('SELECT * FROM customers WHERE id=$1', [id])
  return r.rows[0] || null
}
function statusIcon(d) {
  return d <= 0 ? '🔴' : d <= 3 ? '🟠' : d <= 7 ? '🟡' : '🟢'
}

// ================= STATE =================
const SERVICE_LIST = ['ChatGPT Plus', 'YouTube', 'GPT Business']
const PAGE_SIZE = 8
const TIMEOUT_MS = 15 * 60 * 1000

let state = {}
function setState(uid, data) {
  if (state[uid]?._t) clearTimeout(state[uid]._t)
  state[uid] = { ...data, _t: setTimeout(() => delete state[uid], TIMEOUT_MS) }
}
function clearState(uid) {
  if (state[uid]?._t) clearTimeout(state[uid]._t)
  delete state[uid]
}

const cancelKb = Markup.keyboard([['❌ Hủy']]).resize()

// ================= MENU CHÍNH =================
function mainMenu(ctx) {
  clearState(ctx.from.id)
  return ctx.reply('👑 PREMIUM MANAGER', Markup.keyboard([
    ['➕ Thêm khách', '👥 Khách hàng'],
    ['⚠️ Sắp hết hạn', '🔔 Lịch nhắc'],
    ['⚙️ Cài đặt']
  ]).resize())
}

bot.use((ctx, next) => {
  if (ctx.from.id !== ADMIN_ID) return
  if (ctx.message?.text === '❌ Hủy') return mainMenu(ctx)
  return next()
})
bot.start(ctx => mainMenu(ctx))


// ═══════════════════════════════════════════
// 1. THÊM KHÁCH
// ═══════════════════════════════════════════
bot.hears('➕ Thêm khách', ctx => {
  setState(ctx.from.id, { step: 'add_svc' })
  ctx.reply('📦 Chọn dịch vụ:', Markup.keyboard([
    ['ChatGPT Plus'],
    ['YouTube', 'GPT Business'],
    ['❌ Hủy']
  ]).resize())
})

// Hàm hiển thị preview + hỏi nhắc tháng
function askMonthlyRemind(ctx, s) {
  const startDay = s.start.getDate()
  const expiry = addMonths(s.start, s.months)
  let msg = `📋 *XÁC NHẬN THÊM KHÁCH*\n━━━━━━━━━━━━━━\n\n`
  msg += `👤 ${s.name}\n`
  msg += `📦 ${s.service}\n`
  if (s.note) msg += `📝 ${s.note}\n`
  msg += `📅 ${fmt(s.start)} → ${fmt(expiry)} *(${s.months} tháng)*\n\n`
  msg += `🔔 *Bật nhắc gia hạn hàng tháng?*\n`
  msg += `_Bot sẽ nhắc lúc 9:00 sáng ngày ${startDay} mỗi tháng_`
  return ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔔 Bật nhắc', 'add_yes'), Markup.button.callback('🔕 Không cần', 'add_no')]
    ])
  })
}

bot.action(/^add_(yes|no)$/, async ctx => {
  await ctx.answerCbQuery()
  const s = state[ctx.from.id]
  if (!s || s.step !== 'add_confirm') return
  const remind = ctx.match[1] === 'yes'
  const expiry = addMonths(s.start, s.months)
  await db.query(
    'INSERT INTO customers(service,name,note,start_date,expiry_date,monthly_remind) VALUES($1,$2,$3,$4,$5,$6)',
    [s.service, s.name, s.note, s.start, expiry, remind]
  )
  clearState(ctx.from.id)
  const startDay = s.start.getDate()
  let ok = 'Added customer\n\n'
  ok += 'Customer: ' + s.name + '\n'
  ok += 'Service: ' + s.service + '\n'
  if (s.note) ok += 'Note: ' + s.note + '\n'
  ok += 'Period: ' + fmt(s.start) + ' -> ' + fmt(expiry) + '\n'
  ok += 'Remaining days: ' + daysLeft(expiry) + '\n'
  ok += remind ? 'Monthly reminder: ON (day ' + startDay + ' at 09:00)' : 'Monthly reminder: OFF'
  await ctx.editMessageText(ok, { parse_mode: 'Markdown' })
  return mainMenu(ctx)
})


// ═══════════════════════════════════════════
// 2. KHÁCH HÀNG — danh sách + chi tiết
// ═══════════════════════════════════════════

// Thứ tự cycle filter
const FILTER_CYCLE = ['all', 'ChatGPT Plus', 'YouTube', 'GPT Business']
const FILTER_LABEL = {
  all:            '🔽 Tất cả',
  'ChatGPT Plus': '🔽 ChatGPT Plus',
  'YouTube':      '🔽 YouTube',
  'GPT Business': '🔽 GPT Business'
}

// Alias tìm kiếm nhanh
function resolveSearch(text) {
  const t = text.trim().toLowerCase()
  if (t === 'yt') return { search: '', filter: 'YouTube' }
  if (t === 'gpt') return { search: '', filter: 'ChatGPT Plus' }
  if (t === 'gptb' || t === 'biz' || t === 'business') return { search: '', filter: 'GPT Business' }
  if (t === 'all' || t === 'tat ca') return { search: '', filter: 'all' }
  return { search: text.trim(), filter: null } // giữ filter cũ
}

bot.hears('👥 Khách hàng', async ctx => {
  setState(ctx.from.id, { step: 'list', search: '', page: 0, filter: 'all' })
  await renderList(ctx, '', 0, 'all', false)
})

async function renderList(ctx, search, page, filter, isEdit) {
  let q = 'SELECT * FROM customers', p = [], conds = []
  if (filter !== 'all') { conds.push('service=$' + (p.length+1)); p.push(filter) }
  if (search) {
    const idx = p.length+1
    conds.push('(name ILIKE $' + idx + ' OR note ILIKE $' + idx + ')')
    p.push('%' + search + '%')
  }
  if (conds.length) q += ' WHERE ' + conds.join(' AND ')
  q += ' ORDER BY expiry_date ASC'

  const rows = (await db.query(q, p)).rows
  const total = Math.ceil(rows.length / PAGE_SIZE) || 1
  page = Math.min(Math.max(page, 0), total - 1)
  setState(ctx.from.id, { step: 'list', search, page, filter })

  const chunk = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  const filterLabel = FILTER_LABEL[filter] || '🔽 Tất cả'
  let msg = '👥 *KHÁCH HÀNG* — ' + rows.length + ' người\n'
  if (search) msg += '🔍 Tìm: "' + search + '"\n'
  msg += '_Gõ tên, ghi chú, yt/gpt/biz để lọc_\n━━━━━━━━━━━━━━\n'
  if (!chunk.length) msg += 'Chưa có khách nào.'

  const kb = []

  chunk.forEach(u => {
    const d = daysLeft(u.expiry_date)
    kb.push([Markup.button.callback(
      statusIcon(d) + (u.monthly_remind ? '🔔' : '') + ' ' + u.name + ' — ' + u.service,
      'view:' + u.id
    )])
  })

  // Phân trang — dùng « » để không nhầm với icon dịch vụ
  const nav = []
  if (page > 0) nav.push(Markup.button.callback('«', 'pg:' + (page-1)))
  nav.push(Markup.button.callback((page+1) + '/' + total, 'noop'))
  if (page < total-1) nav.push(Markup.button.callback('»', 'pg:' + (page+1)))
  if (nav.length > 1) kb.push(nav)

  // Nút cycle filter — ở dưới cùng
  kb.push([Markup.button.callback('🔄 Lọc: ' + filterLabel.replace('🔽 ', ''), 'fl_cycle')])

  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) }
  if (isEdit) { try { await ctx.editMessageText(msg, opts) } catch(e){} }
  else await ctx.reply(msg, { ...cancelKb, ...opts })
}

// Nhấn nút cycle → chuyển filter tiếp theo
bot.action('fl_cycle', async ctx => {
  await ctx.answerCbQuery()
  const s = state[ctx.from.id]
  if (!s) return
  const cur = s.filter || 'all'
  const next = FILTER_CYCLE[(FILTER_CYCLE.indexOf(cur) + 1) % FILTER_CYCLE.length]
  await renderList(ctx, s.search || '', 0, next, true)
})

bot.action(/^pg:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const s = state[ctx.from.id]
  if (!s) return
  await renderList(ctx, s.search || '', +ctx.match[1], s.filter || 'all', true)
})


bot.action(/^view:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  await renderDetail(ctx, +ctx.match[1])
})

async function renderDetail(ctx, id) {
  const u = await getCustomer(id)
  if (!u) return
  const d = daysLeft(u.expiry_date)
  const icon = statusIcon(d)
  const startDay = new Date(u.start_date).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', day: 'numeric' })

  let msg = `${icon} ${u.name}\n------------------\n`
  msg += `Service: ${u.service}\n`
  if (u.note) msg += `Note: ${u.note}\n`
  msg += `Period: ${fmt(u.start_date)} -> ${fmt(u.expiry_date)}\n`
  msg += `Remaining: ${d <= 0 ? `Overdue ${Math.abs(d)} days` : `${d} days left`}\n`
  msg += `Monthly reminder: ${u.monthly_remind ? `ON (day ${startDay})` : 'OFF'}`

  await ctx.editMessageText(msg, {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('Edit name', `ed_n:${id}`), Markup.button.callback('Edit note', `ed_g:${id}`)],
      [Markup.button.callback('Edit start date', `ed_s:${id}`), Markup.button.callback('Edit remaining days', `ed_e:${id}`)],
      [Markup.button.callback('Change service', `svc:${id}`), Markup.button.callback(u.monthly_remind ? 'Turn reminder off' : 'Turn reminder on', `tog:${id}`)],
      [Markup.button.callback('Delete', `del:${id}`), Markup.button.callback('Back', 'back')]
    ])
  })
}

bot.action('back', async ctx => {
  await ctx.answerCbQuery()
  const s = state[ctx.from.id] || { search: '', page: 0, filter: 'all' }
  await renderList(ctx, s.search || '', s.page || 0, s.filter || 'all', true)
})

// Toggle nhắc tháng
bot.action(/^tog:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const u = await getCustomer(+ctx.match[1])
  if (!u) return
  await db.query('UPDATE customers SET monthly_remind=$1 WHERE id=$2', [!u.monthly_remind, u.id])
  await renderDetail(ctx, u.id)
})

// Đổi dịch vụ
bot.action(/^svc:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const u = await getCustomer(+ctx.match[1])
  if (!u) return
  await ctx.editMessageText(`Choose a new service for ${u.name}:`, {
    ...Markup.inlineKeyboard([
      SERVICE_LIST.map(sv => Markup.button.callback(sv === u.service ? `[Current] ${sv}` : sv, `svc_set:${u.id}:${sv}`)),
      [Markup.button.callback('Cancel', `view:${u.id}`)]
    ])
  })
})
bot.action(/^svc_set:(\d+):(.+)$/, async ctx => {
  const id = +ctx.match[1], sv = ctx.match[2]
  if (!SERVICE_LIST.includes(sv)) return ctx.answerCbQuery('❌ Không hợp lệ')
  await db.query('UPDATE customers SET service=$1 WHERE id=$2', [sv, id])
  await ctx.answerCbQuery(`✅ Đã đổi sang ${sv}`)
  await renderDetail(ctx, id)
})

// Xóa
bot.action(/^del:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const id = +ctx.match[1]
  const u = await getCustomer(id)
  await ctx.editMessageText(`Delete ${u?.name}?`, {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('Confirm delete', `del_ok:${id}`), Markup.button.callback('Cancel', `view:${id}`)]
    ])
  })
})
bot.action(/^del_ok:(\d+)$/, async ctx => {
  await db.query('DELETE FROM customers WHERE id=$1', [+ctx.match[1]])
  await ctx.answerCbQuery('✅ Đã xóa')
  const s = state[ctx.from.id] || { search: '', page: 0, filter: 'all' }
  await renderList(ctx, s.search || '', s.page || 0, s.filter || 'all', true)
})

// Sửa thông tin
bot.action(/^ed_([ngse]):(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const type = ctx.match[1], id = +ctx.match[2]
  const prompts = { n: 'Nhập tên mới:', g: 'Nhập ghi chú mới (gõ 0 để xóa):', s: 'Nhập ngày bắt đầu (dd/mm/yyyy):', e: 'Nhập số ngày còn lại (ví dụ: 30):' }
  setState(ctx.from.id, { step: `edit_${type}`, id })
  ctx.reply(`✏️ ${prompts[type]}`, cancelKb)
})


// ═══════════════════════════════════════════
// 3. SẮP HẾT HẠN
// ═══════════════════════════════════════════
bot.hears('⚠️ Sắp hết hạn', async ctx => {
  const rows = (await db.query(
    `SELECT * FROM customers WHERE expiry_date <= NOW() + '7 days'::INTERVAL ORDER BY expiry_date ASC`
  )).rows

  if (!rows.length) return ctx.reply('✅ Không có khách nào sắp hết hạn trong 7 ngày.')

  let msg = `⚠️ *SẮP HẾT HẠN* (${rows.length} khách)\n━━━━━━━━━━━━━━\n`
  rows.forEach(u => {
    const d = daysLeft(u.expiry_date)
    const icon = statusIcon(d)
    msg += `\n${icon} *${u.name}* — ${u.service}\n`
    if (u.note) msg += `   📝 ${u.note}\n`
    msg += `   📅 Hết: ${fmt(u.expiry_date)} `
    msg += d <= 0 ? `*(quá ${Math.abs(d)} ngày)*\n` : `*(còn ${d} ngày)*\n`
  })

  ctx.reply(msg, { parse_mode: 'Markdown' })
})


// ═══════════════════════════════════════════
// 4. LỊCH NHẮC HÀNG THÁNG
// ═══════════════════════════════════════════
bot.hears('🔔 Lịch nhắc', async ctx => {
  const rows = (await db.query(
    `SELECT * FROM customers WHERE monthly_remind = TRUE AND expiry_date > NOW() ORDER BY
      EXTRACT(DAY FROM (start_date AT TIME ZONE 'Asia/Ho_Chi_Minh')) ASC, name ASC`
  )).rows

  if (!rows.length) return ctx.reply('📭 Chưa có khách nào bật nhắc tháng.')

  // Tính ngày nhắc tiếp theo cho từng khách
  const todayVNDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  const todayDay = todayVNDate.getDate()
  const thisMonth = todayVNDate.getMonth()
  const thisYear = todayVNDate.getFullYear()

  function nextRemindDate(startDate) {
    const remindDay = new Date(startDate).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', day: 'numeric' })
    const d = parseInt(remindDay)
    // Thử tháng này trước
    let next = new Date(thisYear, thisMonth, d)
    if (next <= todayVNDate) next = new Date(thisYear, thisMonth + 1, d) // qua tháng sau
    return next
  }

  let msg = `🔔 *LỊCH NHẮC HÀNG THÁNG* (${rows.length} khách)
━━━━━━━━━━━━━━
`

  rows.forEach((u, i) => {
    const startDay = parseInt(new Date(u.start_date).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', day: 'numeric' }))
    const next = nextRemindDate(u.start_date)
    const daysUntil = Math.ceil((next - todayVNDate) / 86400000)
    const nextStr = next.toLocaleDateString('vi-VN')
    const untilStr = daysUntil === 0 ? '_(hôm nay!)_' : `_(còn ${daysUntil} ngày)_`

    msg += `
${i+1}. *${u.name}* — ${u.service}
`
    if (u.note) msg += `   📝 ${u.note}
`
    msg += `   🔔 Nhắc ngày *${startDay}* mỗi tháng
`
    msg += `   ⏭ Lần tới: ${nextStr} ${untilStr}
`
    msg += `   📅 Hết hạn: ${fmt(u.expiry_date)} (còn ${daysLeft(u.expiry_date)} ngày)
`
  })

  ctx.reply(msg, { parse_mode: 'Markdown' })
})


// ═══════════════════════════════════════════
// 5. CÀI ĐẶT
// ═══════════════════════════════════════════
bot.hears('⚙️ Cài đặt', ctx => {
  ctx.reply('⚙️ *CÀI ĐẶT*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📥 Xuất Excel', 'export')],
      [Markup.button.callback('🗑 Xóa toàn bộ dữ liệu', 'reset')]
    ])
  })
})

bot.action('export', async ctx => {
  await ctx.answerCbQuery('Đang xuất...')
  const rows = (await db.query('SELECT * FROM customers ORDER BY service, expiry_date')).rows
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Customers')
  ws.columns = [
    { header: 'Dịch vụ', key: 'sv', width: 15 },
    { header: 'Tên', key: 'name', width: 20 },
    { header: 'Ghi chú', key: 'note', width: 25 },
    { header: 'Bắt đầu', key: 'sd', width: 14 },
    { header: 'Hết hạn', key: 'ed', width: 14 },
    { header: 'Còn lại (ngày)', key: 'd', width: 14 },
    { header: 'Nhắc tháng', key: 'mr', width: 12 }
  ]
  rows.forEach(u => ws.addRow({
    sv: u.service, name: u.name, note: u.note || '',
    sd: fmt(u.start_date), ed: fmt(u.expiry_date),
    d: daysLeft(u.expiry_date), mr: u.monthly_remind ? 'Có' : 'Không'
  }))
  const file = path.join(os.tmpdir(), `customers-${Date.now()}-${ctx.from.id}.xlsx`)
  try {
    await wb.xlsx.writeFile(file)
    await ctx.replyWithDocument({ source: file })
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})

bot.action('reset', async ctx => {
  await ctx.editMessageText('⚠️ Xóa toàn bộ khách hàng?', Markup.inlineKeyboard([
    [Markup.button.callback('✅ Xác nhận', 'reset_ok'), Markup.button.callback('❌ Hủy', 'noop')]
  ]))
})
bot.action('reset_ok', async ctx => {
  await db.query('TRUNCATE TABLE customers RESTART IDENTITY')
  await ctx.answerCbQuery('✅ Đã xóa')
  ctx.editMessageText('✅ Đã xóa toàn bộ dữ liệu.')
})
bot.action('noop', ctx => ctx.answerCbQuery())


// ═══════════════════════════════════════════
// TEXT HANDLER
// ═══════════════════════════════════════════
bot.on('text', async ctx => {
  const text = ctx.message.text.trim()
  const s = state[ctx.from.id]
  if (!s) return

  // Tìm kiếm trong danh sách (hỗ trợ alias: yt, gpt, biz)
  if (s.step === 'list') {
    const { search, filter } = resolveSearch(text)
    const newFilter = filter !== null ? filter : (s.filter || 'all')
    return renderList(ctx, search, 0, newFilter, false)
  }

  // ── THÊM KHÁCH ──
  if (s.step === 'add_svc') {
    if (!SERVICE_LIST.includes(text)) return ctx.reply('❌ Chọn dịch vụ từ bàn phím:')
    setState(ctx.from.id, { step: 'add_form', service: text })
    return ctx.reply(
      `📋 Nhập thông tin — mỗi dòng 1 mục:\n\n` +
      `*Tối thiểu:*\nTên\nSố tháng\n\n` +
      `*Có ghi chú:*\nTên\nGhi chú (email, SĐT...)\nSố tháng\n\n` +
      `*Có ngày bắt đầu:*\nTên\nGhi chú\nNgày (vd: 150125)\nSố tháng\n\n` +
      `_Bỏ ghi chú → gõ "-"_`,
      { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
    )
  }

  if (s.step === 'add_form') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) return ctx.reply('❌ Cần ít nhất 2 dòng. Nhập lại:')

    let name, note = null, start = todayVN(), monthStr

    if (lines.length === 2) {
      [name, monthStr] = lines
    } else if (lines.length === 3) {
      name = lines[0]
      const tryDate = parseShortDate(lines[1])
      if (tryDate) { start = tryDate; monthStr = lines[2] }
      else { note = lines[1] === '-' ? null : lines[1]; monthStr = lines[2] }
    } else {
      name = lines[0]
      note = lines[1] === '-' ? null : lines[1]
      start = parseShortDate(lines[2])
      monthStr = lines[3]
      if (!start) return ctx.reply('❌ Ngày không hợp lệ. Ví dụ: 150125. Nhập lại:')
    }

    if (!isValidMonths(monthStr)) return ctx.reply('❌ Số tháng không hợp lệ. Nhập lại:')

    setState(ctx.from.id, { step: 'add_confirm', service: s.service, name, note, start, months: +monthStr })
    return askMonthlyRemind(ctx, state[ctx.from.id])
  }

  // ── SỬA THÔNG TIN ──
  if (s.step?.startsWith('edit_')) {
    const type = s.step.replace('edit_', '')
    let val = text, col = ''

    if (type === 'n') col = 'name'
    if (type === 'g') { col = 'note'; val = text === '0' ? null : text }
    if (type === 's') {
      val = parseDateVN(text)
      if (!val) return ctx.reply('❌ Ngày không hợp lệ. Nhập dd/mm/yyyy:')
      col = 'start_date'
    }
    if (type === 'e') {
      const days = Number.parseInt(text, 10)
      if (!Number.isInteger(days) || days < 0 || days > 3650) {
        return ctx.reply('❌ Số ngày không hợp lệ. Hãy nhập số từ 0 đến 3650, ví dụ: 30')
      }
      const expiry = todayVN()
      expiry.setDate(expiry.getDate() + days)
      val = expiry
      col = 'expiry_date'
    }

    await db.query(`UPDATE customers SET ${col}=$1 WHERE id=$2`, [val, s.id])
    clearState(ctx.from.id)

    const updated = await getCustomer(s.id)
    if (!updated) {
      await ctx.reply('✅ Đã cập nhật!', Markup.removeKeyboard())
      return
    }

    const remaining = daysLeft(updated.expiry_date)
    let summary = 'Updated customer information\n\n'
    summary += 'Customer: ' + updated.name + '\n'
    summary += 'Service: ' + updated.service + '\n'
    if (updated.note) summary += 'Note: ' + updated.note + '\n'
    summary += 'Period: ' + fmt(updated.start_date) + ' -> ' + fmt(updated.expiry_date) + '\n'
    summary += 'Remaining days: ' + remaining + '\n'
    summary += 'Monthly reminder: ' + (updated.monthly_remind ? 'ON' : 'OFF')

    await ctx.reply(summary, Markup.removeKeyboard())
    return
  }
})


// ═══════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════

// 1. Báo cáo hạn sắp hết — 9h sáng mỗi ngày
cron.schedule('0 9 * * *', async () => {
  try {
    const rows = (await db.query(
      `SELECT * FROM customers WHERE expiry_date <= NOW() + '7 days'::INTERVAL ORDER BY expiry_date ASC`
    )).rows
    if (!rows.length) return

    let msg = `⏰ BÁO CÁO HẠN SẮP HẾT\n━━━━━━━━━━━━━━\n`
    rows.forEach(u => {
      const d = daysLeft(u.expiry_date)
      if ([7,3,2,1,0,-1,-2].includes(d)) {
        const icon = statusIcon(d)
        msg += `\n${icon} ${u.name} (${u.service})`
        if (u.note) msg += ` — ${u.note}`
        msg += `\n   ${d <= 0 ? `Quá ${Math.abs(d)} ngày` : `Còn ${d} ngày`} (hết ${fmt(u.expiry_date)})\n`
      }
    })
    if (msg.includes('🔴') || msg.includes('🟠') || msg.includes('🟡'))
      bot.telegram.sendMessage(ADMIN_ID, msg)
  } catch(e) { console.error('Cron hạn:', e) }
}, { timezone: 'Asia/Ho_Chi_Minh' })


// 2. Nhắc gia hạn hàng tháng — 9h sáng mỗi ngày
//    Logic: check khách nào có ngày đăng ký = hôm nay
//    VD: đăng ký 15/01 → nhắc 15/02, 15/03, 15/04...
cron.schedule('0 9 * * *', async () => {
  try {
    const todayDay = todayDayVN()
    const rows = (await db.query(`
      SELECT * FROM customers
      WHERE monthly_remind = TRUE
        AND expiry_date > NOW()
        AND EXTRACT(DAY FROM (start_date AT TIME ZONE 'Asia/Ho_Chi_Minh')) = $1
      ORDER BY service, name
    `, [todayDay])).rows

    if (!rows.length) return

    const today = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: 'numeric', month: 'long', year: 'numeric' })
    let msg = `🔔 NHẮC GIA HẠN — ${today}\n━━━━━━━━━━━━━━\n`
    rows.forEach((u, i) => {
      const d = daysLeft(u.expiry_date)
      msg += `\n${i+1}. ${u.name}\n`
      msg += `   📦 ${u.service}\n`
      if (u.note) msg += `   📝 ${u.note}\n`
      msg += `   📅 Đăng ký: ${fmt(u.start_date)} → Hết hạn: ${fmt(u.expiry_date)} (còn ${d} ngày)\n`
    })
    msg += `\nTổng ${rows.length} khách cần xử lý hôm nay.`

    await bot.telegram.sendMessage(ADMIN_ID, msg)
  } catch(e) { console.error('Cron nhắc tháng:', e) }
}, { timezone: 'Asia/Ho_Chi_Minh' })


// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
http.createServer((_, res) => { res.writeHead(200); res.end('ok') }).listen(process.env.PORT || 3000)
bot.launch({ dropPendingUpdates: true })
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
console.log('🚀 Bot running')



