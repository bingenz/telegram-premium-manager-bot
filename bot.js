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
      gmail TEXT,
      start_date TIMESTAMP,
      expiry_date TIMESTAMP
    )
  `)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS contact`)
}

initDB()


// ================= HELPERS =================

function format(d){
  return new Date(d).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
}

function daysFromNow(d){
  return Math.ceil((new Date(d) - Date.now()) / 86400000)
}

function parseShortDate(text){
  const t = text.trim().replace(/\D/g, '')
  let d, m, y
  if(t.length === 6){
    d = parseInt(t.slice(0,2)); m = parseInt(t.slice(2,4)); y = 2000 + parseInt(t.slice(4,6))
  } else if(t.length === 8){
    d = parseInt(t.slice(0,2)); m = parseInt(t.slice(2,4)); y = parseInt(t.slice(4,8))
  } else return null
  if(m<1||m>12||d<1||d>31||y<2000||y>2100) return null
  const date = new Date(y, m-1, d)
  if(date.getFullYear()!==y || date.getMonth()!==m-1 || date.getDate()!==d) return null
  return date
}

function isValidMonths(text){
  const n = parseInt(text.trim())
  return !isNaN(n) && n > 0 && n <= 120 && String(n) === text.trim()
}

function isValidText(text){
  return text && text.trim().length > 0
}

function parseDateVN(text){
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if(!m) return null
  const d = parseInt(m[1]), mo = parseInt(m[2]), y = parseInt(m[3])
  if(mo<1||mo>12||d<1||d>31||y<2000||y>2100) return null
  const date = new Date(y, mo-1, d)
  if(date.getFullYear()!==y||date.getMonth()!==mo-1||date.getDate()!==d) return null
  return date
}


// ================= CONSTANTS =================

const SERVICE_LIST = ['ChatGPT Plus', 'ChatGPT GO', 'YouTube', 'CapCut']

const serviceKeyboard = Markup.keyboard([
  ['ChatGPT Plus', 'ChatGPT GO'],
  ['YouTube', 'CapCut'],
  ['⬅️ Hủy']
]).resize()


// ================= MENU =================

function mainMenu(ctx){
  return ctx.reply(
    '👑 PREMIUM MANAGER',
    Markup.keyboard([
      ['➕ Thêm khách'],
      ['🗑 Xóa khách', '✏️ Sửa khách'],
      ['📊 Thống kê', '📋 Khách hết hạn'],
      ['📥 Export Excel', '🔴 Reset DB']
    ]).resize()
  )
}

bot.use((ctx, next) => {
  if(ctx.from.id !== ADMIN_ID) return
  next()
})

bot.start(ctx => mainMenu(ctx))


// ================= STATE =================

let state = {}


// ================= ADD =================

bot.hears('➕ Thêm khách', ctx => {
  state[ctx.from.id] = { step: 'add_service' }
  ctx.reply('Chọn dịch vụ:', serviceKeyboard)
})


// ================= DELETE (inline, không cần state) =================

bot.hears('🗑 Xóa khách', async ctx => {
  try{
    const res = await db.query('SELECT id, name, service FROM customers ORDER BY service, name')
    if(!res.rows.length) return ctx.reply('Không có khách')
    ctx.reply(
      'Chọn khách cần xóa:',
      Markup.inlineKeyboard(
        res.rows.map(u => [Markup.button.callback(`${u.name} (${u.service})`, `del_pick:${u.id}`)])
      )
    )
  }catch(err){ console.error(err); ctx.reply('❌ Lỗi: ' + err.message) }
})

bot.action(/^del_pick:(\d+)$/, async ctx => {
  try{
    const id = parseInt(ctx.match[1])
    const res = await db.query('SELECT * FROM customers WHERE id=$1', [id])
    if(!res.rows.length){
      await ctx.answerCbQuery('Không tìm thấy!')
      return ctx.editMessageText('❌ Khách này không còn tồn tại.')
    }
    const u = res.rows[0]
    await ctx.answerCbQuery()
    await ctx.editMessageText(
`⚠️ XÁC NHẬN XÓA?

👤 ${u.name}
📦 ${u.service} · 📧 ${u.gmail}
📅 ${format(u.start_date)} → ${format(u.expiry_date)}`,
      Markup.inlineKeyboard([[
        Markup.button.callback('✅ Xóa', `del_exec:${id}`),
        Markup.button.callback('❌ Hủy', 'del_abort')
      ]])
    )
  }catch(err){ console.error(err); ctx.answerCbQuery('❌ Lỗi') }
})

