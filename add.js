const db=require('./db')

let state={}

module.exports=(bot)=>{

bot.hears('➕ Thêm khách', ctx=>{

 state[ctx.from.id]={step:1,data:{}}
 ctx.reply("Tên khách?")

})

bot.on('text', async ctx=>{

 const s=state[ctx.from.id]
 if(!s) return

 if(s.step==1){

  s.data.name=ctx.message.text
  s.step++
  return ctx.reply("FB/Zalo/Phone?")
 }

 if(s.step==2){

  s.data.contact_channel=ctx.message.text
  s.step++
  return ctx.reply("Link FB?")
 }

 if(s.step==3){

  s.data.contact_link=ctx.message.text
  s.step++
  return ctx.reply("Service: YouTube / ChatGPT / CapCut")
 }

 if(s.step==4){

  s.data.service=ctx.message.text
  s.step++
  return ctx.reply("Gmail cấp cho khách?")
 }

 if(s.step==5){

  s.data.gmail_owner=ctx.message.text
  s.step++
  return ctx.reply("Số tháng?")
 }

 if(s.step==6){

  const months=parseInt(ctx.message.text)

  const start=new Date()

  const expiry=new Date(
   start.getTime() + months*30*86400000
  )

  await db.query(`
  INSERT INTO customers
  (name,contact_channel,contact_link,
   service,gmail_owner,start_date,expiry_date)
  VALUES($1,$2,$3,$4,$5,$6,$7)
  `,[
   s.data.name,
   s.data.contact_channel,
   s.data.contact_link,
   s.data.service,
   s.data.gmail_owner,
   start,
   expiry
  ])

  delete state[ctx.from.id]

  ctx.reply("✅ Đã thêm")

 }

})

}
