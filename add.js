
const db = require('./db')

let state = {}

module.exports = (bot)=>{

bot.command('add', ctx=>{
 state[ctx.from.id] = { step:1, data:{} }
 ctx.reply("Tên khách?")
})

bot.on('text', async ctx=>{

 if(!state[ctx.from.id]) return

 const s = state[ctx.from.id]

 if(s.step==1){
  s.data.name = ctx.message.text
  s.step=2
  return ctx.reply("Kênh liên hệ (fb/zalo/phone)?")
 }

 if(s.step==2){
  s.data.channel = ctx.message.text
  s.step=3
  return ctx.reply("Tên liên hệ?")
 }

 if(s.step==3){
  s.data.contact_name = ctx.message.text
  s.step=4
  return ctx.reply("Link liên hệ?")
 }

 if(s.step==4){
  s.data.contact_link = ctx.message.text
  s.step=5
  return ctx.reply("Dịch vụ (YouTube/ChatGPT/CapCut)?")
 }

 if(s.step==5){
  s.data.service = ctx.message.text
  s.step=6
  return ctx.reply("Gmail cấp cho khách?")
 }

 if(s.step==6){
  s.data.email = ctx.message.text
  s.step=7
  return ctx.reply("Thiết bị?")
 }

 if(s.step==7){
  s.data.device = ctx.message.text
  s.step=8
  return ctx.reply("Vị trí?")
 }

 if(s.step==8){
  s.data.location = ctx.message.text
  s.step=9
  return ctx.reply("Số tháng?")
 }

 if(s.step==9){
  s.data.months = Number(ctx.message.text)
  s.step=10
  return ctx.reply("Giá?")
 }

 if(s.step==10){

  const expiry = new Date()
  expiry.setMonth(expiry.getMonth()+s.data.months)

  await db.query(`
  INSERT INTO customers
  (name,contact_channel,contact_name,contact_link,service,
   account_email,device,location,months,start_date,expiry_date,price)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11)
  `,[
   s.data.name,
   s.data.channel,
   s.data.contact_name,
   s.data.contact_link,
   s.data.service,
   s.data.email,
   s.data.device,
   s.data.location,
   s.data.months,
   expiry,
   ctx.message.text
  ])

  delete state[ctx.from.id]

  ctx.reply("✅ Đã thêm khách")
 }

})

}
