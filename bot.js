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
async function initDB(){
  await db.query(`
    CREATE TABLE IF NOT EXISTS customers(
      id SERIAL PRIMARY KEY,
      service TEXT,
      name TEXT,
      note TEXT,
      start_date TIMESTAMP,
      expiry_date TIMESTAMP
    )
  `)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS contact`)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS gmail`)
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS note TEXT`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS reminders(
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      remind_at TIMESTAMP,
      note TEXT,
      done BOOLEAN DEFAULT FALSE
    )
  `)
}
initDB()

// ================= HELPERS =================
function format(d){ return new Date(d).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) }
function formatDT(d){ return new Date(d).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) }
function daysFromNow(d){ return Math.ceil((new Date(d) - Date.now()) / 86400000) }

function addMonths(date, months){
  const d = new Date(date)
  d.setMonth(d.getMonth() + months)
  return d
}

function todayVN(){
  const now = new Date()
  const vn = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return new Date(vn.getFullYear(), vn.getMonth(), vn.getDate())
}

function parseDateTimeFull(text){
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if(!m) return null
  const d = parseInt(m[1]), mo = parseInt(m[2]), y = parseInt(m[3])
  const hh = m[4] !== undefined ? parseInt(m[4]) : 9
  const mm = m[5] !== undefined ? parseInt(m[5]) : 0
  if(mo<1||mo>12||d<1||d>31||y<2000||y>2100||hh<0||hh>23||mm<0||mm>59) return null
  const utc = Date.UTC(y, mo-1, d, hh-7, mm)
  const date = new Date(utc)
  if(date < Date.now()) return null
  return date
}

function parseShortDate(text){
  const t = text.trim().replace(/\D/g, '')
  let d, m, y
  if(t.length === 6){ d = parseInt(t.slice(0,2)); m = parseInt(t.slice(2,4)); y = 2000 + parseInt(t.slice(4,6)) } 
  else if(t.length === 8){ d = parseInt(t.slice(0,2)); m = parseInt(t.slice(2,4)); y = parseInt(t.slice(4,8)) } 
  else return null
  if(m<1||m>12||d<1||d>31||y<2000||y>2100) return null
  return new Date(y, m-1, d)
}

function parseDateVN(text){
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if(!m) return null
  const d = parseInt(m[1]), mo = parseInt(m[2]), y = parseInt(m[3])
  if(mo<1||mo>12||d<1||d>31||y<2000||y>2100) return null
  return new Date(y, mo-1, d)
}

function isValidMonths(text){ const n = parseInt(text.trim()); return !isNaN(n) && n > 0 && n <= 120 && String(n) === text.trim() }
function isValidText(text){ return text && text.trim().length > 0 }

async function getCustomer(id){
  const res = await db.query('SELECT * FROM customers WHERE id=$1', [id])
  return res.rows[0] || null
}

// ================= CONSTANTS & STATE =================
const SERVICE_LIST = ['ChatGPT Plus', 'YouTube', 'Gemini']
const STATE_TIMEOUT_MS = 15 * 60 * 1000 // 15 phút
const PAGE_SIZE = 7 // Quản lý khách hiển thị 7

let state = {}
function setState(userId, data){
  if(state[userId]?._timer) clearTimeout(state[userId]._timer)
  const timer = setTimeout(() => { delete state[userId] }, STATE_TIMEOUT_MS)
  state[userId] = { ...data, _timer: timer }
}
function clearState(userId){
  if(state[userId]?._timer) clearTimeout(state[userId]._timer)
  delete state[userId]
}

// Bàn phím Hủy dùng chung
const cancelKeyboard = Markup.keyboard([['⬅️ Hủy']]).resize()

// ================= MAIN MENU =================
function mainMenu(ctx){
  clearState(ctx.from.id)
  return ctx.reply(
    '👑 PREMIUM MANAGER',
    Markup.keyboard([
      ['➕ Thêm khách', '🔍 Quản lý khách'],
      ['📊 Thống kê', '⚠️ Cảnh báo Hạn'],
      ['⏰ Lịch hẹn', '⚙️ Dữ liệu']
    ]).resize()
  )
}

