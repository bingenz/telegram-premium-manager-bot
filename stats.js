
const db = require('./db')

module.exports = (bot)=>{

bot.command('stats', async ctx=>{

 const res = await db.query(`
 SELECT service, SUM(price) total
 FROM customers
 GROUP BY service
 `)

 let msg="📊 Doanh thu:\n\n"

 res.rows.forEach(r=>{
  msg+=`${r.service}: ${r.total}\n`
 })

 ctx.reply(msg)

})

}
