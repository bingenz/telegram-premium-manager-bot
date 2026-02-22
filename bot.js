process.env.NTBA_FIX_350 = 1

require('dotenv').config()

const { Telegraf, Markup } = require('telegraf')
const { Pool } = require('pg')
const cron = require('node-cron')

const bot = new Telegraf(process.env.BOT_TOKEN)

const ADMIN_ID = Number(process.env.ADMIN_ID)

// PostgreSQL
const db = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl: { rejectUnauthorized: false }
})

// ======================
// DATABASE INIT
// ======================

async function initDB(){

 await db.query(`
 CREATE TABLE IF NOT EXISTS customers(
  id SERIAL PRIMARY KEY,
  service TEXT,
  name TEXT,
  contact TEXT,
  start_date TIMESTAMP,
  expiry_date TIMESTAMP
 )
 `)

}

initDB()

// ======================
// MENU
// ======================

bot.use((ctx,next)=>{
 if(ctx.from.id !== ADMIN_ID) return
 next()
})

bot.start((ctx)=>{

 ctx.reply(
"👑 PREMIUM MANAGER",
Markup.keyboard([
['📋 Kiểm tra khách'],
['➕ Thêm khách','🗑 Xóa khách']
]).resize()
)

})

// ======================
// STATE
// ======================

let state = {}

// ======================
// ADD CUSTOMER
// ======================

bot.hears('➕ Thêm khách', ctx=>{

 state[ctx.from.id] = {
  step: 1,
  data: {}
 }

 ctx.reply("Loại dịch vụ (ChatGPT / YouTube / CapCut)?")

})

// ======================
// DELETE CUSTOMER
// ======================

bot.hears('🗑 Xóa khách', ctx=>{

 state[ctx.from.id] = {
  step: "delete"
 }

 ctx.reply("Nhập tên khách cần xóa")

})

// ======================
// LIST CUSTOMER
// ======================

bot.hears('📋 Kiểm tra khách', async ctx=>{

 const res = await db.query(
  "SELECT * FROM customers ORDER BY expiry_date"
 )

 if(res.rows.length === 0){

  ctx.reply("Không có khách")

  return
 }

 let msg = "📋 DANH SÁCH KHÁCH\n"

 const now = Date.now()

 for(const u of res.rows){

  const diff =
   Math.ceil(
    (new Date(u.expiry_date) - now)
    / 86400000
   )

  let status = "🟢"

  if(diff <= 1) status = "🔴"
  else if(diff <= 3) status = "🟠"

  msg += `

${status} ${u.name}

📦 ${u.service}

📅 Start:
${formatDate(u.start_date)}

⏰ Exp:
${formatDate(u.expiry_date)}

📞 ${u.contact}

`

 }

 ctx.reply(msg)

})

// ======================
// TEXT HANDLER
// ======================

bot.on('text', async ctx=>{

 const s = state[ctx.from.id]

 if(!s) return

 // STEP 1
 if(s.step === 1){

  s.data.service = ctx.message.text

  s.step = 2

  ctx.reply("Tên khách?")

  return

 }

 // STEP 2
 if(s.step === 2){

  s.data.name = ctx.message.text

  s.step = 3

  ctx.reply("Link Facebook hoặc tên Zalo?")

  return

 }

 // STEP 3
 if(s.step === 3){

  s.data.contact = ctx.message.text

  s.step = 4

  ctx.reply("Số tháng đăng ký?")

  return

 }

 // STEP 4 SAVE
 if(s.step === 4){

  const months = parseInt(ctx.message.text)

  const start = new Date()

  const expiry =
   new Date(
    start.getTime()
    + months * 30 * 86400000
   )

  await db.query(`
   INSERT INTO customers
   (service,name,contact,start_date,expiry_date)
   VALUES($1,$2,$3,$4,$5)
  `,
  [
   s.data.service,
   s.data.name,
   s.data.contact,
   start,
   expiry
  ])

  delete state[ctx.from.id]

  ctx.reply("✅ Đã thêm khách")

  return

 }

 // DELETE
 if(s.step === "delete"){

  await db.query(
   "DELETE FROM customers WHERE name=$1",
   [ctx.message.text]
  )

  delete state[ctx.from.id]

  ctx.reply("🗑 Đã xóa khách")

 }

})

// ======================
// CRON JOB
// ======================

cron.schedule(
'0 9 * * *',
async ()=>{

 const res =
  await db.query(
   "SELECT * FROM customers"
  )

 const now = new Date()

 for(const u of res.rows){

  const diff =
   Math.ceil(
    (new Date(u.expiry_date)-now)
    / 86400000
   )

  // REMIND
  if(diff === 3){

   bot.telegram.sendMessage(
    ADMIN_ID,

`⚠️ Sắp hết hạn 3 ngày

👤 ${u.name}

📦 ${u.service}

⏰ ${formatDate(u.expiry_date)}

📞 Liên hệ:
${u.contact}
`
   )

  }

  // AUTO DELETE
  if(diff < 0){

   await db.query(
    "DELETE FROM customers WHERE id=$1",
    [u.id]
   )

  }

 }

},
{
 timezone: "Asia/Ho_Chi_Minh"
}
)

// ======================
// HELPER
// ======================

function formatDate(date){

 return new Date(date)
 .toLocaleDateString(
  "vi-VN",
  {
   timeZone:
   "Asia/Ho_Chi_Minh"
  }
 )

}

// ======================
// START BOT
// ======================

bot.launch({
 dropPendingUpdates: true
})

setInterval(()=>{},1000)

console.log("Bot running OK")