bot.use((ctx, next) => {
  if(ctx.from.id !== ADMIN_ID) return
  if(ctx.message?.text === '⬅️ Hủy') return mainMenu(ctx)
  next()
})

bot.start(ctx => mainMenu(ctx))


// ================= 1. THÊM KHÁCH =================
bot.hears('➕ Thêm khách', ctx => {
  setState(ctx.from.id, { step: 'add_service' })
  ctx.reply('Chọn dịch vụ:', Markup.keyboard([['ChatGPT Plus'], ['YouTube', 'Gemini'], ['⬅️ Hủy']]).resize())
})


// ================= 2. QUẢN LÝ KHÁCH (TÌM KIẾM & PHÂN TRANG) =================
bot.hears('🔍 Quản lý khách', async ctx => {
  setState(ctx.from.id, { step: 'manage', search: '', page: 0 })
  await renderCustomerList(ctx, '', 0, false)
})

async function renderCustomerList(ctx, search, page, isEdit = true){
  let query = 'SELECT * FROM customers'
  let params = []
  if(search){
    query += ' WHERE name ILIKE $1 OR note ILIKE $1 OR service ILIKE $1'
    params.push(`%${search}%`)
  }
  query += ' ORDER BY expiry_date ASC'
  
  const res = await db.query(query, params)
  const rows = res.rows
  const totalPages = Math.ceil(rows.length / PAGE_SIZE) || 1
  if(page >= totalPages) page = totalPages - 1
  if(page < 0) page = 0

  setState(ctx.from.id, { step: 'manage', search, page })

  const start = page * PAGE_SIZE
  const currentRows = rows.slice(start, start + PAGE_SIZE)

  let msg = `🔍 QUẢN LÝ KHÁCH HÀNG\n`
  msg += search ? `Đang tìm: "${search}" (${rows.length} kết quả)\n` : `Tổng cộng: ${rows.length} khách\n`
  msg += `*(Gõ tên, ghi chú hoặc dịch vụ vào chat để tìm kiếm)*\n━━━━━━━━━━━━━━\n`
  
  if(!currentRows.length) msg += 'Không tìm thấy khách nào.'

  const kb = currentRows.map(u => {
    const d = daysFromNow(u.expiry_date)
    const icon = d <= 0 ? '🔴' : d <= 3 ? '🟠' : '🟢'
    return [Markup.button.callback(`${icon} ${u.name} (${u.service})`, `mgr_view:${u.id}`)]
  })

  const pageKb = []
  if(page > 0) pageKb.push(Markup.button.callback('⬅️ Trang trước', `mgr_page:${page - 1}`))
  pageKb.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'))
  if(page < totalPages - 1) pageKb.push(Markup.button.callback('Trang sau ➡️', `mgr_page:${page + 1}`))
  
  if(pageKb.length > 1) kb.push(pageKb)

  const markup = Markup.inlineKeyboard(kb)
  
  if(isEdit) {
    try { await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...markup }) } catch(e){}
  } else {
    await ctx.reply(msg, { parse_mode: 'Markdown', ...cancelKeyboard, ...markup })
  }
}

bot.action(/^mgr_page:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const st = state[ctx.from.id]
  if(!st || st.step !== 'manage') return
  await renderCustomerList(ctx, st.search, parseInt(ctx.match[1]), true)
})

bot.action(/^mgr_view:(\d+)$/, async ctx => {
  const id = parseInt(ctx.match[1])
  const u = await getCustomer(id)
  if(!u) return ctx.answerCbQuery('Khách không tồn tại!')
  await ctx.answerCbQuery()
  
  const d = daysFromNow(u.expiry_date)
  const status = d <= 0 ? `quá ${-d} ngày` : `còn ${d} ngày`
  
  const msg = `👤 THÔNG TIN KHÁCH HÀNG\n━━━━━━━━━━━━━━\n\n`
    + `👤 Tên: ${u.name}\n`
    + `📦 Gói: ${u.service}\n`
    + `📝 Ghi chú: ${u.note || '_(trống)_'}\n`
    + `📅 Bắt đầu: ${format(u.start_date)}\n`
    + `📅 Hết hạn: ${format(u.expiry_date)}\n`
    + `⏳ Tình trạng: ${status}`

  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Sửa Tên', `ed_n:${id}`), Markup.button.callback('✏️ Sửa Ghi chú', `ed_g:${id}`)],
    [Markup.button.callback('✏️ Sửa Ngày BĐ', `ed_s:${id}`), Markup.button.callback('✏️ Sửa Hạn', `ed_e:${id}`)],
    [Markup.button.callback('🔄 Đổi Dịch vụ', `svc_pick:${id}`)],
    [Markup.button.callback('⏰ Hẹn giờ', `rem_set:${id}`), Markup.button.callback('🗑 Xóa khách', `mgr_del:${id}`)],
    [Markup.button.callback('🔙 Quay lại danh sách', `mgr_back`)]
  ]) })
})

