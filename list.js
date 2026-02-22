
const db = require('./db')

module.exports = (bot)=>{

bot.command('list', async ctx=>{

 const res = await db.query(`
 SELECT * FROM customers
 ORDER BY expiry_date ASC
 LIMIT 20
 `)

 let msg="📋 Danh sách:\n\n"

 res.rows.forEach(u=>{
  msg+=`
${u.name}
${u.service}
Hết hạn: ${new Date(u.expiry_date).toLocaleDateString()}
`
 })

 ctx.reply(msg)

})

}
