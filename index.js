require('dotenv').config()

const { Telegraf, Markup } = require('telegraf')
const bot = new Telegraf(process.env.BOT_TOKEN)

const ADMIN_ID = Number(process.env.ADMIN_ID)

const db = require('./db')

require('./cron')(bot)
require('./add')(bot)

bot.use((ctx,next)=>{
 if(ctx.from.id !== ADMIN_ID) return
 next()
})

bot.start((ctx)=>{

 ctx.reply(
`👑 PREMIUM MANAGER`,
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

async function showService(ctx, service){

 const res = await db.query(`
 SELECT *
 FROM customers
 WHERE service=$1
 ORDER BY gmail_owner, expiry_date
 `,[service])

 if(!res.rows.length)
  return ctx.reply("Không có khách")

 let msg=`📋 ${service}\n`

 let current=null
 const now=Date.now()

 res.rows.forEach(u=>{

  if(current!==u.gmail_owner){
   current=u.gmail_owner
   msg+=`\n📧 ${current}\n`
  }

  const diff=Math.ceil(
   (new Date(u.expiry_date)-now)/86400000
  )

  let status="🟢"
  if(diff<=1) status="🔴"
  else if(diff<=3) status="🟠"
  else if(diff<=7) status="🟡"

  msg+=`
${status} ${u.name}
📱 ${u.contact_channel}
⏰ ${formatVN(u.expiry_date)}
`
 })

 ctx.reply(msg)

}

function formatVN(date){

 return new Date(date).toLocaleString("vi-VN",{
  timeZone:"Asia/Ho_Chi_Minh"
 })

}

bot.launch({
 dropPendingUpdates:true
})

bot.catch(console.error)

process.once('SIGINT',()=>bot.stop())
process.once('SIGTERM',()=>bot.stop())

console.log("Bot running okok")
