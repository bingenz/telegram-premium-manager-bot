process.env.NTBA_FIX_350 = 1

require('dotenv').config()

const { Telegraf, Markup } = require('telegraf')
const { Pool } = require('pg')
const cron = require('node-cron')
const ExcelJS = require('exceljs')
const fs = require('fs')

const bot = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_ID = Number(process.env.ADMIN_ID)

const db = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl: { rejectUnauthorized: false }
})

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

bot.use((ctx,next)=>{
 if(ctx.from.id !== ADMIN_ID) return
 next()
})

bot.start(ctx=>{
 ctx.reply(
 "👑 PREMIUM MANAGER",
 Markup.keyboard([
 ['📋 ChatGPT','📋 YouTube','📋 CapCut'],
 ['➕ Thêm khách','🗑 Xóa khách'],
 ['📊 Thống kê','📥 Export Excel']
 ]).resize()
 )
})

let state = {}

bot.hears('➕ Thêm khách', ctx=>{
 state[ctx.from.id] = { step: "service" }
 ctx.reply(
 "Chọn dịch vụ:",
 Markup.keyboard([
 ['ChatGPT','YouTube','CapCut']
 ]).resize()
 )
})

bot.hears(['ChatGPT','YouTube','CapCut'], ctx=>{
 const s = state[ctx.from.id]
 if(!s || s.step !== "service") return
 s.service = ctx.message.text
 s.step = "name"
 ctx.reply("Tên khách?")
})

bot.on('text', async ctx=>{
 const s = state[ctx.from.id]
 if(!s) return

 if(s.step === "name"){
  s.name = ctx.message.text
  s.step = "gmail"
  return ctx.reply("Gmail khách dùng?")
 }

 if(s.step === "gmail"){
  s.gmail = ctx.message.text
  s.step = "contact"
  return ctx.reply("Link Facebook hoặc tên Zalo?")
 }

 if(s.step === "contact"){
  s.contact = ctx.message.text
  s.step = "months"
  return ctx.reply("Số tháng đăng ký?")
 }

 if(s.step === "months"){
  const months = parseInt(ctx.message.text)
  const start = new Date()
  const expiry = new Date(start.getTime() + months*30*86400000)

  await db.query(
   "INSERT INTO customers(service,name,gmail,contact,start_date,expiry_date) VALUES($1,$2,$3,$4,$5,$6)",
   [s.service,s.name,s.gmail,s.contact,start,expiry]
  )

  delete state[ctx.from.id]
  ctx.reply("✅ Đã thêm khách")
 }
})

bot.hears('🗑 Xóa khách', ctx=>{
 state[ctx.from.id] = { step: "delete" }
 ctx.reply("Nhập tên khách cần xóa")
})

bot.on('text', async ctx=>{
 const s = state[ctx.from.id]
 if(!s || s.step !== "delete") return

 await db.query("DELETE FROM customers WHERE name=$1",[ctx.message.text])
 delete state[ctx.from.id]
 ctx.reply("🗑 Đã xóa khách")
})

async function show(service, ctx){
 const res = await db.query(
  "SELECT * FROM customers WHERE service=$1 ORDER BY expiry_date",
  [service]
 )

 if(!res.rows.length)
  return ctx.reply(`Không có khách ${service}`)

 let msg = `📋 DANH SÁCH ${service}\n━━━━━━━━━━━━━━`

 const now = Date.now()

 for(const u of res.rows){
  const diff = Math.ceil((new Date(u.expiry_date)-now)/86400000)

  let icon="🟢"
  if(diff<=1) icon="🔴"
  else if(diff<=3) icon="🟠"

  msg += `

${icon} ${u.name}
📧 ${u.gmail}
📞 ${u.contact}
📅 ${format(u.start_date)}
⏰ ${format(u.expiry_date)}
━━━━━━━━━━━━━━`
 }

 ctx.reply(msg)
}

bot.hears('📋 ChatGPT', ctx=>show('ChatGPT',ctx))
bot.hears('📋 YouTube', ctx=>show('YouTube',ctx))
bot.hears('📋 CapCut', ctx=>show('CapCut',ctx))

bot.hears('📊 Thống kê', async ctx=>{
 const service = await db.query(
  "SELECT service, COUNT(*) total FROM customers GROUP BY service"
 )

 const gmail = await db.query(
  "SELECT gmail, COUNT(*) total FROM customers GROUP BY gmail"
 )

 let msg="📊 THỐNG KÊ\n"

 service.rows.forEach(r=>{
  msg+=`${r.service}: ${r.total}\n`
 })

 msg+="\nTheo Gmail:\n"

 gmail.rows.forEach(r=>{
  msg+=`${r.gmail}: ${r.total}\n`
 })

 ctx.reply(msg)
})

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

cron.schedule('0 9 * * *', async ()=>{

 const res = await db.query("SELECT * FROM customers")
 const now = new Date()

 for(const u of res.rows){
  const diff=Math.ceil((new Date(u.expiry_date)-now)/86400000)

  if(diff===3){
   bot.telegram.sendMessage(
    ADMIN_ID,
`⚠️ Sắp hết hạn

👤 ${u.name}
📦 ${u.service}

📧 ${u.gmail}
📞 ${u.contact}

⏰ ${format(u.expiry_date)}`)
  }

  if(diff<0){
   await db.query("DELETE FROM customers WHERE id=$1",[u.id])
  }
 }

},{timezone:"Asia/Ho_Chi_Minh"})

function format(d){
 return new Date(d).toLocaleDateString("vi-VN",{timeZone:"Asia/Ho_Chi_Minh"})
}

bot.launch({dropPendingUpdates:true})
setInterval(()=>{},1000)
console.log("Bot running OK")
