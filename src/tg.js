const Table = require('cli-table3')
const dayjs = require('dayjs')
const axios = require('@viegg/axios')
const HttpsProxyAgent = require('https-proxy-agent')

const { db } = require('../db')
const { gen_count_body, validate_fid, real_copy, get_name_by_id } = require('./gd')
const { AUTH, DEFAULT_TARGET, USE_PERSONAL_AUTH } = require('../config')
const { tg_token } = AUTH
const gen_link = (fid, text) => `<a href="https://drive.google.com/drive/folders/${fid}">${text || fid}</a>`

if (!tg_token) throw new Error('請先在config.js裡設置tg_token')
const { https_proxy } = process.env
const axins = axios.create(https_proxy ? { httpsAgent: new HttpsProxyAgent(https_proxy) } : {})

const FID_TO_NAME = {}

async function get_folder_name (fid) {
  let name = FID_TO_NAME[fid]
  if (name) return name
  name = await get_name_by_id(fid)
  return FID_TO_NAME[fid] = name
}

function send_help (chat_id) {
  const text = `<pre>[使用幫助]
命令 ｜ 說明
=====================
/help | 返回本條使用說明
=====================
/count shareID [-u] | 返回sourceID的檔統計資訊
sourceID可以是google drive分享網址本身，也可以是分享ID。如果命令最後加上 -u，則無視之前的記錄強制從線上獲取，適合一段時候後才更新完畢的分享連結。
=====================
/copy sourceID targetID [-u] | 將sourceID的檔複製到targetID裡（會新建一個資料夾）
若不填targetID，則會複製到默認位置（在config.js裡設置）。
如果設置了bookmark，那麼targetID可以是bookmark的別名。
如果命令最後加上 -u，則無視本地緩存強制從線上獲取原始檔案夾資訊。
命令開始執行後會回復此次任務的taskID。
=====================
/task | 返回對應任務的進度資訊
用例：
/task | 返回所有正在運行的任務詳情
/task 7 | 返回編號為 7 的任務詳情
/task all | 返回所有任務記錄清單
/task clear | 清除所有狀態為已完成的任務記錄
/task rm 7 | 刪除編號為 7 的任務記錄
=====================
/bm [action] [alias] [target] | bookmark，添加常用目的資料夾ID
會在輸入網址後返回的「檔統計」「開始複製」這兩個按鈕的下方出現，方便複製到常用位置。
用例：
/bm | 返回所有設置的我的最愛
/bm set movie folder-id | 將folder-id添加到我的最愛，別名設為movie
/bm unset movie | 刪除此我的最愛
</pre>`
  return sm({ chat_id, text, parse_mode: 'HTML' })
}

function send_bm_help (chat_id) {
  const text = `<pre>/bm [action] [alias] [target] | bookmark，添加常用目的資料夾ID
會在輸入網址後返回的「檔統計」「開始複製」這兩個按鈕的下方出現，方便複製到常用位置。
用例：
/bm | 返回所有設置的我的最愛
/bm set movie folder-id | 將folder-id添加到我的最愛，別名設為movie
/bm unset movie | 刪除此我的最愛
</pre>`
  return sm({ chat_id, text, parse_mode: 'HTML' })
}

function send_task_help (chat_id) {
  const text = `<pre>/task [action/id] [id] | 查詢或管理任務進度
用例：
/task | 返回所有正在運行的任務詳情
/task 7 | 返回編號為 7 的任務詳情
/task all | 返回所有任務記錄清單
/task clear | 清除所有狀態為已完成的任務記錄
/task rm 7 | 刪除編號為 7 的任務記錄
</pre>`
  return sm({ chat_id, text, parse_mode: 'HTML' })
}

function clear_tasks (chat_id) {
  const finished_tasks = db.prepare('select id from task where status=?').all('finished')
  finished_tasks.forEach(task => rm_task({ task_id: task.id }))
  sm({ chat_id, text: '已清除所有狀態為已完成的任務記錄' })
}