bot.action('mgr_back', async ctx => {
  await ctx.answerCbQuery()
  const st = state[ctx.from.id] || { search: '', page: 0 }
  await renderCustomerList(ctx, st.search, st.page, true)
})

bot.action(/^svc_pick:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const id = parseInt(ctx.match[1])
  const u = await getCustomer(id)
  if(!u) return
  await ctx.editMessageText(
    `🔄 CHỌN DỊCH VỤ MỚI\n\nKhách: ${u.name}\nHiện tại: ${u.service}`,
    Markup.inlineKeyboard([
      SERVICE_LIST.map(sv => Markup.button.callback(sv === u.service ? `✅ ${sv}` : sv, `svc_set:${id}:${sv}`)),
      [Markup.button.callback('🔙 Hủy', `mgr_view:${id}`)]
    ])
  )
})

bot.action(/^svc_set:(\d+):(.+)$/, async ctx => {
  const id = parseInt(ctx.match[1])
  const sv = ctx.match[2]
  if(!SERVICE_LIST.includes(sv)) return ctx.answerCbQuery('❌ Dịch vụ không hợp lệ')
  await db.query('UPDATE customers SET service=$1 WHERE id=$2', [sv, id])
  await ctx.answerCbQuery(`✅ Đã đổi sang ${sv}`)
  // Re-render view
  const u = await getCustomer(id)
  const d = daysFromNow(u.expiry_date)
  const status = d <= 0 ? `quá ${-d} ngày` : `còn ${d} ngày`
  const msg = `👤 THÔNG TIN KHÁCH HÀNG\n━━━━━━━━━━━━━━\n\n`
    + `👤 Tên: ${u.name}\n`
    + `📦 Gói: ${u.service}\n`
    + `📝 Ghi chú: ${u.note || '_(trống)_'}\n`
    + `📅 Bắt đầu: ${format(u.start_date)}\n`
    + `📅 Hết hạn: ${format(u.expiry_date)}\n`
    + `⏳ Tình trạng: ${status}`
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Sửa Tên', `ed_n:${id}`), Markup.button.callback('✏️ Sửa Ghi chú', `ed_g:${id}`)],
    [Markup.button.callback('✏️ Sửa Ngày BĐ', `ed_s:${id}`), Markup.button.callback('✏️ Sửa Hạn', `ed_e:${id}`)],
    [Markup.button.callback('🔄 Đổi Dịch vụ', `svc_pick:${id}`)],
    [Markup.button.callback('⏰ Hẹn giờ', `rem_set:${id}`), Markup.button.callback('🗑 Xóa khách', `mgr_del:${id}`)],
    [Markup.button.callback('🔙 Quay lại danh sách', `mgr_back`)]
  ]) })
})

bot.action(/^mgr_del:(\d+)$/, async ctx => {
  const id = parseInt(ctx.match[1])
  await ctx.editMessageText('⚠️ Bạn chắc chắn muốn xóa khách này?', Markup.inlineKeyboard([
    [Markup.button.callback('✅ Xác nhận Xóa', `del_ok:${id}`)],
    [Markup.button.callback('🔙 Hủy', `mgr_view:${id}`)]
  ]))
})

bot.action(/^del_ok:(\d+)$/, async ctx => {
  await db.query('DELETE FROM customers WHERE id=$1', [parseInt(ctx.match[1])])
  await ctx.answerCbQuery('✅ Đã xóa')
  const st = state[ctx.from.id] || { search: '', page: 0 }
  await renderCustomerList(ctx, st.search, st.page, true)
})

