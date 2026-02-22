require('dotenv').config()

const { Telegraf, Markup } = require('telegraf')
const bot = new Telegraf(process.env.BOT_TOKEN)

const ADMIN_ID = Number(process.env.ADMIN_ID)

const addFlow = require('./add')
const cron = require('./cron')
const db = require('./db')

cron(bot)
addFlow(bot)

bot.use((ctx,next)=>{
 if(ctx.from.id !== ADMIN_ID){
  return ctx.reply("❌ Không có quyền")
 }
 next()
})

bot.start(async (ctx)=>{

 ctx.reply(
`👑 PREMIUM MANAGER

Chọn dịch vụ:`,
Markup.keyboard([
['📺 YouTube Premium','🤖 ChatGPT Plus'],
['🎬 CapCut Pro'],
['➕ Thêm khách','📊 Thống kê']
]).resize()
)

})

bot.hears('📺 YouTube Premium', ctx=>showService(ctx,'YouTube'))
bot.hears('🤖 ChatGPT Plus', ctx=>showService(ctx,'ChatGPT'))
bot.hears('🎬 CapCut Pro', ctx=>showService(ctx,'CapCut'))

bot.hears('📊 Thống kê', async ctx=>{

 const res = await db.query(`
 SELECT service, COUNT(*) total, SUM(price) revenue
 FROM customers
 GROUP BY service
 `)

 let msg="📊 THỐNG KÊ\n\n"

 res.rows.forEach(r=>{
  msg+=`${r.service}
👥 ${r.total}
💰 ${r.revenue || 0}

`
 })

 ctx.reply(msg)

})

bot.hears('➕ Thêm khách', ctx=>{
 ctx.scene?.enter?.('add') || ctx.reply("Gõ /add")
})

async function showService(ctx, service){

 const res = await db.query(`
 SELECT *
 FROM customers
 WHERE service=$1
 ORDER BY expiry_date ASC
 `,[service])

 if(res.rows.length===0)
  return ctx.reply("Không có khách")

 let msg=`📋 ${service}\n\n`

 const now = Date.now()

 res.rows.forEach(u=>{

  const expiry = new Date(u.expiry_date).getTime()
  const diff = Math.ceil((expiry-now)/86400000)

  let status="🟢"
  if(diff<=1) status="🔴"
  else if(diff<=3) status="🟠"
  else if(diff<=7) status="🟡"

  msg+=`
${status} ${u.name}

📧 Gmail: ${u.account_email}
📱 ${u.contact_channel}
📅 Start: ${formatVN(u.start_date)}
⏰ Exp: ${formatVN(u.expiry_date)}
🔗 ${u.contact_link || ""}

`
 })

 ctx.reply(msg)

}

function formatVN(date){

 return new Date(date).toLocaleString("vi-VN",{
  timeZone:"Asia/Ho_Chi_Minh"
 })

}

bot.launch()

console.log("Bot running")