function rm_task ({ task_id, chat_id }) {
  const exist = db.prepare('select id from task where id=?').get(task_id)
  if (!exist) return sm({ chat_id, text: `不存在編號為 ${task_id} 的任務記錄` })
  db.prepare('delete from task where id=?').run(task_id)
  db.prepare('delete from copied where taskid=?').run(task_id)
  if (chat_id) sm({ chat_id, text: `已刪除任務 ${task_id} 記錄` })
}

function send_all_bookmarks (chat_id) {
  let records = db.prepare('select alias, target from bookmark').all()
  if (!records.length) return sm({ chat_id, text: '資料庫中沒有收藏記錄' })
  const tb = new Table({ style: { head: [], border: [] } })
  const headers = ['別名', '目錄ID']
  records = records.map(v => [v.alias, v.target])
  tb.push(headers, ...records)
  const text = tb.toString().replace(/─/g, '—')
  return sm({ chat_id, text: `<pre>${text}</pre>`, parse_mode: 'HTML' })
}

function set_bookmark ({ chat_id, alias, target }) {
  const record = db.prepare('select alias from bookmark where alias=?').get(alias)
  if (record) return sm({ chat_id, text: '資料庫中已有同名的收藏' })
  db.prepare('INSERT INTO bookmark (alias, target) VALUES (?, ?)').run(alias, target)
  return sm({ chat_id, text: `成功設置收藏：${alias} | ${target}` })
}

function unset_bookmark ({ chat_id, alias }) {
  const record = db.prepare('select alias from bookmark where alias=?').get(alias)
  if (!record) return sm({ chat_id, text: '未找到此別名的收藏' })
  db.prepare('delete from bookmark where alias=?').run(alias)
  return sm({ chat_id, text: '成功刪除收藏 ' + alias })
}

function get_target_by_alias (alias) {
  const record = db.prepare('select target from bookmark where alias=?').get(alias)
  return record && record.target
}

function get_alias_by_target (target) {
  const record = db.prepare('select alias from bookmark where target=?').get(target)
  return record && record.alias
}

function send_choice ({ fid, chat_id }) {
  return sm({
    chat_id,
    text: `識別出分享ID ${fid}，請選擇動作`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '檔統計', callback_data: `count ${fid}` },
          { text: '開始複製', callback_data: `copy ${fid}` }
        ]
      ].concat(gen_bookmark_choices(fid))
    }
  })
}

// console.log(gen_bookmark_choices())
function gen_bookmark_choices (fid) {
  const gen_choice = v => ({ text: `複製到 ${v.alias}`, callback_data: `copy ${fid} ${v.alias}` })
  const records = db.prepare('select * from bookmark').all()
  const result = []
  for (let i = 0; i < records.length; i += 2) {
    const line = [gen_choice(records[i])]
    if (records[i + 1]) line.push(gen_choice(records[i + 1]))
    result.push(line)
  }
  return result
}

async function send_all_tasks (chat_id) {
  let records = db.prepare('select id, status, ctime from task').all()
  if (!records.length) return sm({ chat_id, text: '資料庫中沒有任務記錄' })
  const tb = new Table({ style: { head: [], border: [] } })
  const headers = ['ID', 'status', 'ctime']
  records = records.map(v => {
    const { id, status, ctime } = v
    return [id, status, dayjs(ctime).format('YYYY-MM-DD HH:mm:ss')]
  })
  tb.push(headers, ...records)
  const text = tb.toString().replace(/─/g, '—')
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  return axins.post(url, {
    chat_id,
    parse_mode: 'HTML',
    text: `所有拷貝任務：\n<pre>${text}</pre>`
  }).catch(err => {
    // const description = err.response && err.response.data && err.response.data.description
    // if (description && description.includes('message is too long')) {
    if (true) {
      const text = [headers].concat(records).map(v => v.join('\t')).join('\n')
      return sm({ chat_id, parse_mode: 'HTML', text: `所有拷貝任務：\n<pre>${text}</pre>` })
    }
    console.error(err)
  })
}