bot.action(/^del_exec:(\d+)$/, async ctx => {
  try{
    const id = parseInt(ctx.match[1])
    const res = await db.query('SELECT name FROM customers WHERE id=$1', [id])
    if(res.rows.length){
      await db.query('DELETE FROM customers WHERE id=$1', [id])
      await ctx.answerCbQuery(`✅ Đã xóa ${res.rows[0].name}`)
    } else {
      await ctx.answerCbQuery('Khách đã bị xóa rồi!')
    }
    await ctx.editMessageText('🗑 Đã xóa khách.')
  }catch(err){ console.error(err); ctx.answerCbQuery('❌ Lỗi') }
})

bot.action('del_abort', async ctx => {
  await ctx.answerCbQuery('Đã hủy')
  await ctx.editMessageText('↩️ Đã hủy thao tác xóa.')
})


// ================= EDIT =================

bot.hears('✏️ Sửa khách', async ctx => {
  try{
    const res = await db.query('SELECT id, name, service FROM customers ORDER BY service, name')
    if(!res.rows.length) return ctx.reply('Không có khách')
    ctx.reply(
      'Chọn khách cần sửa:',
      Markup.inlineKeyboard(
        res.rows.map(u => [Markup.button.callback(`${u.name} (${u.service})`, `edit_pick:${u.id}`)])
      )
    )
  }catch(err){ console.error(err); ctx.reply('❌ Lỗi: ' + err.message) }
})

bot.action(/^edit_pick:(\d+)$/, async ctx => {
  try{
    const id = parseInt(ctx.match[1])
    const res = await db.query('SELECT * FROM customers WHERE id=$1', [id])
    if(!res.rows.length){
      await ctx.answerCbQuery('Không tìm thấy khách!')
      return ctx.editMessageText('❌ Khách này không còn tồn tại.')
    }
    const u = res.rows[0]
    await ctx.answerCbQuery()
    state[ctx.from.id] = { step: 'edit_paste', id }
    await ctx.editMessageText(
`✏️ THÔNG TIN HIỆN TẠI

Copy toàn bộ, sửa dòng cần đổi rồi gửi lại:

Tên: ${u.name}
Gmail: ${u.gmail}
Ngày bắt đầu: ${format(u.start_date)}
Ngày hết hạn: ${format(u.expiry_date)}`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Hủy', 'edit_abort')]])
    )
  }catch(err){ console.error(err); ctx.answerCbQuery('❌ Lỗi') }
})

bot.action('edit_abort', async ctx => {
  delete state[ctx.from.id]
  await ctx.answerCbQuery('Đã hủy')
  await ctx.editMessageText('↩️ Đã hủy thao tác sửa.')
})


// ================= STATS (inline, không cần state) =================

bot.hears('📊 Thống kê', ctx => {
  ctx.reply(
    'Chọn dịch vụ:',
    Markup.inlineKeyboard(
      SERVICE_LIST.map(s => [Markup.button.callback(s, `stats:${s}`)])
    )
  )
})

bot.action(/^stats:(.+)$/, async ctx => {
  try{
    const service = ctx.match[1]
    const res = await db.query(
      'SELECT * FROM customers WHERE service=$1 ORDER BY expiry_date', [service]
    )
    await ctx.answerCbQuery()

    if(!res.rows.length) return ctx.editMessageText(`Không có khách nào dùng ${service}`)

    let msg = `📋 ${service}\n━━━━━━━━━━━━━━`
    res.rows.forEach(u => {
      const diff = daysFromNow(u.expiry_date)
      const icon = diff <= 0 ? '🔴' : diff <= 3 ? '🟠' : '🟢'
      msg += `\n\n${icon} ${u.name}\n📧 ${u.gmail}\n📅 ${format(u.start_date)} → ${format(u.expiry_date)}\n━━━━━━━━━━━━━━`
    })

    await ctx.editMessageText(msg)
  }catch(err){ console.error(err); ctx.answerCbQuery('❌ Lỗi') }
})


// ================= EXPIRED LIST =================

function buildExpiredView(rows){
  if(!rows.length) return {
    msg: '✅ Không còn khách nào hết hạn!',
    keyboard: Markup.inlineKeyboard([])
  }

  const lines = rows.map(u => {
    const d = -daysFromNow(u.expiry_date)
    return `🔴 ${u.name} · ${u.service} · ${u.gmail} · quá ${d} ngày`
  }).join('\n')

  const msg = `📋 KHÁCH HẾT HẠN (${rows.length})\n━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━\n👇 Bấm tên để xóa:`

  const keyboard = Markup.inlineKeyboard(
    rows.map(u => {
      const d = -daysFromNow(u.expiry_date)
      return [Markup.button.callback(`🗑 ${u.name} (${u.service}) — ${d} ngày`, `exp_pick:${u.id}`)]
    })
  )

  return { msg, keyboard }
}