// BỘ SỬA THÔNG TIN NHANH
bot.action(/^ed_([ngse]):(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const type = ctx.match[1]; const id = parseInt(ctx.match[2])
  let prompt = ''
  if(type==='n') prompt = 'Nhập TÊN mới:'
  if(type==='g') prompt = 'Nhập GHI CHÚ mới (gõ - để xóa ghi chú):'
  if(type==='s') prompt = 'Nhập NGÀY BẮT ĐẦU mới (dd/mm/yyyy):'
  if(type==='e') prompt = 'Nhập NGÀY HẾT HẠN mới (dd/mm/yyyy):'
  
  setState(ctx.from.id, { step: `edit_${type}`, id })
  await ctx.reply(`✏️ ${prompt}`, cancelKeyboard)
})


// ================= 3. THỐNG KÊ =================
const FILTERS = ['A', 'C', 'Y', 'G']
const FILTER_NAMES = { 'A': 'Tất cả', 'C': 'GPT Plus', 'Y': 'YouTube', 'G': 'Gemini' }
const SORTS = ['ea', 'ed', 'sd', 'sa']
const SORT_LABELS = { 'ea': 'Sắp hết hạn', 'ed': 'Dài nhất', 'sd': 'Mới đăng ký', 'sa': 'Cũ nhất' }

bot.hears('📊 Thống kê', async ctx => {
  await renderStats(ctx, 'A', 'ea', false)
})

async function renderStats(ctx, filter, sort, isEdit){
  let where = '', params = []
  if(filter === 'C') { where = 'WHERE service=$1'; params.push('ChatGPT Plus') }
  else if(filter === 'Y') { where = 'WHERE service=$1'; params.push('YouTube') }
  else if(filter === 'G') { where = 'WHERE service=$1'; params.push('Gemini') }

  const orderMap = { 'ea': 'expiry_date ASC', 'ed': 'expiry_date DESC', 'sd': 'start_date DESC', 'sa': 'start_date ASC' }
  const res = await db.query(`SELECT * FROM customers ${where} ORDER BY ${orderMap[sort]}`, params)
  const rows = res.rows
  const total = rows.length
  const soon = rows.filter(u => { const d = daysFromNow(u.expiry_date); return d > 0 && d <= 7 }).length
  const expired = rows.filter(u => daysFromNow(u.expiry_date) <= 0).length

  const nextSort = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]

  let msg = `📊 THỐNG KÊ — ${FILTER_NAMES[filter]}\n━━━━━━━━━━━━━━\n`
  msg += `Tổng: ${total} · 🟠 Sắp HH: ${soon} · 🔴 Đã HH: ${expired}\n━━━━━━━━━━━━━━\n`

  if(!rows.length) {
    msg += '\n✅ Không có dữ liệu.'
  } else {
    rows.forEach(u => {
      const diff = daysFromNow(u.expiry_date)
      const icon = diff <= 0 ? '🔴' : diff <= 3 ? '🟠' : (diff <= 7 ? '🟡' : '🟢')
      const status = diff <= 0 ? `quá ${Math.abs(diff)}` : `còn ${diff}`
      msg += `\n${icon} ${u.name} (${u.service})\n📝 ${u.note || '_(trống)_'}\n📅 ${format(u.start_date)} → ${format(u.expiry_date)} (${status} ngày)\n━━━━━━━━━━━━━━\n`
    })
  }

  const kb = Markup.inlineKeyboard([
    FILTERS.map(f => Markup.button.callback(filter === f ? `✅ ${FILTER_NAMES[f]}` : FILTER_NAMES[f], `st:${f}:${sort}`)),
    [Markup.button.callback(`🔃 ${SORT_LABELS[sort]} →`, `st:${filter}:${nextSort}`)]
  ])

  if(isEdit) {
    try { await ctx.editMessageText(msg, kb) } catch(e){}
  } else {
    await ctx.reply(msg, kb)
  }
}

bot.action(/^st:([ACYG]):(ea|ed|sd|sa)$/, async ctx => {
  await ctx.answerCbQuery()
  await renderStats(ctx, ctx.match[1], ctx.match[2], true)
})


