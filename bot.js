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
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS service TEXT`)
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS gmail TEXT`)
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS start_date TIMESTAMP`)
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMP`)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS contact`)
}

initDB()


// ================= VALIDATION =================

function parseShortDate(text){
  const t = text.trim().replace(/\D/g,'')
  let d, m, y
  if(t.length === 6){
    d = parseInt(t.slice(0,2))
    m = parseInt(t.slice(2,4))
    y = 2000 + parseInt(t.slice(4,6))
  } else if(t.length === 8){
    d = parseInt(t.slice(0,2))
    m = parseInt(t.slice(2,4))
    y = parseInt(t.slice(4,8))
  } else return null
  if(m<1||m>12||d<1||d>31||y<2000||y>2100) return null
  const date = new Date(y, m-1, d)
  if(date.getFullYear()!==y||date.getMonth()!==m-1||date.getDate()!==d) return null
  return date
}

function isValidMonths(text){
  const n = parseInt(text.trim())
  return !isNaN(n) && n > 0 && n <= 120 && String(n) === text.trim()
}

function isValidText(text){
  return text && text.trim().length > 0
}


// ================= MENU =================

function mainMenu(ctx){
  return ctx.reply(
    "👑 PREMIUM MANAGER",
    Markup.keyboard([
      ['➕ Thêm khách'],
      ['🗑 Xóa khách'],
      ['✏️ Sửa khách'],
      ['📊 Thống kê'],
      ['📥 Export Excel'],
      ['🔴 Reset DB']
    ]).resize()
  )
}

bot.use((ctx,next)=>{
  if(ctx.from.id !== ADMIN_ID) return
  next()
})

bot.start(ctx=>mainMenu(ctx))


// ================= STATE =================

let state = {}

// ── Keyboard dịch vụ: thêm ChatGPT Plus, đổi ChatGPT → ChatGPT GO
const serviceKeyboard =
  Markup.keyboard([
    ['ChatGPT Plus'],
    ['ChatGPT GO'],
    ['YouTube'],
    ['CapCut'],
    ['⬅️ Hủy']
  ]).resize()

const editKeyboard =
  Markup.keyboard([
    ['Tên'],
    ['Gmail'],
    ['Số tháng'],
    ['Ngày bắt đầu'],
    ['Ngày hết hạn'],
    ['⬅️ Hủy']
  ]).resize()


// ================= ADD =================

bot.hears('➕ Thêm khách', ctx=>{
  state[ctx.from.id] = { step: "add_service" }
  ctx.reply("Chọn dịch vụ:", serviceKeyboard)
})


// ================= DELETE =================

bot.hears('🗑 Xóa khách', async ctx=>{
  try{
    const res = await db.query("SELECT name, service FROM customers ORDER BY service, name")
    if(!res.rows.length) return ctx.reply("Không có khách")
    const buttons = res.rows.map(u=>[`${u.name} (${u.service})`])
    buttons.push(['⬅️ Hủy'])
    state[ctx.from.id] = { step: "delete_select" }
    ctx.reply("Chọn khách cần xóa:", Markup.keyboard(buttons).resize())
  }catch(err){ console.error(err); ctx.reply("❌ Lỗi: "+err.message) }
})


// ================= EDIT =================

bot.hears('✏️ Sửa khách', async ctx=>{
  try{
    const res = await db.query("SELECT name, service FROM customers ORDER BY service, name")
    if(!res.rows.length) return ctx.reply("Không có khách")
    const buttons = res.rows.map(u=>[`${u.name} (${u.service})`])
    buttons.push(['⬅️ Hủy'])
    state[ctx.from.id] = { step: "edit_select_user" }
    ctx.reply("Chọn khách cần sửa:", Markup.keyboard(buttons).resize())
  }catch(err){ console.error(err); ctx.reply("❌ Lỗi: "+err.message) }
})


// ================= STATS =================

bot.hears('📊 Thống kê', ctx=>{
  state[ctx.from.id] = { step: "view_service" }
  ctx.reply("Chọn dịch vụ:", serviceKeyboard)
})


// ================= EXPORT =================

bot.hears('📥 Export Excel', async ctx=>{
  try{
    const res = await db.query("SELECT * FROM customers ORDER BY service, expiry_date")
    if(!res.rows.length) return ctx.reply("Không có dữ liệu")

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet("Customers")

    ws.columns=[
      {header:'Service',key:'service',width:18},
      {header:'Name',key:'name',width:20},
      {header:'Gmail',key:'gmail',width:30},
      {header:'Start',key:'start',width:15},
      {header:'Expiry',key:'expiry',width:15}
    ]

    res.rows.forEach(u=>{
      ws.addRow({
        service: u.service,
        name: u.name,
        gmail: u.gmail,
        start: format(u.start_date),
        expiry: format(u.expiry_date)
      })
    })

    const file = "customers.xlsx"
    await wb.xlsx.writeFile(file)
    await ctx.replyWithDocument({source:file})
    fs.unlinkSync(file)
  }catch(err){ console.error(err); ctx.reply("❌ Lỗi: "+err.message) }
})


// ================= RESET DB =================

bot.hears('🔴 Reset DB', ctx=>{
  state[ctx.from.id] = { step: "reset_confirm" }
  ctx.reply(
    "⚠️ Bạn có chắc muốn XÓA TOÀN BỘ dữ liệu không?\nHành động này KHÔNG THỂ HOÀN TÁC!",
    Markup.keyboard([
      ['✅ XÁC NHẬN RESET'],
      ['⬅️ Hủy']
    ]).resize()
  )
})


// ================= TEXT HANDLER =================

bot.on('text', async ctx=>{
  try{
    const text = ctx.message.text.trim()
    const s = state[ctx.from.id]

    if(text === '⬅️ Hủy'){
      delete state[ctx.from.id]
      return mainMenu(ctx)
    }

    if(!s) return


    // ── RESET CONFIRM ──────────────────────────────

    if(s.step === "reset_confirm"){
      if(text === '✅ XÁC NHẬN RESET'){
        await db.query("TRUNCATE TABLE customers RESTART IDENTITY")
        delete state[ctx.from.id]
        ctx.reply("✅ Đã reset toàn bộ database!")
        return mainMenu(ctx)
      }
      return
    }


    // ── DELETE ─────────────────────────────────────

    if(s.step === "delete_select"){
      // Parse tên từ format "Tên (Dịch vụ)"
      const match = text.match(/^(.+)\s\((.+)\)$/)
      if(!match) return ctx.reply("❌ Không nhận dạng được. Thử lại.")
      const [, name, service] = match
      await db.query("DELETE FROM customers WHERE name=$1 AND service=$2",[name, service])
      delete state[ctx.from.id]
      ctx.reply("🗑 Đã xóa")
      return mainMenu(ctx)
    }


    // ── EDIT SELECT USER ───────────────────────────

    if(s.step === "edit_select_user"){
      const match = text.match(/^(.+)\s\((.+)\)$/)
      if(!match) return ctx.reply("❌ Không nhận dạng được. Thử lại.")
      const [, name, service] = match
      s.name = name
      s.service = service
      s.step = "edit_field"
      return ctx.reply("Chọn field cần sửa:", editKeyboard)
    }


    // ── EDIT FIELD ─────────────────────────────────

    if(s.step === "edit_field"){
      s.field = text
      s.step = "edit_value"

      if(s.field === "Ngày bắt đầu" || s.field === "Ngày hết hạn")
        return ctx.reply("Nhập ngày (ddmmyy hoặc ddmmyyyy):\nVí dụ: 210226 hoặc 21022026")

      if(s.field === "Số tháng")
        return ctx.reply("Nhập số tháng (1-120):")

      return ctx.reply("Nhập giá trị mới:")
    }


    // ── EDIT VALUE ─────────────────────────────────

    if(s.step === "edit_value"){

      if(s.field === "Tên"){
        if(!isValidText(text)) return ctx.reply("❌ Tên không được để trống. Nhập lại:")
        await db.query("UPDATE customers SET name=$1 WHERE name=$2 AND service=$3",[text,s.name,s.service])
      }

      if(s.field === "Gmail"){
        if(!isValidText(text)) return ctx.reply("❌ Gmail không được để trống. Nhập lại:")
        await db.query("UPDATE customers SET gmail=$1 WHERE name=$2 AND service=$3",[text,s.name,s.service])
      }

      if(s.field === "Số tháng"){
        if(!isValidMonths(text)) return ctx.reply("❌ Số tháng không hợp lệ!\nNhập số nguyên từ 1-120:")
        const months = parseInt(text)
        const start = new Date()
        const expiry = new Date(start.getTime()+months*30*86400000)
        await db.query(
          "UPDATE customers SET start_date=$1, expiry_date=$2 WHERE name=$3 AND service=$4",
          [start,expiry,s.name,s.service]
        )
      }

      if(s.field === "Ngày bắt đầu"){
        const d = parseShortDate(text)
        if(!d) return ctx.reply("❌ Ngày không hợp lệ!\nVí dụ: 210226 hoặc 21022026")
        await db.query("UPDATE customers SET start_date=$1 WHERE name=$2 AND service=$3",[d,s.name,s.service])
      }

      if(s.field === "Ngày hết hạn"){
        const d = parseShortDate(text)
        if(!d) return ctx.reply("❌ Ngày không hợp lệ!\nVí dụ: 210226 hoặc 21022026")
        await db.query("UPDATE customers SET expiry_date=$1 WHERE name=$2 AND service=$3",[d,s.name,s.service])
      }

      delete state[ctx.from.id]
      ctx.reply("✅ Đã cập nhật")
      return mainMenu(ctx)
    }


    // ── ADD FLOW ───────────────────────────────────

    if(s.step === "add_service"){
      // Kiểm tra dịch vụ hợp lệ
      const validServices = ['ChatGPT Plus', 'ChatGPT GO', 'YouTube', 'CapCut']
      if(!validServices.includes(text)) return ctx.reply("❌ Chọn dịch vụ hợp lệ:", serviceKeyboard)
      s.service = text
      s.step = "add_form"
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

    if(s.step === "add_form"){
      const lines = text.split('\n').map(l=>l.trim()).filter(l=>l.length>0)

      if(lines.length < 4)
        return ctx.reply("❌ Cần đủ 4 dòng:\nTên\nGmail\nNgày bắt đầu (ddmmyy)\nSố tháng")

      const [name, gmail, dateRaw, monthsRaw] = lines

      if(!isValidText(name))
        return ctx.reply("❌ Dòng 1 (Tên) không hợp lệ. Nhập lại:")

      if(!isValidText(gmail))
        return ctx.reply("❌ Dòng 2 (Gmail) không hợp lệ. Nhập lại:")

      const start = parseShortDate(dateRaw)
      if(!start)
        return ctx.reply("❌ Dòng 3 (Ngày) không hợp lệ!\nVí dụ: 210226 (21/02/2026). Nhập lại:")

      if(!isValidMonths(monthsRaw))
        return ctx.reply("❌ Dòng 4 (Số tháng) không hợp lệ! Nhập số nguyên 1-120. Nhập lại:")

      const months = parseInt(monthsRaw)
      const expiry = new Date(start.getTime()+months*30*86400000)

      await db.query(
        `INSERT INTO customers(service,name,gmail,start_date,expiry_date)
         VALUES($1,$2,$3,$4,$5)`,
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


    // ── VIEW SERVICE ───────────────────────────────

    if(s.step === "view_service"){
      await showService(ctx, text)
      delete state[ctx.from.id]
      return mainMenu(ctx)
    }

  }catch(err){
    console.error("TEXT HANDLER ERROR:", err)
    delete state[ctx.from.id]
    ctx.reply("❌ Lỗi: " + err.message + "\n\nVui lòng thử lại.")
    return mainMenu(ctx)
  }
})


// ================= SHOW =================

async function showService(ctx, service){
  const res = await db.query(
    "SELECT * FROM customers WHERE service=$1 ORDER BY expiry_date",
    [service]
  )

  if(!res.rows.length) return ctx.reply(`Không có khách nào dùng ${service}`)

  let msg = `📋 ${service}\n━━━━━━━━━━━━━━`

  const now = Date.now()

  res.rows.forEach(u=>{
    const diff = Math.ceil((new Date(u.expiry_date)-now)/86400000)
    let icon = "🟢"
    if(diff<=1) icon = "🔴"
    else if(diff<=3) icon = "🟠"

    msg += `\n\n${icon} ${u.name}