async function get_task_info (task_id) {
  const record = db.prepare('select * from task where id=?').get(task_id)
  if (!record) return {}
  const { source, target, status, mapping, ctime, ftime } = record
  const { copied_files } = db.prepare('select count(fileid) as copied_files from copied where taskid=?').get(task_id)
  const folder_mapping = mapping && mapping.trim().split('\n')
  const new_folder = folder_mapping && folder_mapping[0].split(' ')[1]
  const { summary } = db.prepare('select summary from gd where fid=?').get(source) || {}
  const { file_count, folder_count, total_size } = summary ? JSON.parse(summary) : {}
  const total_count = (file_count || 0) + (folder_count || 0)
  const copied_folders = folder_mapping ? (folder_mapping.length - 1) : 0
  let text = '任務編號：' + task_id + '\n'
  const folder_name = await get_folder_name(source)
  text += '原始檔案夾：' + gen_link(source, folder_name) + '\n'
  text += '目的位置：' + gen_link(target, get_alias_by_target(target)) + '\n'
  text += '新資料夾：' + (new_folder ? gen_link(new_folder) : '暫未創建') + '\n'
  text += '任務狀態：' + status + '\n'
  text += '創建時間：' + dayjs(ctime).format('YYYY-MM-DD HH:mm:ss') + '\n'
  text += '完成時間：' + (ftime ? dayjs(ftime).format('YYYY-MM-DD HH:mm:ss') : '未完成') + '\n'
  text += '目錄進度：' + copied_folders + '/' + (folder_count === undefined ? '未知數量' : folder_count) + '\n'
  text += '檔進度：' + copied_files + '/' + (file_count === undefined ? '未知數量' : file_count) + '\n'
  text += '總百分比：' + ((copied_files + copied_folders) * 100 / total_count).toFixed(2) + '%\n'
  text += '合計大小：' + (total_size || '未知大小')
  return { text, status, folder_count }
}

async function send_task_info ({ task_id, chat_id }) {
  const { text, status, folder_count } = await get_task_info(task_id)
  if (!text) return sm({ chat_id, text: '資料庫不存在此任務ID：' + task_id })
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  let message_id
  try {
    const { data } = await axins.post(url, { chat_id, text, parse_mode: 'HTML' })
    message_id = data && data.result && data.result.message_id
  } catch (e) {
    console.log('fail to send message to tg', e.message)
  }
  // get_task_info 在task目錄數超大時比較吃cpu，以後如果最好把mapping也另存一張表
  if (!message_id || status !== 'copying') return
  const loop = setInterval(async () => {
    const url = `https://api.telegram.org/bot${tg_token}/editMessageText`
    const { text, status } = await get_task_info(task_id)
    if (status !== 'copying') clearInterval(loop)
    axins.post(url, { chat_id, message_id, text, parse_mode: 'HTML' }).catch(e => console.error(e.message))
  }, 10 * 1000)
}

async function tg_copy ({ fid, target, chat_id, update }) { // return task_id
  target = target || DEFAULT_TARGET
  if (!target) {
    sm({ chat_id, text: '請輸入目的地ID或先在config.js裡設置默認複製目的地ID(DEFAULT_TARGET)' })
    return
  }

  let record = db.prepare('select id, status from task where source=? and target=?').get(fid, target)
  if (record) {
    if (record.status === 'copying') {
      sm({ chat_id, text: '已有相同源ID和目的ID的任務正在進行，查詢進度可輸入 /task ' + record.id })
      return
    } else if (record.status === 'finished') {
      sm({ chat_id, text: `檢測到已存在的任務 ${record.id}，開始繼續拷貝` })
    }
  }

  real_copy({ source: fid, update, target, service_account: !USE_PERSONAL_AUTH, is_server: true })
    .then(async info => {
      if (!record) record = {} // 防止無限迴圈
      if (!info) return
      const { task_id } = info
      const { text } = await get_task_info(task_id)
      sm({ chat_id, text, parse_mode: 'HTML' })
    })
    .catch(err => {
      const task_id = record && record.id
      if (task_id) db.prepare('update task set status=? where id=?').run('error', task_id)
      if (!record) record = {}
      console.error('複製失敗', fid, '-->', target)
      console.error(err)
      sm({ chat_id, text: '複製失敗，失敗消息：' + err.message })
    })

  while (!record) {
    record = db.prepare('select id from task where source=? and target=?').get(fid, target)
    await sleep(1000)
  }
  return record.id
}

