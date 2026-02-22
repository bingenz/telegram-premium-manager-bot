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

// ================= MENU =================

function mainMenu(ctx){
 return ctx.reply(
  "👑 PREMIUM MANAGER",
  Markup.keyboard([
   ['➕ Thêm khách'],
   ['🗑 Xóa khách'],
   ['📊 Thống kê'],
   ['📥 Export Excel']
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

// ================= ADD =================

bot.hears('➕ Thêm khách', ctx=>{
 state[ctx.from.id] = { step: "add_service" }
 ctx.reply("Chọn dịch vụ:", serviceKeyboard)
})

// ================= DELETE =================

bot.hears('🗑 Xóa khách', ctx=>{
 state[ctx.from.id] = { step: "delete" }
 ctx.reply("Nhập tên khách cần xóa:")
})

// ================= STATS =================

bot.hears('📊 Thống kê', ctx=>{
 state[ctx.from.id] = { step: "view_service" }
 ctx.reply("Chọn dịch vụ:", serviceKeyboard)
})

// ================= EXPORT =================

bot.hears('📥 Export Excel', async ctx=>{

 const res = await db.query(
  "SELECT * FROM customers ORDER BY service, expiry_date"
 )

 if(!res.rows.length)
  return ctx.reply("Không có dữ liệu")

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

})

// ================= TEXT HANDLER =================

bot.on('text', async ctx=>{

 const text = ctx.message.text

 const s = state[ctx.from.id]

 if(text === '⬅️ Hủy'){
  delete state[ctx.from.id]
  return mainMenu(ctx)
 }

 if(!s) return

 // DELETE
 if(s.step === "delete"){

  await db.query(
   "DELETE FROM customers WHERE name=$1",
   [text]
  )

  delete state[ctx.from.id]

  ctx.reply("🗑 Đã xóa khách")

  return mainMenu(ctx)
 }

 // VIEW
 if(s.step === "view_service"){

  await showService(ctx, text)

  delete state[ctx.from.id]

  return mainMenu(ctx)
 }

 // ADD FLOW

 if(s.step === "add_service"){

  s.service = text
  s.step = "add_name"

  return ctx.reply("Tên khách:")
 }

 if(s.step === "add_name"){

  s.name = text
  s.step = "add_gmail"

  return ctx.reply("Gmail khách:")
 }

 if(s.step === "add_gmail"){

  s.gmail = text
  s.step = "add_contact"

  return ctx.reply("Link FB hoặc Zalo:")
 }

 if(s.step === "add_contact"){

  s.contact = text
  s.step = "add_months"

  return ctx.reply("Số tháng:")
 }

 if(s.step === "add_months"){

  const months = parseInt(text)

  const start = new Date()

  const expiry =
  new Date(start.getTime() + months*30*86400000)

  await db.query(
   `INSERT INTO customers
   (service,name,gmail,contact,start_date,expiry_date)
   VALUES($1,$2,$3,$4,$5,$6)`,
   [s.service,s.name,s.gmail,s.contact,start,expiry]
  )

  delete state[ctx.from.id]

  ctx.reply("✅ Đã thêm khách")

  return mainMenu(ctx)
 }

})

// ================= SHOW SERVICE =================

async function showService(ctx, service){

 const res =
 await db.query(
  "SELECT * FROM customers WHERE service=$1 ORDER BY expiry_date",
  [service]
 )

 if(!res.rows.length)
  return ctx.reply("Không có khách")

 let msg =
 `📋 DANH SÁCH ${service}
━━━━━━━━━━━━━━`

 const now = Date.now()

 res.rows.forEach(u=>{

  const diff =
  Math.ceil((new Date(u.expiry_date)-now)/86400000)

  let icon="🟢"

  if(diff<=1) icon="🔴"
  else if(diff<=3) icon="🟠"

  msg += `

${icon} ${u.name}
📧 ${u.gmail}
📞 ${u.contact}
⏰ ${format(u.expiry_date)}
━━━━━━━━━━━━━━`
 })

 ctx.reply(msg)
}

// ================= CRON =================

cron.schedule('0 9 * * *', async ()=>{

 const res = await db.query("SELECT * FROM customers")

 const now = new Date()

 for(const u of res.rows){

  const diff =
  Math.ceil((new Date(u.expiry_date)-now)/86400000)

  if(diff === 3){

   bot.telegram.sendMessage(
    ADMIN_ID,

`⚠️ Sắp hết hạn

👤 ${u.name}
📦 ${u.service}

📧 ${u.gmail}
📞 ${u.contact}

⏰ ${format(u.expiry_date)}`
   )
  }

  if(diff < 0){

   await db.query(
    "DELETE FROM customers WHERE id=$1",
    [u.id]
   )
  }
 }

},{
 timezone:"Asia/Ho_Chi_Minh"
})

// ================= FORMAT =================

function format(d){

 return new Date(d)
 .toLocaleDateString(
  "vi-VN",
  {timeZone:"Asia/Ho_Chi_Minh"}
 )
}

// ================= HTTP SERVER =================

const PORT = process.env.PORT || 3000

http.createServer((req,res)=>{

 res.writeHead(200,{'Content-Type':'text/plain'})
 res.end("Bot is running")

}).listen(PORT,()=>{
 console.log("HTTP server running")
})

// ================= START =================

bot.launch({
 dropPendingUpdates:true
})

setInterval(()=>{},1000)

console.log("Bot running OK")