📧 ${u.gmail}
📅 ${format(u.start_date)} → ${format(u.expiry_date)}
━━━━━━━━━━━━━━`
  })

  ctx.reply(msg)
}


// ================= REMINDER =================

cron.schedule('0 9 * * *', async ()=>{
  const res = await db.query("SELECT * FROM customers")
  const now = new Date()

  for(const u of res.rows){
    const diff = Math.ceil((new Date(u.expiry_date)-now)/86400000)

    if(diff <= 3 && diff > 0){
      bot.telegram.sendMessage(ADMIN_ID,
`⚠️ Sắp hết hạn

👤 ${u.name}
📦 ${u.service}
📧 ${u.gmail}

📅 HSD: ${format(u.expiry_date)}`)
    }

    if(diff < 0)
      await db.query("DELETE FROM customers WHERE id=$1",[u.id])
  }
},{timezone:"Asia/Ho_Chi_Minh"})


// ================= DATE =================

function format(d){
  return new Date(d).toLocaleDateString("vi-VN",{timeZone:"Asia/Ho_Chi_Minh"})
}


// ================= HTTP =================

const PORT = process.env.PORT || 3000

http.createServer((req,res)=>{
  res.writeHead(200)
  res.end("Bot running")
}).listen(PORT)


// ================= START =================

bot.launch({dropPendingUpdates:true})

setInterval(()=>{},1000)

console.log("Bot running OK")