function sleep (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })
}

function reply_cb_query ({ id, data }) {
  const url = `https://api.telegram.org/bot${tg_token}/answerCallbackQuery`
  return axins.post(url, {
    callback_query_id: id,
    text: '開始執行 ' + data
  })
}

async function send_count ({ fid, chat_id, update }) {
  sm({ chat_id, text: `開始獲取 ${fid} 所有檔資訊，請稍後，建議統計完成前先不要開始複製，因為複製也需要先獲取原始檔案夾資訊` })
  const table = await gen_count_body({ fid, update, type: 'tg', service_account: !USE_PERSONAL_AUTH })
  if (!table) return sm({ chat_id, parse_mode: 'HTML', text: gen_link(fid) + ' 資訊獲取失敗' })
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  const gd_link = `https://drive.google.com/drive/folders/${fid}`
  const name = await get_folder_name(fid)
  return axins.post(url, {
    chat_id,
    parse_mode: 'HTML',
    text: `<pre>原始檔案夾名稱：${name}
源連結：${gd_link}
${table}</pre>`
  }).catch(async err => {
    // const description = err.response && err.response.data && err.response.data.description
    // const too_long_msgs = ['request entity too large', 'message is too long']
    // if (description && too_long_msgs.some(v => description.toLowerCase().includes(v))) {
    if (true) {
      const smy = await gen_count_body({ fid, type: 'json', service_account: !USE_PERSONAL_AUTH })
      const { file_count, folder_count, total_size } = JSON.parse(smy)
      return sm({
        chat_id,
        parse_mode: 'HTML',
        text: `連結：<a href="https://drive.google.com/drive/folders/${fid}">${fid}</a>\n<pre>
表格太長超出telegram消息限制，只顯示概要：
目錄名稱：${name}
文件總數：${file_count}
目錄總數：${folder_count}
合計大小：${total_size}
</pre>`
      })
    }
    throw err
  })
}

function sm (data) {
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`
  return axins.post(url, data).catch(err => {
    // console.error('fail to post', url, data)
    console.error('fail to send message to tg:', err.message)
  })
}

function extract_fid (text) {
  text = text.replace(/^\/count/, '').replace(/^\/copy/, '').replace(/\\/g, '').trim()
  const [source, target] = text.split(' ').map(v => v.trim())
  if (validate_fid(source)) return source
  try {
    if (!text.startsWith('http')) text = 'https://' + text
    const u = new URL(text)
    if (u.pathname.includes('/folders/')) {
      const reg = /[^/?]+$/
      const match = u.pathname.match(reg)
      return match && match[0]
    }
    return u.searchParams.get('id')
  } catch (e) {
    return ''
  }
}

function extract_from_text (text) {
  const reg = /https?:\/\/drive.google.com\/[^\s]+/g
  const m = text.match(reg)
  return m && extract_fid(m[0])
}

module.exports = { send_count, send_help, sm, extract_fid, reply_cb_query, send_choice, send_task_info, send_all_tasks, tg_copy, extract_from_text, get_target_by_alias, send_bm_help, send_all_bookmarks, set_bookmark, unset_bookmark, clear_tasks, send_task_help, rm_task }
