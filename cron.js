
const cron = require('node-cron')
const db = require('./db')

module.exports = (bot)=>{

cron.schedule('0 9 * * *', async ()=>{

 const res = await db.query(`
 SELECT * FROM customers
 WHERE expiry_date BETWEEN NOW() AND NOW() + INTERVAL '3 days'
 `)

 for(const u of res.rows){

  bot.telegram.sendMessage(process.env.ADMIN_ID,
`⚠️ Sắp hết hạn

${u.name}
${u.service}
${new Date(u.expiry_date).toLocaleDateString()}
`)

 }

})

}