// ================= 4. CẢNH BÁO HẠN GỘP CHUNG =================
bot.hears('⚠️ Cảnh báo Hạn', async ctx => {
  await renderWarnings(ctx, 0, false)
})

async function renderWarnings(ctx, filterDays, isEdit){
  let query = filterDays === 0 
    ? 'SELECT * FROM customers WHERE expiry_date < NOW() ORDER BY expiry_date ASC'
    : `SELECT * FROM customers WHERE expiry_date >= NOW() AND expiry_date <= NOW() + INTERVAL '${filterDays} days' ORDER BY expiry_date ASC`
  
  const res = await db.query(query)
  const rows = res.rows

  let title = filterDays === 0 ? '🔴 KHÁCH ĐÃ QUÁ HẠN' : `🟠 SẮP HẾT HẠN TRONG ${filterDays} NGÀY`
  let msg = `${title} (${rows.length})\n━━━━━━━━━━━━━━\n`
  
  if(!rows.length) msg += '✅ Tuyệt vời, không có ai!'
  else {
    rows.forEach(u => {
      const d = daysFromNow(u.expiry_date)
      msg += `\n${filterDays===0?'🔴':'🟠'} ${u.name} (${u.service})\n   ${u.note ? '📝 '+u.note+' · ' : ''}${d<=0?'quá':''} ${Math.abs(d)} ngày`
    })
  }

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(filterDays === 0 ? '✅ Đã quá hạn' : '🔴 Quá hạn', 'warn:0'),
      Markup.button.callback(filterDays === 3 ? '✅ < 3 ngày' : '🟠 < 3 ngày', 'warn:3'),
      Markup.button.callback(filterDays === 7 ? '✅ < 7 ngày' : '🟡 < 7 ngày', 'warn:7')
    ]
  ])

  if(isEdit) {
    try { await ctx.editMessageText(msg, kb) } catch(e){}
  } else {
    await ctx.reply(msg, kb)
  }
}

bot.action(/^warn:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  await renderWarnings(ctx, parseInt(ctx.match[1]), true)
})


// ================= 5. LỊCH HẸN & DỮ LIỆU =================
bot.hears('⏰ Lịch hẹn', async ctx => {
  const res = await db.query(`SELECT r.id, r.remind_at, r.note, c.name, c.service, c.note as cnote FROM reminders r JOIN customers c ON r.customer_id = c.id WHERE r.done = FALSE ORDER BY r.remind_at`)
  if(!res.rows.length) return ctx.reply('✅ Không có lịch hẹn nào đang chờ.')
  
  const lines = res.rows.map(r => {
    let s = `⏰ ${formatDT(r.remind_at)}\n👤 ${r.name} (${r.service})`
    if(r.cnote) s += `\n📝 ${r.cnote}`
    if(r.note) s += `\n🗒 ${r.note}`
    return s
  }).join('\n\n')

  const msg = `📋 LỊCH HẸN ĐANG CHỜ (${res.rows.length})\n━━━━━━━━━━━━━━\n\n${lines}`

  const kb = res.rows.map(r => [Markup.button.callback(`🗑 Đã xong: ${r.name} (${formatDT(r.remind_at)})`, `rem_del:${r.id}`)])
  
  ctx.reply(msg, Markup.inlineKeyboard(kb))
})

bot.action(/^rem_del:(\d+)$/, async ctx => {
  await db.query('DELETE FROM reminders WHERE id=$1', [parseInt(ctx.match[1])])
  await ctx.answerCbQuery('✅ Đã xóa lịch hẹn')
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
  ctx.reply('✅ Đã đánh dấu hoàn thành/xóa lịch hẹn.')
})

bot.action(/^rem_set:(\d+)$/, async ctx => {
  await ctx.answerCbQuery()
  const id = parseInt(ctx.match[1])
  const u = await getCustomer(id)
  if(!u) return

  setState(ctx.from.id, { step: 'rem_datetime', id: id, customerName: u.name, customerService: u.service })
  
  const msg = `⏰ HẸN GIỜ LIÊN HỆ\n\n`
    + `👤 ${u.name} (${u.service})\n`
    + (u.note ? `📝 ${u.note}\n` : '')
    + `\nNhập ngày giờ hẹn:\ndd/mm/yyyy HH:MM\nVí dụ: 15/03/2026 09:00\n\n(Bỏ giờ → mặc định 09:00)`

  ctx.reply(msg, cancelKeyboard)
})