async function sendExpiredList(target, isCtx = true){
  const res = await db.query('SELECT * FROM customers WHERE expiry_date < NOW() ORDER BY expiry_date')
  const { msg, keyboard } = buildExpiredView(res.rows)
  if(isCtx){
    await target.reply(msg, keyboard)
  } else {
    await bot.telegram.sendMessage(target, msg, { reply_markup: keyboard.reply_markup })
  }
}

bot.hears('📋 Khách hết hạn', async ctx => {
  try{ await sendExpiredList(ctx) }
  catch(err){ console.error(err); ctx.reply('❌ Lỗi: ' + err.message) }
})

bot.action(/^exp_pick:(\d+)$/, async ctx => {
  try{
    const id = parseInt(ctx.match[1])
    const res = await db.query('SELECT * FROM customers WHERE id=$1', [id])
    if(!res.rows.length){
      await ctx.answerCbQuery('Khách này đã bị xóa!')
      const all = await db.query('SELECT * FROM customers WHERE expiry_date < NOW() ORDER BY expiry_date')
      const { msg, keyboard } = buildExpiredView(all.rows)
      return ctx.editMessageText(msg, keyboard)
    }
    const u = res.rows[0]
    const d = -daysFromNow(u.expiry_date)
    await ctx.answerCbQuery()
    await ctx.editMessageText(
`⚠️ XÁC NHẬN XÓA?

👤 ${u.name}
📦 ${u.service} · 📧 ${u.gmail}
📅 ${format(u.start_date)} → ${format(u.expiry_date)}
⏰ Quá hạn: ${d} ngày`,
      Markup.inlineKeyboard([[
        Markup.button.callback('✅ Xóa', `exp_del:${id}`),
        Markup.button.callback('↩️ Quay lại', 'exp_back')
      ]])
    )
  }catch(err){ console.error(err); ctx.answerCbQuery('❌ Lỗi') }
})

bot.action(/^exp_del:(\d+)$/, async ctx => {
  try{
    const id = parseInt(ctx.match[1])
    const res = await db.query('SELECT name FROM customers WHERE id=$1', [id])
    if(res.rows.length){
      await db.query('DELETE FROM customers WHERE id=$1', [id])
      await ctx.answerCbQuery(`✅ Đã xóa ${res.rows[0].name}`)
    } else {
      await ctx.answerCbQuery('Khách đã bị xóa rồi!')
    }
    const remaining = await db.query('SELECT * FROM customers WHERE expiry_date < NOW() ORDER BY expiry_date')
    const { msg, keyboard } = buildExpiredView(remaining.rows)
    await ctx.editMessageText(msg, keyboard)
  }catch(err){ console.error(err); ctx.answerCbQuery('❌ Lỗi') }
})

bot.action('exp_back', async ctx => {
  try{
    await ctx.answerCbQuery()
    const res = await db.query('SELECT * FROM customers WHERE expiry_date < NOW() ORDER BY expiry_date')
    const { msg, keyboard } = buildExpiredView(res.rows)
    await ctx.editMessageText(msg, keyboard)
  }catch(err){ console.error(err); ctx.answerCbQuery('❌ Lỗi') }
})


// ================= EXPORT =================

bot.hears('📥 Export Excel', async ctx => {
  try{
    const res = await db.query('SELECT * FROM customers ORDER BY service, expiry_date')
    if(!res.rows.length) return ctx.reply('Không có dữ liệu')

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Customers')
    ws.columns = [
      { header: 'Service', key: 'service', width: 18 },
      { header: 'Name',    key: 'name',    width: 20 },
      { header: 'Gmail',   key: 'gmail',   width: 30 },
      { header: 'Start',   key: 'start',   width: 15 },
      { header: 'Expiry',  key: 'expiry',  width: 15 }
    ]
    res.rows.forEach(u => ws.addRow({
      service: u.service, name: u.name, gmail: u.gmail,
      start: format(u.start_date), expiry: format(u.expiry_date)
    }))

    const file = 'customers.xlsx'
    await wb.xlsx.writeFile(file)
    await ctx.replyWithDocument({ source: file })
    fs.unlinkSync(file)
  }catch(err){ console.error(err); ctx.reply('❌ Lỗi: ' + err.message) }
})


// ================= RESET DB (inline, không cần state) =================

