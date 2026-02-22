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
  contact TEXT,
  start_date TIMESTAMP,
  expiry_date TIMESTAMP
 )
 `)
}

initDB()


// ================= VALIDATION =================

function isValidDate(text){
 // Phải đúng định dạng dd/mm/yyyy
 if(!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text.trim())) return false
 const p = text.trim().split("/")
 const d = parseInt(p[0])
 const m = parseInt(p[1])
 const y = parseInt(p[2])
 if(m < 1 || m > 12) return false
 if(d < 1 || d > 31) return false
 if(y < 2000 || y > 2100) return false
 // Kiểm tra ngày thực tế hợp lệ
 const date = new Date(y, m-1, d)
 if(date.getFullYear() !== y || date.getMonth() !== m-1 || date.getDate() !== d) return false
 return true
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

const serviceKeyboard =
Markup.keyboard([
 ['ChatGPT'],
 ['YouTube'],
 ['CapCut'],
 ['⬅️ Hủy']
]).resize()

const editKeyboard =
Markup.keyboard([
 ['Tên'],
 ['Gmail'],
 ['Liên hệ'],
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
  const res = await db.query("SELECT name FROM customers ORDER BY name")
  if(!res.rows.length) return ctx.reply("Không có khách")
  const buttons = res.rows.map(u=>[u.name])
  buttons.push(['⬅️ Hủy'])
  state[ctx.from.id] = { step: "delete_select" }
  ctx.reply("Chọn khách cần xóa:", Markup.keyboard(buttons).resize())
 }catch(err){ console.error(err); ctx.reply("❌ Lỗi: "+err.message) }
})


// ================= EDIT =================

bot.hears('✏️ Sửa khách', async ctx=>{
 try{
  const res = await db.query("SELECT name FROM customers ORDER BY name")
  if(!res.rows.length) return ctx.reply("Không có khách")
  const buttons = res.rows.map(u=>[u.name])
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
   {header:'Service',key:'service',width:15},
   {header:'Name',key:'name',width:20},
   {header:'Gmail',key:'gmail',width:30},
   {header:'Contact',key:'contact',width:30},
   {header:'Start',key:'start',width:15},
   {header:'Expiry',key:'expiry',width:15}
  ]

  res.rows.forEach(u=>{
   ws.addRow({
    service:u.service,
    name:u.name,
    gmail:u.gmail,
    contact:u.contact,
    start:format(u.start_date),
    expiry:format(u.expiry_date)
   })
  })

  const file="customers.xlsx"
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
   await db.query("DELETE FROM customers WHERE name=$1",[text])
   delete state[ctx.from.id]
   ctx.reply("🗑 Đã xóa")
   return mainMenu(ctx)
  }


  // ── EDIT SELECT USER ───────────────────────────

  if(s.step === "edit_select_user"){
   s.name = text
   s.step = "edit_field"
   return ctx.reply("Chọn field cần sửa:", editKeyboard)
  }


  // ── EDIT FIELD ─────────────────────────────────

  if(s.step === "edit_field"){
   s.field = text
   s.step = "edit_value"

   if(s.field === "Ngày bắt đầu" || s.field === "Ngày hết hạn")
    return ctx.reply("Nhập ngày (dd/mm/yyyy):")

   if(s.field === "Số tháng")
    return ctx.reply("Nhập số tháng (1-120):")

   return ctx.reply("Nhập giá trị mới:")
  }


  // ── EDIT VALUE ─────────────────────────────────

  if(s.step === "edit_value"){

   if(s.field === "Tên"){
    if(!isValidText(text))
     return ctx.reply("❌ Tên không được để trống. Nhập lại:")
    await db.query("UPDATE customers SET name=$1 WHERE name=$2",[text,s.name])
   }

   if(s.field === "Gmail"){
    if(!isValidText(text))
     return ctx.reply("❌ Gmail không được để trống. Nhập lại:")
    await db.query("UPDATE customers SET gmail=$1 WHERE name=$2",[text,s.name])
   }

   if(s.field === "Liên hệ"){
    if(!isValidText(text))
     return ctx.reply("❌ Liên hệ không được để trống. Nhập lại:")
    await db.query("UPDATE customers SET contact=$1 WHERE name=$2",[text,s.name])
   }

   if(s.field === "Số tháng"){
    if(!isValidMonths(text))
     return ctx.reply("❌ Số tháng không hợp lệ. Nhập số nguyên từ 1-120:")
    const months = parseInt(text)
    const start = new Date()
    const expiry = new Date(start.getTime()+months*30*86400000)
    await db.query(
     "UPDATE customers SET start_date=$1, expiry_date=$2 WHERE name=$3",
     [start,expiry,s.name]
    )
   }

   if(s.field === "Ngày bắt đầu"){
    if(!isValidDate(text))
     return ctx.reply("❌ Ngày không hợp lệ. Nhập đúng định dạng dd/mm/yyyy\nVí dụ: 15/06/2025")
    const d = parseDate(text)
    await db.query("UPDATE customers SET start_date=$1 WHERE name=$2",[d,s.name])
   }

   if(s.field === "Ngày hết hạn"){
    if(!isValidDate(text))
     return ctx.reply("❌ Ngày không hợp lệ. Nhập đúng định dạng dd/mm/yyyy\nVí dụ: 15/06/2025")
    const d = parseDate(text)
    await db.query("UPDATE customers SET expiry_date=$1 WHERE name=$2",[d,s.name])
   }

   delete state[ctx.from.id]
   ctx.reply("✅ Đã cập nhật")
   return mainMenu(ctx)
  }


  // ── ADD FLOW ───────────────────────────────────

  if(s.step === "add_service"){
   s.service = text
   s.step = "add_name"
   return ctx.reply("Tên khách:")
  }

  if(s.step === "add_name"){
   if(!isValidText(text))
    return ctx.reply("❌ Tên không được để trống. Nhập lại:")
   s.name = text
   s.step = "add_gmail"
   return ctx.reply("Gmail:")
  }

  if(s.step === "add_gmail"){
   if(!isValidText(text))
    return ctx.reply("❌ Gmail không được để trống. Nhập lại:")
   s.gmail = text
   s.step = "add_contact"
   return ctx.reply("Liên hệ:")
  }

  if(s.step === "add_contact"){
   if(!isValidText(text))
    return ctx.reply("❌ Liên hệ không được để trống. Nhập lại:")
   s.contact = text
   s.step = "add_start"
   return ctx.reply("Ngày bắt đầu (dd/mm/yyyy):\nVí dụ: 15/06/2025")
  }

  if(s.step === "add_start"){
   if(!isValidDate(text))
    return ctx.reply("❌ Ngày không hợp lệ!\nNhập đúng định dạng dd/mm/yyyy\nVí dụ: 15/06/2025")
   s.start = parseDate(text)
   s.step = "add_months"
   return ctx.reply("Số tháng (1-120):")
  }

  if(s.step === "add_months"){
   if(!isValidMonths(text))
    return ctx.reply("❌ Số tháng không hợp lệ!\nNhập số nguyên từ 1 đến 120:")

   const months = parseInt(text)
   const start = s.start
   const expiry = new Date(start.getTime()+months*30*86400000)

   await db.query(
    `INSERT INTO customers(service,name,gmail,contact,start_date,expiry_date)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [s.service,s.name,s.gmail,s.contact,start,expiry]
   )

   delete state[ctx.from.id]
   ctx.reply("✅ Đã thêm")
   return mainMenu(ctx)
  }


  // ── VIEW SERVICE ───────────────────────────────

  if(s.step === "view_service"){
   await showService(ctx,text)
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

async function showService(ctx,service){

 const res = await db.query(
  "SELECT * FROM customers WHERE service=$1 ORDER BY expiry_date",
  [service]
 )

 if(!res.rows.length)
  return ctx.reply("Không có khách")

 let msg = `📋 ${service}\n━━━━━━━━━━━━━━`

 const now = Date.now()

 res.rows.forEach(u=>{
  const diff = Math.ceil((new Date(u.expiry_date)-now)/86400000)
  let icon = "🟢"
  if(diff<=1) icon = "🔴"
  else if(diff<=3) icon = "🟠"

  msg += `\n\n${icon} ${u.name}
📧 ${u.gmail}
📞 ${u.contact}
📅 ${format(u.start_date)}
⏰ ${format(u.expiry_date)}
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

  if(diff===3){
   bot.telegram.sendMessage(
    ADMIN_ID,
`⚠️ Sắp hết hạn

${u.name}
${u.service}

${u.gmail}
${u.contact}

${format(u.expiry_date)}`
   )
  }

  if(diff<0)
   await db.query("DELETE FROM customers WHERE id=$1",[u.id])
 }

},{timezone:"Asia/Ho_Chi_Minh"})


// ================= DATE =================

function parseDate(text){
 const p = text.trim().split("/")
 return new Date(parseInt(p[2]), parseInt(p[1])-1, parseInt(p[0]))
}

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