// DỮ LIỆU
bot.hears('⚙️ Dữ liệu', ctx => {
  ctx.reply('⚙️ TÙY CHỌN DỮ LIỆU', Markup.inlineKeyboard([
    [Markup.button.callback('📥 Xuất File Excel', 'data_export')],
    [Markup.button.callback('🔴 Xóa Trắng Database', 'data_reset')]
  ]))
})

bot.action('data_export', async ctx => {
  await ctx.answerCbQuery('Đang xuất...')
  const res = await db.query('SELECT * FROM customers ORDER BY service, expiry_date')
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Customers')
  ws.columns = [
    { header: 'Service', key: 's', width: 15 }, { header: 'Name', key: 'n', width: 20 },
    { header: 'Ghi chú', key: 'g', width: 25 }, { header: 'Start', key: 'sd', width: 15 },
    { header: 'Expiry', key: 'ed', width: 15 }, { header: 'Còn lại', key: 'd', width: 10 }
  ]
  res.rows.forEach(u => ws.addRow({ s: u.service, n: u.name, g: u.note || '', sd: format(u.start_date), ed: format(u.expiry_date), d: daysFromNow(u.expiry_date) }))
  const file = 'customers.xlsx'; await wb.xlsx.writeFile(file)
  await ctx.replyWithDocument({ source: file }); fs.unlinkSync(file)
})

bot.action('data_reset', async ctx => {
  await ctx.editMessageText('⚠️ CHẮC CHẮN XÓA TOÀN BỘ?', Markup.inlineKeyboard([
    [Markup.button.callback('✅ Xác nhận Xóa', 'data_reset_ok'), Markup.button.callback('🔙 Hủy', 'noop')]
  ]))
})
bot.action('data_reset_ok', async ctx => {
  await db.query('TRUNCATE TABLE customers, reminders RESTART IDENTITY CASCADE')
  await ctx.answerCbQuery('✅ Đã reset'); await ctx.editMessageText('✅ Đã xóa trắng dữ liệu.')
})
bot.action('noop', ctx => ctx.answerCbQuery())