bot.hears('🔴 Reset DB', ctx => {
  ctx.reply(
    '⚠️ Bạn có chắc muốn XÓA TOÀN BỘ dữ liệu không?\nHành động này KHÔNG THỂ HOÀN TÁC!',
    Markup.inlineKeyboard([[
      Markup.button.callback('✅ XÁC NHẬN RESET', 'reset_exec'),
      Markup.button.callback('❌ Hủy', 'reset_abort')
    ]])
  )
})

bot.action('reset_exec', async ctx => {
  try{
    await db.query('TRUNCATE TABLE customers RESTART IDENTITY')
    await ctx.answerCbQuery('✅ Đã reset!')
    await ctx.editMessageText('✅ Đã xóa toàn bộ database!')
  }catch(err){ console.error(err); ctx.answerCbQuery('❌ Lỗi') }
})

bot.action('reset_abort', async ctx => {
  await ctx.answerCbQuery('Đã hủy')
  await ctx.editMessageText('↩️ Đã hủy reset.')
})


// ================= TEXT HANDLER =================

bot.on('text', async ctx => {
  try{
    const text = ctx.message.text.trim()
    const s = state[ctx.from.id]

    if(text === '⬅️ Hủy'){
      delete state[ctx.from.id]
      return mainMenu(ctx)
    }

    if(!s) return


    // ── EDIT PASTE ─────────────────────────────────

    if(s.step === 'edit_paste'){
      const { id } = s
      const parsed = {}
      for(const line of text.split('\n')){
        const m = line.match(/^(.+?):\s*(.+)$/)
        if(!m) continue
        const key = m[1].trim()
        const val = m[2].trim()
        if(key === 'Tên') parsed.name = val
        else if(key === 'Gmail') parsed.gmail = val
        else if(key === 'Ngày bắt đầu') parsed.start_date = parseDateVN(val)
        else if(key === 'Ngày hết hạn') parsed.expiry_date = parseDateVN(val)
      }

      if('start_date' in parsed && !parsed.start_date)
        return ctx.reply('❌ Ngày bắt đầu không hợp lệ!\nĐịnh dạng: dd/mm/yyyy (vd: 01/02/2026)')
      if('expiry_date' in parsed && !parsed.expiry_date)
        return ctx.reply('❌ Ngày hết hạn không hợp lệ!\nĐịnh dạng: dd/mm/yyyy (vd: 01/03/2026)')

      const cur = await db.query('SELECT * FROM customers WHERE id=$1', [id])
      if(!cur.rows.length){
        delete state[ctx.from.id]
        ctx.reply('❌ Không tìm thấy khách!')
        return mainMenu(ctx)
      }
      const u = cur.rows[0]

      const updates = []; const values = []; let i = 1
      if(parsed.name      && parsed.name !== u.name)                               { updates.push(`name=$${i++}`);        values.push(parsed.name) }
      if(parsed.gmail     && parsed.gmail !== u.gmail)                             { updates.push(`gmail=$${i++}`);       values.push(parsed.gmail) }
      if(parsed.start_date && format(parsed.start_date) !== format(u.start_date)) { updates.push(`start_date=$${i++}`);  values.push(parsed.start_date) }
      if(parsed.expiry_date && format(parsed.expiry_date) !== format(u.expiry_date)){ updates.push(`expiry_date=$${i++}`); values.push(parsed.expiry_date) }

      if(!updates.length){
        delete state[ctx.from.id]
        ctx.reply('ℹ️ Không có thay đổi nào.')
        return mainMenu(ctx)
      }

      values.push(id)
      await db.query(`UPDATE customers SET ${updates.join(', ')} WHERE id=$${i}`, values)

      const lines = []
      if(parsed.name       && parsed.name !== u.name)                                lines.push(`👤 Tên: ${u.name} → ${parsed.name}`)
      if(parsed.gmail      && parsed.gmail !== u.gmail)                              lines.push(`📧 Gmail: ${u.gmail} → ${parsed.gmail}`)
      if(parsed.start_date && format(parsed.start_date) !== format(u.start_date))   lines.push(`📅 Ngày bắt đầu: ${format(u.start_date)} → ${format(parsed.start_date)}`)
      if(parsed.expiry_date && format(parsed.expiry_date) !== format(u.expiry_date)) lines.push(`📅 Ngày hết hạn: ${format(u.expiry_date)} → ${format(parsed.expiry_date)}`)

      delete state[ctx.from.id]
      ctx.reply(`✅ Đã cập nhật\n\n${lines.join('\n')}`)
      return mainMenu(ctx)
    }


    // ── ADD SERVICE ────────────────────────────────

    if(s.step === 'add_service'){
      if(!SERVICE_LIST.includes(text)) return ctx.reply('❌ Chọn dịch vụ hợp lệ:', serviceKeyboard)
      s.service = text; s.step = 'add_form'
      return ctx.reply(
`📋 Điền thông tin khách (mỗi dòng 1 mục):

Tên khách:
Gmail:
Ngày bắt đầu (ddmmyy):
Số tháng đăng ký:

Ví dụ:
nguyen van a
abc@gmail.com
210226
1`,
        Markup.removeKeyboard()
      )
    }


    // ── ADD FORM ───────────────────────────────────

    if(s.step === 'add_form'){
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
      if(lines.length < 4) return ctx.reply('❌ Cần đủ 4 dòng:\nTên\nGmail\nNgày bắt đầu (ddmmyy)\nSố tháng')

      const [name, gmail, dateRaw, monthsRaw] = lines
      if(!isValidText(name))        return ctx.reply('❌ Dòng 1 (Tên) không hợp lệ. Nhập lại:')
      if(!isValidText(gmail))       return ctx.reply('❌ Dòng 2 (Gmail) không hợp lệ. Nhập lại:')

      const start = parseShortDate(dateRaw)
      if(!start) return ctx.reply('❌ Dòng 3 (Ngày) không hợp lệ!\nVí dụ: 210226 (21/02/2026). Nhập lại:')

      if(!isValidMonths(monthsRaw)) return ctx.reply('❌ Dòng 4 (Số tháng) không hợp lệ! Nhập số nguyên 1-120. Nhập lại:')

      const months = parseInt(monthsRaw)
      const expiry = new Date(start.getTime() + months * 30 * 86400000)

      await db.query(
        'INSERT INTO customers(service,name,gmail,start_date,expiry_date) VALUES($1,$2,$3,$4,$5)',
        [s.service, name, gmail, start, expiry]
      )

      delete state[ctx.from.id]
      ctx.reply(
`✅ Đã thêm khách!

📦 ${s.service}
👤 ${name}
📧 ${gmail}
📅 ${format(start)} → ${format(expiry)}`)
      return mainMenu(ctx)
    }

  }catch(err){
    console.error('TEXT HANDLER ERROR:', err)
    delete state[ctx.from.id]
    ctx.reply('❌ Lỗi: ' + err.message + '\n\nVui lòng thử lại.')
    return mainMenu(ctx)
  }
})


