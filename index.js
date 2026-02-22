
require('dotenv').config()

const { Telegraf } = require('telegraf')
const bot = new Telegraf(process.env.BOT_TOKEN)

const ADMIN_ID = Number(process.env.ADMIN_ID)

const add = require('./add')
const list = require('./list')
const stats = require('./stats')

require('./cron')(bot)

bot.use((ctx,next)=>{
 if(ctx.from.id !== ADMIN_ID){
   return ctx.reply("❌ Không có quyền dùng bot")
 }
 next()
})

bot.start(ctx=>{
 ctx.reply(`
🤖 Premium Manager Bot

/add
/list
/stats
`)
})

add(bot)
list(bot)
stats(bot)

bot.launch()

console.log("Bot running...")