// ================= TEXT HANDLER TỔNG HỢP =================
bot.on('text', async ctx => {
  const text = ctx.message.text.trim()
  const s = state[ctx.from.id]
  if(!s) return

  // TÌM KIẾM TRỰC TIẾP TRONG QUẢN LÝ
  if(s.step === 'manage'){
    return await renderCustomerList(ctx, text, 0, false)
  }

  // THÊM KHÁCH
  if(s.step === 'add_service'){
    if(!SERVICE_LIST.includes(text)) return ctx.reply('❌ Chọn dịch vụ hợp lệ từ bàn phím:')
    s.service = text; s.step = 'add_form'
    return ctx.reply(`📋 Nhập thông tin (4 dòng):\n\nTên\nGhi chú (gõ - nếu không có)\nNgày bắt đầu (ddmmyy hoặc - = hôm nay)\nSố tháng\n\nVí dụ:\nNguyen Van A\nzalo: 0901234567\n-\n1`, Markup.removeKeyboard())
  }
  if(s.step === 'add_form'){
    const lines = text.split('\n').map(l=>l.trim()).filter(l=>l)
    if(lines.length < 4) return ctx.reply('❌ Cần đủ 4 dòng. Nhập lại:')
    const start = lines[2] === '-' ? todayVN() : parseShortDate(lines[2])
    if(!start) return ctx.reply('❌ Ngày không hợp lệ. Ví dụ: 210226 hoặc gõ - để dùng hôm nay. Nhập lại cả 4 dòng:')
    if(!isValidMonths(lines[3])) return ctx.reply('❌ Số tháng không hợp lệ. Nhập lại cả 4 dòng:')
    
    await db.query('INSERT INTO customers(service,name,note,start_date,expiry_date) VALUES($1,$2,$3,$4,$5)',
      [s.service, lines[0], lines[1] === '-' ? null : lines[1], start, addMonths(start, parseInt(lines[3]))])
    clearState(ctx.from.id)
    ctx.reply('✅ Đã thêm khách hàng thành công!')
    return mainMenu(ctx)
  }

  // CHỈNH SỬA THÔNG TIN KHÁCH
  if(s.step.startsWith('edit_')){
    let val = text, col = ''
    if(s.step === 'edit_n') col = 'name'
    if(s.step === 'edit_g') { col = 'note'; val = text === '-' ? null : text }
    if(s.step === 'edit_s' || s.step === 'edit_e'){
      val = parseDateVN(text)
      if(!val) return ctx.reply('❌ Ngày không hợp lệ. Nhập dd/mm/yyyy (Ví dụ: 01/02/2026):')
      col = s.step === 'edit_s' ? 'start_date' : 'expiry_date'
    }
    
    await db.query(`UPDATE customers SET ${col} = $1 WHERE id = $2`, [val, s.id])
    clearState(ctx.from.id)
    ctx.reply('✅ Đã cập nhật thành công!')
    
    ctx.match = [null, s.id.toString()]
    bot.handleUpdate({ callback_query: { id: '0', from: ctx.from, message: ctx.message, data: `mgr_view:${s.id}` } })
    return
  }

  // ĐẶT LỊCH HẸN
  if(s.step === 'rem_datetime'){
    const dt = parseDateTimeFull(text)
    if(!dt) return ctx.reply('❌ Ngày giờ không hợp lệ. Ví dụ: 15/03/2026 09:00:')
    s.remindAt = dt; s.step = 'rem_note'
    return ctx.reply('📝 Nhập ghi chú (hoặc gõ - để bỏ qua):')
  }
  
  if(s.step === 'rem_note'){
    const note = text === '-' ? null : text
    await db.query('INSERT INTO reminders(customer_id, remind_at, note) VALUES($1,$2,$3)', [s.id, s.remindAt, note])
    
    const msg = `✅ Đã lưu lịch hẹn!\n\n`
      + `👤 ${s.customerName} (${s.customerService})\n`
      + `⏰ ${formatDT(s.remindAt)}\n`
      + `📝 ${note ? note : 'Không có'}`
      
    clearState(ctx.from.id)
    ctx.reply(msg)
    return mainMenu(ctx)
  }
})

// ================= CRON JOBS =================
cron.schedule('0 9 * * *', async () => {
  try{
    const res = await db.query(`SELECT * FROM customers WHERE expiry_date <= NOW() + '7 days'::INTERVAL ORDER BY expiry_date ASC`)
    if(res.rows.length){
      let msg = `⏰ BÁO CÁO HÀNG NGÀY\n━━━━━━━━━━━━━━\n`
      res.rows.forEach(u => {
        const d = daysFromNow(u.expiry_date)
        if([7,3,2,1,0,-1,-2].includes(d)){
          msg += `\n${d<=0?'🔴':'🟠'} ${u.name} (${u.service}) - ${d<=0?'quá':'còn'} ${Math.abs(d)} ngày`
        }
      })
      if(msg.includes('🔴') || msg.includes('🟠')) bot.telegram.sendMessage(ADMIN_ID, msg)
    }
  }catch(err){ console.error(err) }
}, { timezone: 'Asia/Ho_Chi_Minh' })

cron.schedule('* * * * *', async () => {
  try{
    const res = await db.query(`SELECT r.id, r.note, c.name, c.service, c.note as cnote FROM reminders r JOIN customers c ON r.customer_id = c.id WHERE r.done = FALSE AND r.remind_at <= NOW()`)
    for(const r of res.rows){
      await bot.telegram.sendMessage(ADMIN_ID, `⏰ HẾT GIỜ HẸN!\n👤 ${r.name} (${r.service})${r.cnote?'\n📝 '+r.cnote:''}${r.note?'\n🗒 '+r.note:''}`)
      await db.query('UPDATE reminders SET done=TRUE WHERE id=$1', [r.id])
    }
  }catch(err){}
})

// ================= START =================
http.createServer((req, res) => { res.writeHead(200); res.end('Bot running') }).listen(process.env.PORT || 3000)
bot.launch({ dropPendingUpdates: true })
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
console.log('🚀 Bot V2 Running OK')
