process.env.NTBA_FIX_350 = 1

require('dotenv').config()

const { Telegraf, Markup } = require('telegraf')
const { Pool } = require('pg')
const cron = require('node-cron')
const ExcelJS = require('exceljs')
const fs = require('fs')
const http = require('http')

const bot = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_ID = Number(process.env.ADMIN_ID)

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})


// ================= INIT DB =================

async function initDB(){
  await db.query(`
    CREATE TABLE IF NOT EXISTS customers(
      id SERIAL PRIMARY KEY,
      service TEXT,
      name TEXT,
      gmail TEXT,
      start_date TIMESTAMP,
      expiry_date TIMESTAMP
    )
  `)
  await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS contact`)
}

initDB()


// ================= HELPERS =================

function format(d){
  return new Date(d).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
}

function daysFromNow(d){
  return Math.ceil((new Date(d) - Date.now()) / 86400000)
}

function parseShortDate(text){
  const t = text.trim().replace(/\D/g, '')
  let d, m, y
  if(t.length === 6){
    d = parseInt(t.slice(0,2)); m = parseInt(t.slice(2,4)); y = 2000 + parseInt(t.slice(4,6))
  } else if(t.length === 8){
    d = parseInt(t.slice(0,2)); m = parseInt(t.slice(2,4)); y = parseInt(t.slice(4,8))
  } else return null
  if(m<1||m>12||d<1||d>31||y<2000||y>2100) return null
  const date = new Date(y, m-1, d)
  if(date.getFullYear()!==y || date.getMonth()!==m-1 || date.getDate()!==d) return null
  return date
}

function isValidMonths(text){
  const n = parseInt(text.trim())
  return !isNaN(n) && n > 0 && n <= 120 && String(n) === text.trim()
}

function isValidText(text){
  return text && text.trim().length > 0
}


// ================= CONSTANTS =================

const SERVICE_LIST = ['ChatGPT Plus', 'ChatGPT GO', 'YouTube', 'CapCut']

const serviceKeyboard = Markup.keyboard([
  ['ChatGPT Plus', 'ChatGPT GO'],
  ['YouTube', 'CapCut'],
  ['\u2b05\ufe0f H\u1ee7y']
]).resize()

const editKeyboard = Markup.keyboard([
  ['T\u00ean', 'Gmail'],
  ['S\u1ed1 th\u00e1ng', 'Ng\u00e0y b\u1eaft \u0111\u1ea7u', 'Ng\u00e0y h\u1ebft h\u1ea1n'],
  ['\u2b05\ufe0f H\u1ee7y']
]).resize()


// ================= MENU =================

function mainMenu(ctx){
  return ctx.reply(
    '\ud83d\udc51 PREMIUM MANAGER',
    Markup.keyboard([
      ['\u2795 Th\u00eam kh\u00e1ch'],
      ['\ud83d\uddd1 X\u00f3a kh\u00e1ch', '\u270f\ufe0f S\u1eeda kh\u00e1ch'],
      ['\ud83d\udcca Th\u1ed1ng k\u00ea', '\ud83d\udccb Kh\u00e1ch h\u1ebft h\u1ea1n'],
      ['\ud83d\udce5 Export Excel', '\ud83d\udd34 Reset DB']
    ]).resize()
  )
}

bot.use((ctx, next) => {
  if(ctx.from.id !== ADMIN_ID) return
  next()
})

bot.start(ctx => mainMenu(ctx))


// ================= STATE =================

let state = {}


// ================= ADD =================

bot.hears('\u2795 Th\u00eam kh\u00e1ch', ctx => {
  state[ctx.from.id] = { step: 'add_service' }
  ctx.reply('Ch\u1ecdn d\u1ecbch v\u1ee5:', serviceKeyboard)
})


// ================= DELETE (inline, kh\u00f4ng c\u1ea7n state) =================

bot.hears('\ud83d\uddd1 X\u00f3a kh\u00e1ch', async ctx => {
  try{
    const res = await db.query('SELECT id, name, service FROM customers ORDER BY service, name')
    if(!res.rows.length) return ctx.reply('Kh\u00f4ng c\u00f3
