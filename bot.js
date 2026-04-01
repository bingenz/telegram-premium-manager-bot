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

const bot = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_ID = Number(process.env.ADMIN_ID)

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// ================= INIT DB =================
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id             SERIAL PRIMARY KEY,
      service        TEXT,
      name           TEXT,
      note           TEXT,
      start_date     TIMESTAMP,
      expiry_date    TIMESTAMP,
      monthly_remind BOOLEAN DEFAULT FALSE
    )
  `)
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS monthly_remind BOOLEAN DEFAULT FALSE`)
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS note TEXT`)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS contact`)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS gmail`)
}
initDB()

// ================= HELPERS =================
const TZ = 'Asia/Ho_Chi_Minh'
const SERVICE_LIST = ['ChatGPT Plus', 'YouTube', 'GPT Business']
const PAGE_SIZE = 8
const TIMEOUT_MS = 15 * 60 * 1000
const CANCEL_TEXT = '❌ Hủy'
const MENU_TEXT = {
  add: '➕ Thêm khách',
  list: '👥 Khách hàng',
  expiring: '⚠️ Sắp hết hạn',
  remind: '🔔 Lịch nhắc',
  settings: '⚙️ Cài đặt'
}

function fmt(d) {
  return new Date(d).toLocaleDateString('vi-VN', { timeZone: TZ })
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
  const vn = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }))
  return new Date(vn.getFullYear(), vn.getMonth(), vn.getDate())
}
function todayDayVN() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ })).getDate()
}
function parseShortDate(text) {
  const t = text.trim().replace(/\D/g, '')
  let d, m, y
  if (t.length === 6) {
    d = +t.slice(0, 2)
    m = +t.slice(2, 4)
    y = 2000 + +t.slice(4, 6)
  } else if (t.length === 8) {
    d = +t.slice(0, 2)
    m = +t.slice(2, 4)
    y = +t.slice(4, 8)
  } else return null
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null
  return new Date(y, m - 1, d)
}
function parseDateVN(text) {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const d = +m[1], mo = +m[2], y = +m[3]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null
  return new Date(y, mo - 1, d)
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
function esc(s = '') {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
}
function panel(title, lines = []) {
  return [`*${esc(title)}*`, '━━━━━━━━━━━━━━', ...lines.filter(Boolean)].join('\n')
}
function customerDisplay(u) {
  const d = daysLeft(u.expiry_date)
  const remind = u.monthly_remind ? ' 🔔' : ''
  return `${statusIcon(d)}${remind} ${u.name} — ${u.service}`
}
function getListHint(search, filter) {
  const parts = []
  if (filter !== 'all') parts.push(`lọc: ${filter}`)
  if (search) parts.push(`tìm: "${search}"`)
  return parts.length ? `• ${parts.join(' • ')}` : '• đang xem tất cả'
}
async function getListStats(filter, search) {
  let q = 'SELECT * FROM customers'
  const vals = []
  const conds = []
  if (filter !== 'all') {
    conds.push(`service=$${vals.length + 1}`)
    vals.push(filter)
  }
  if (search) {
    conds.push(`(name ILIKE $${vals.length + 1} OR note ILIKE $${vals.length + 1})`)
    vals.push(`%${search}%`)
  }
  if (conds.length) q += ' WHERE ' + conds.join(' AND ')
  const rows = (await db.query(q, vals)).rows
  return {
    total: rows.length,
    expiring: rows.filter(r => daysLeft(r.expiry_date) <= 7).length,
    remind: rows.filter(r => r.monthly_remind).length
  }
}
function buildListQuery(search, filter) {
  let q = 'SELECT * FROM customers'
  const p = []
  const conds = []
  if (filter !== 'all') {
    conds.push('service=$' + (p.length + 1))
    p.push(filter)
  }
  if (search) {
    const idx = p.length + 1
    conds.push('(name ILIKE $' + idx + ' OR note ILIKE $' + idx + ')')
    p.push('%' + search + '%')
  }
  if (conds.length) q += ' WHERE ' + conds.join(' AND ')
  q += ' ORDER BY expiry_date ASC, id ASC'
  return { q, p }
}

// ================= STATE =================
let state = {}
function setState(uid, data) {
  if (state[uid]?._t) clearTimeout(state[uid]._t)
  state[uid] = { ...data, _t: setTimeout(() => delete state[uid], TIMEOUT_MS) }
}
function clearState(uid) {
  if (state[uid]?._t) clearTimeout(state[uid]._t)
  delete state[uid]
}

const cancelKb = Markup.keyboard([[CANCEL_TEXT]]).resize()

// ================= MENU CHÍNH =================
function mainMenu(ctx) {
  clearState(ctx.from.id)
  return ctx.reply(
    panel('PREMIUM MANAGER', [
      'Chọn tác vụ bên dưới.'
    ]),
    Markup.keyboard([
      [MENU_TEXT.add, MENU_TEXT.list],
      [MENU_TEXT.expiring, MENU_TEXT.remind],
      [MENU_TEXT.settings]
    ]).resize()
  )
}

bot.use((ctx, next) => {
  if (ctx.from.id !== ADMIN_ID) return
  if (ctx.message?.text === CANCEL_TEXT) return mainMenu(ctx)
  return next()
})
bot.start(ctx => mainMenu(ctx))

// ═══════════════════════════════════════════
// 1. THÊM KHÁCH
// ═══════════════════════════════════════════
bot.hears(MENU_TEXT.add, ctx => {
  setState(ctx.from.id, { step: 'add_svc' })
  ctx.reply(
    panel('THÊM KHÁCH', ['B1. Chọn dịch vụ']),
    Markup.keyboard([
      ['ChatGPT Plus'],
      ['YouTube', 'GPT Business'],
      [CANCEL_TEXT]
    ]).resize()
  )
})

function addPreviewText(s) {
  const expiry = addMonths(s.start, s.months)
  const startDay = s.start.getDate()
  return panel('XÁC NHẬN THÊM KHÁCH', [
    `👤 ${s.name}`,
    `📦 ${s.service}`,
    s.note ? `📝 ${s.note}` : '',
    `📅 ${fmt(s.start)} → ${fmt(expiry)} (${s.months} tháng)`,
    '',
    'Bật nhắc gia hạn hàng tháng?',
    `_Nhắc lúc 9:00 sáng ngày ${startDay} mỗi tháng_`
  ])
}
function askMonthlyRemind(ctx, s) {
  return ctx.reply(addPreviewText(s), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔔 Bật nhắc', 'add_yes'), Markup.button.callback('🔕 Không nhắc', 'add_no')]
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
  await ctx.editMessageText(panel('ĐÃ THÊM KHÁCH', [
    `👤 ${s.name}`,
    `📦 ${s.service}`,
    `📅 ${fmt(s.start)} → ${fmt(expiry)}`,
    remind ? `🔔 Nhắc ngày ${startDay} lúc 9:00` : '🔕 Không bật nhắc tháng'
  ]), { parse_mode: 'Markdown' })

  return mainMenu(ctx)
})

// ═══════════════════════════════════════════
// 2. KHÁCH HÀNG — danh sách + chi tiết
// ═══════════════════════════════════════════
const FILTER_CYCLE = ['all', 'ChatGPT Plus', 'YouTube', 'GPT Business']
const FILTER_LABEL = {
  all: 'Tất cả',
  'ChatGPT Plus': 'ChatGPT Plus',
  'YouTube': 'YouTube',
  'GPT Business': 'GPT Business'
}

function resolveSearch(text) {
  const t = text.trim().toLowerCase()
  if (t === 'yt') return { search: '', filter: 'YouTube' }
  if (t === 'gpt') return { search: '', filter: 'ChatGPT Plus' }
  if (t === 'gptb' || t === 'biz' || t === 'business') return { search: '', filter: 'GPT Business' }
  if (t === 'all' || t === 'tat ca') return { search: '', filter: 'all' }
  return { search: text.trim(), filter: null }
}

bot.hears(MENU_TEXT.list, async ctx => {
  setState(ctx.from.id, { step: 'list', search: '', page: 0, filter: 'all' })
  await renderList(ctx, '', 0, 'all', false)
})

async function renderList(ctx, search, page, filter, isEdit) {
  const { q, p } = buildListQuery(search, filter)
  const rows = (await db.query(q, p)).rows
  const stats = await getListStats(filter, search)

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  page = Math.min(Math.max(page, 0), totalPages - 1)
  setState(ctx.from.id, { step: 'list', search, page, filter })

  const chunk = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
  const lines = [
    `Tổng: *${stats.total}* • Sắp hết hạn: *${stats.expiring}* • Bật nhắc: *${stats.remind}*`,
    getListHint(search, filter),
    '',
    chunk.length
      ? chunk.map((u, i) => {
          const index = page * PAGE_SIZE + i + 1
          const d = daysLeft(u.expiry_date)
          return `${index}. ${statusIcon(d)} *${esc(u.name)}* — ${esc(u.service)} · ${d <= 0 ? `quá ${Math.abs(d)} ngày` : `còn ${d} ngày`}`
        }).join('\n')
      : '_Chưa có khách phù hợp_',
    '',
    '_Gõ tên / ghi chú để tìm • gõ yt / gpt / biz / all để lọc nhanh_'
  ]

  const msg = panel('DANH SÁCH KHÁCH HÀNG', lines)

  const kb = chunk.map(u => [Markup.button.callback(customerDisplay(u), `view:${u.id}`)])

  const nav = []
  if (page > 0) nav.push(Markup.button.callback('«', `pg:${page - 1}`))
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'))
  if (page < totalPages - 1) nav.push(Markup.button.callback('»', `pg:${page + 1}`))
  if (nav.length > 1) kb.push(nav)

  kb.push([
    Markup.button.callback(`🔄 ${FILTER_LABEL[filter] || 'Tất cả'}`, 'fl_cycle'),
    Markup.button.callback('🧹 Xóa tìm', 'ls_clear')
  ])
  kb.push([
    Markup.button.callback('♻️ Tải lại', 'ls_refresh')
  ])

  const opts = {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(kb)
  }

  if (isEdit) {
    try {
      await ctx.editMessageText(msg, opts)
    } catch (_) {}
  } else {
    await ctx.reply(msg, opts)
  }
}

bot.action('ls_clear', async ctx => {
  await ctx.answerCbQuery('Đã xóa từ khóa')
  const s = state[ctx.from.id]
  if (!s) return
  await renderList(ctx, '', 0, s.filter || 'all', true)
})

bot.action('ls_refresh', async ctx => {
  await ctx.answerCbQuery('Đã tải lại')
  const s = state[ctx.from.id]
  if (!s) return
  await renderList(ctx, s.search || '', s.page || 0, s.filter || 'all', true)
})

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
  const startDay = new Date(u.start_date).toLocaleString('en-US', { timeZone: TZ, day: 'numeric' })

  const msg = panel(u.name, [
    `📦 ${u.service}`,
    u.note ? `📝 ${u.note}` : '',
    `📅 ${fmt(u.start_date)} → ${fmt(u.expiry_date)}`,
    `⏳ ${d <= 0 ? `Quá hạn ${Math.abs(d)} ngày` : `Còn ${d} ngày`}`,
    `🔔 Nhắc tháng: ${u.monthly_remind ? `BẬT (ngày ${startDay})` : 'TẮT'}`
  ])

  await ctx.editMessageText(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Tên', `ed_n:${id}`), Markup.button.callback('📝 Ghi chú', `ed_g:${id}`)],
      [Markup.button.callback('📅 Ngày bắt đầu', `ed_s:${id}`), Markup.button.callback('⏳ Hết hạn', `ed_e:${id}`)],
      [Markup.button.callback('🔄 Đổi dịch vụ', `svc:${id}`), Markup.button.callback(u.monthly_remind ? '🔕 Tắt nhắc' : '🔔 Bật nhắc', `tog:${id}`)],
      [Markup.button.callback('🗑 Xóa khách', `del:${id}`)],
      [Markup.button.callback('🔙 Quay lại danh sách', 'back')]
    ])
  })
}

bot.action('back', async ctx => {
  await ctx.answerCbQuery()
  const s = state[ctx.from.id] || { search: '', page: 0, filter: 'all' }
  await renderList(ctx, s.search || '', s.page || 0, s.filter || 'all', true)
})

bot.action(/^tog:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const u = await getCustomer(+ctx.match[1])
  if (!u) return
  await db.query('UPDATE customers SET monthly_remind=$1 WHERE id=$2', [!u.monthly_remind, u.id])
  await renderDetail(ctx, u.id)
})

bot.action(/^svc:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const u = await getCustomer(+ctx.match[1])
  if (!u) return
  await ctx.editMessageText(panel('ĐỔI DỊCH VỤ', [`Khách: *${esc(u.name)}*`, 'Chọn dịch vụ mới:']), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      SERVICE_LIST.map(sv => Markup.button.callback(sv === u.service ? `✅ ${sv}` : sv, `svc_set:${u.id}:${sv}`)),
      [Markup.button.callback('🔙 Quay lại', `view:${u.id}`)]
    ])
  })
})

bot.action(/^svc_set:(\d+):(.+)$/, async ctx => {
  const id = +ctx.match[1]
  const sv = ctx.match[2]
  if (!SERVICE_LIST.includes(sv)) return ctx.answerCbQuery('❌ Không hợp lệ')
  await db.query('UPDATE customers SET service=$1 WHERE id=$2', [sv, id])
  await ctx.answerCbQuery(`Đã đổi sang ${sv}`)
  await renderDetail(ctx, id)
})

bot.action(/^del:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const id = +ctx.match[1]
  const u = await getCustomer(id)
  await ctx.editMessageText(panel('XÓA KHÁCH', [
    u ? `Bạn có chắc muốn xóa *${esc(u.name)}*?` : 'Không tìm thấy khách.'
  ]), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Xác nhận xóa', `del_ok:${id}`), Markup.button.callback('🔙 Hủy', `view:${id}`)]
    ])
  })
})

bot.action(/^del_ok:(\d+)$/, async ctx => {
  await db.query('DELETE FROM customers WHERE id=$1', [+ctx.match[1]])
  await ctx.answerCbQuery('Đã xóa')
  const s = state[ctx.from.id] || { search: '', page: 0, filter: 'all' }
  await renderList(ctx, s.search || '', s.page || 0, s.filter || 'all', true)
})

bot.action(/^ed_([ngse]):(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const type = ctx.match[1]
  const id = +ctx.match[2]
  const prompts = {
    n: panel('SỬA TÊN', ['Nhập tên mới:']),
    g: panel('SỬA GHI CHÚ', ['Nhập ghi chú mới.', 'Gõ *0* để xóa ghi chú.']),
    s: panel('SỬA NGÀY BẮT ĐẦU', ['Nhập theo dạng *dd/mm/yyyy*']),
    e: panel('SỬA HẾT HẠN', ['Nhập *số ngày còn lại*.', 'Ví dụ: *30*'])
  }
  setState(ctx.from.id, { step: `edit_${type}`, id })
  ctx.reply(prompts[type], { parse_mode: 'Markdown', ...cancelKb })
})

// ═══════════════════════════════════════════
// 3. SẮP HẾT HẠN
// ═══════════════════════════════════════════
bot.hears(MENU_TEXT.expiring, async ctx => {
  const rows = (await db.query(
    `SELECT * FROM customers WHERE expiry_date <= NOW() + '7 days'::INTERVAL ORDER BY expiry_date ASC`
  )).rows

  if (!rows.length) {
    return ctx.reply(panel('SẮP HẾT HẠN', ['✅ Không có khách nào sắp hết hạn trong 7 ngày tới.']), {
      parse_mode: 'Markdown'
    })
  }

  const lines = rows.map((u, i) => {
    const d = daysLeft(u.expiry_date)
    const note = u.note ? `\n   📝 ${u.note}` : ''
    const remain = d <= 0 ? `quá ${Math.abs(d)} ngày` : `còn ${d} ngày`
    return `${i + 1}. ${statusIcon(d)} *${esc(u.name)}* — ${esc(u.service)}${note}\n   📅 ${fmt(u.expiry_date)} (${remain})`
  })

  ctx.reply(panel(`SẮP HẾT HẠN (${rows.length} khách)`, lines), { parse_mode: 'Markdown' })
})

// ═══════════════════════════════════════════
// 4. LỊCH NHẮC HÀNG THÁNG
// ═══════════════════════════════════════════
bot.hears(MENU_TEXT.remind, async ctx => {
  const rows = (await db.query(
    `SELECT * FROM customers WHERE monthly_remind = TRUE AND expiry_date > NOW() ORDER BY
      EXTRACT(DAY FROM (start_date AT TIME ZONE 'Asia/Ho_Chi_Minh')) ASC, name ASC`
  )).rows

  if (!rows.length) {
    return ctx.reply(panel('LỊCH NHẮC HÀNG THÁNG', ['📭 Chưa có khách nào bật nhắc tháng.']), {
      parse_mode: 'Markdown'
    })
  }

  const todayVNDate = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }))
  const thisMonth = todayVNDate.getMonth()
  const thisYear = todayVNDate.getFullYear()

  function nextRemindDate(startDate) {
    const remindDay = Number(new Date(startDate).toLocaleString('en-US', { timeZone: TZ, day: 'numeric' }))
    let next = new Date(thisYear, thisMonth, remindDay)
    if (next <= todayVNDate) next = new Date(thisYear, thisMonth + 1, remindDay)
    return next
  }

  const lines = rows.map((u, i) => {
    const startDay = Number(new Date(u.start_date).toLocaleString('en-US', { timeZone: TZ, day: 'numeric' }))
    const next = nextRemindDate(u.start_date)
    const daysUntil = Math.ceil((next - todayVNDate) / 86400000)
    const nextStr = next.toLocaleDateString('vi-VN')
    return [
      `${i + 1}. *${esc(u.name)}* — ${esc(u.service)}`,
      u.note ? `   📝 ${u.note}` : '',
      `   🔔 Nhắc ngày ${startDay} mỗi tháng`,
      `   ⏭ Lần tới: ${nextStr}${daysUntil === 0 ? ' (hôm nay)' : ` (còn ${daysUntil} ngày)`}`,
      `   📅 Hết hạn: ${fmt(u.expiry_date)} (còn ${daysLeft(u.expiry_date)} ngày)`
    ].filter(Boolean).join('\n')
  })

  ctx.reply(panel(`LỊCH NHẮC HÀNG THÁNG (${rows.length} khách)`, lines), { parse_mode: 'Markdown' })
})

// ═══════════════════════════════════════════
// 5. CÀI ĐẶT
// ═══════════════════════════════════════════
bot.hears(MENU_TEXT.settings, ctx => {
  ctx.reply(panel('CÀI ĐẶT', [
    'Xuất file hoặc xóa toàn bộ dữ liệu.'
  ]), {
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
    sv: u.service,
    name: u.name,
    note: u.note || '',
    sd: fmt(u.start_date),
    ed: fmt(u.expiry_date),
    d: daysLeft(u.expiry_date),
    mr: u.monthly_remind ? 'Có' : 'Không'
  }))

  const file = '/tmp/customers.xlsx'
  await wb.xlsx.writeFile(file)
  await ctx.replyWithDocument({ source: file })
  fs.unlinkSync(file)
})

bot.action('reset', async ctx => {
  await ctx.editMessageText(panel('XÓA TOÀN BỘ DỮ LIỆU', [
    'Thao tác này không thể hoàn tác.'
  ]), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Xác nhận xóa', 'reset_ok'), Markup.button.callback('🔙 Hủy', 'noop')]
    ])
  })
})

bot.action('reset_ok', async ctx => {
  await db.query('TRUNCATE TABLE customers RESTART IDENTITY')
  await ctx.answerCbQuery('Đã xóa')
  ctx.editMessageText(panel('HOÀN TẤT', ['Đã xóa toàn bộ dữ liệu.']), { parse_mode: 'Markdown' })
})

bot.action('noop', ctx => ctx.answerCbQuery())

// ═══════════════════════════════════════════
// TEXT HANDLER
// ═══════════════════════════════════════════
bot.on('text', async ctx => {
  const text = ctx.message.text.trim()
  const s = state[ctx.from.id]
  if (!s) return

  if (s.step === 'list') {
    const { search, filter } = resolveSearch(text)
    const newFilter = filter !== null ? filter : (s.filter || 'all')
    return renderList(ctx, search, 0, newFilter, false)
  }

  if (s.step === 'add_svc') {
    if (!SERVICE_LIST.includes(text)) return ctx.reply('❌ Chọn dịch vụ bằng nút có sẵn.')
    setState(ctx.from.id, { step: 'add_form', service: text })
    return ctx.reply(panel('NHẬP THÔNG TIN KHÁCH', [
      'Mỗi dòng 1 mục.',
      '',
      '*Mẫu 1*',
      'Tên',
      'Số tháng',
      '',
      '*Mẫu 2*',
      'Tên',
      'Ghi chú',
      'Số tháng',
      '',
      '*Mẫu 3*',
      'Tên',
      'Ghi chú',
      'Ngày bắt đầu (vd: 150125)',
      'Số tháng',
      '',
      '_Bỏ ghi chú: gõ -_'
    ]), { parse_mode: 'Markdown', ...Markup.removeKeyboard() })
  }

  if (s.step === 'add_form') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) return ctx.reply('❌ Cần ít nhất 2 dòng. Nhập lại theo mẫu.')

    let name
    let note = null
    let start = todayVN()
    let monthStr

    if (lines.length === 2) {
      ;[name, monthStr] = lines
    } else if (lines.length === 3) {
      name = lines[0]
      const tryDate = parseShortDate(lines[1])
      if (tryDate) {
        start = tryDate
        monthStr = lines[2]
      } else {
        note = lines[1] === '-' ? null : lines[1]
        monthStr = lines[2]
      }
    } else {
      name = lines[0]
      note = lines[1] === '-' ? null : lines[1]
      start = parseShortDate(lines[2])
      monthStr = lines[3]
      if (!start) return ctx.reply('❌ Ngày không hợp lệ. Ví dụ: 150125')
    }

    if (!isValidMonths(monthStr)) return ctx.reply('❌ Số tháng không hợp lệ. Chỉ nhận số từ 1 đến 120.')

    setState(ctx.from.id, {
      step: 'add_confirm',
      service: s.service,
      name,
      note,
      start,
      months: +monthStr
    })
    return askMonthlyRemind(ctx, state[ctx.from.id])
  }

  if (s.step?.startsWith('edit_')) {
    const type = s.step.replace('edit_', '')
    let val = text
    let col = ''

    if (type === 'n') col = 'name'
    if (type === 'g') {
      col = 'note'
      val = text === '0' ? null : text
    }
    if (type === 's') {
      val = parseDateVN(text)
      if (!val) return ctx.reply('❌ Ngày không hợp lệ. Nhập theo dạng dd/mm/yyyy')
      col = 'start_date'
    }
    if (type === 'e') {
      const days = Number(text)
      if (!Number.isInteger(days) || days < 0 || days > 3650) {
        return ctx.reply('❌ Số ngày không hợp lệ. Nhập số từ 0 đến 3650.')
      }
      const base = todayVN()
      base.setDate(base.getDate() + days)
      val = base
      col = 'expiry_date'
    }

    await db.query(`UPDATE customers SET ${col}=$1 WHERE id=$2`, [val, s.id])
    clearState(ctx.from.id)
    await ctx.reply('✅ Đã cập nhật.', Markup.removeKeyboard())
    return renderDetail(ctx, s.id)
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
      if ([7, 3, 2, 1, 0, -1, -2].includes(d)) {
        const icon = statusIcon(d)
        msg += `\n${icon} ${u.name} (${u.service})`
        if (u.note) msg += ` — ${u.note}`
        msg += `\n   ${d <= 0 ? `Quá ${Math.abs(d)} ngày` : `Còn ${d} ngày`} (hết ${fmt(u.expiry_date)})\n`
      }
    })
    if (msg.includes('🔴') || msg.includes('🟠') || msg.includes('🟡')) {
      bot.telegram.sendMessage(ADMIN_ID, msg)
    }
  } catch (e) {
    console.error('Cron hạn:', e)
  }
}, { timezone: TZ })

// 2. Nhắc gia hạn hàng tháng — 9h sáng mỗi ngày
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

    const today = new Date().toLocaleDateString('vi-VN', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' })
    let msg = `🔔 NHẮC GIA HẠN — ${today}\n━━━━━━━━━━━━━━\n`
    rows.forEach((u, i) => {
      const d = daysLeft(u.expiry_date)
      msg += `\n${i + 1}. ${u.name}\n`
      msg += `   📦 ${u.service}\n`
      if (u.note) msg += `   📝 ${u.note}\n`
      msg += `   📅 Đăng ký: ${fmt(u.start_date)} → Hết hạn: ${fmt(u.expiry_date)} (còn ${d} ngày)\n`
    })
    msg += `\nTổng ${rows.length} khách cần xử lý hôm nay.`

    await bot.telegram.sendMessage(ADMIN_ID, msg)
  } catch (e) {
    console.error('Cron nhắc tháng:', e)
  }
}, { timezone: TZ })

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
http.createServer((_, res) => { res.writeHead(200); res.end('ok') }).listen(process.env.PORT || 3000)
bot.launch({ dropPendingUpdates: true })
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
console.log('🚀 Bot running')
