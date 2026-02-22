const cron=require('node-cron')
const db=require('./db')

module.exports=(bot)=>{

cron.schedule('0 9 * * *',async()=>{

 const now=new Date()

 const res=await db.query(`
 SELECT *
 FROM customers
 `)

 for(const u of res.rows){

  const diff=Math.ceil(
   (new Date(u.expiry_date)-now)/86400000
  )

  if([7,3,1].includes(diff)){

   bot.telegram.sendMessage(
    process.env.ADMIN_ID,

`⚠️ Sắp hết hạn

👤 ${u.name}
📧 ${u.account_email}
⏰ ${u.expiry_date}

`,{
 reply_markup:{
  inline_keyboard:[
   [
    {
     text:"Gia hạn",
     callback_data:`renew_${u.id}`
    }
   ],
   [
    {
     text:"Liên hệ",
     url:u.contact_link || "https://facebook.com"
    }
   ]
  ]
 }
 })

  }

  if(diff<0){

   await db.query(`
   DELETE FROM customers WHERE id=$1
   `,[u.id])

  }

 }

},{
 timezone:"Asia/Ho_Chi_Minh"
})

}