// ================= REMINDER =================

cron.schedule('0 9 * * *', async () => {
  try{
    const res = await db.query('SELECT * FROM customers')
    const WARN_DAYS = [7, 3, 2, 1]

    // ── 1. Khách sắp hết hạn (7, 3, 2, 1 ngày)
    const soonList = res.rows.filter(u => WARN_DAYS.includes(daysFromNow(u.expiry_date)))

    if(soonList.length){
      const lines = soonList.map(u => {
        const diff = daysFromNow(u.expiry_date)
        return `👤 ${u.name} · ${u.service}\n📧 ${u.gmail}\n📅 HSD: ${format(u.expiry_date)} · còn ${diff} ngày`
      }).join('\n\n')
      await bot.telegram.sendMessage(ADMIN_ID,
        `⚠️ SẮP HẾT HẠN (${soonList.length})\n━━━━━━━━━━━━━━\n\n${lines}`
      )
    }

    // ── 2. Khách đã hết hạn
    const expiredList = res.rows.filter(u => daysFromNow(u.expiry_date) <= 0)

    if(expiredList.length){
      const lines = expiredList.map(u => {
        const over = -daysFromNow(u.expiry_date)
        return `🔴 ${u.name} · ${u.service}\n📧 ${u.gmail}\n📅 HSD: ${format(u.expiry_date)} · quá ${over} ngày`
      }).join('\n\n')
      await bot.telegram.sendMessage(ADMIN_ID,
        `🔴 ĐÃ HẾT HẠN (${expiredList.length})\n━━━━━━━━━━━━━━\n\n${lines}`
      )
    }

  }catch(err){
    console.error('CRON ERROR:', err)
  }
}, { timezone: 'Asia/Ho_Chi_Minh' })


// ================= HTTP =================

http.createServer((req, res) => {
  res.writeHead(200)
  res.end('Bot running')
}).listen(process.env.PORT || 3000)


// ================= START =================

bot.launch({ dropPendingUpdates: true })

setInterval(() => {}, 1000)

console.log('Bot running OK')


