const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'cloudvault_secret_2024';
const ADMIN_KEY = process.env.ADMIN_KEY || 'minaz_admin_2024';
const ADMIN_TG_ID = process.env.ADMIN_TG_ID || '7670348638';
const NAGAD_NUMBER = process.env.BKASH_NUMBER || '01935926051';

const BOTS = [
  { token: process.env.BOT1_TOKEN, channel: process.env.CH1_ID },
  { token: process.env.BOT2_TOKEN, channel: process.env.CH2_ID },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const upload = multer({ dest: '/tmp/', limits: { fileSize: 15 * 1024 * 1024 } });

const auth = (req, res, next) => {
  const t = req.headers.authorization?.replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

function genPassword(len = 14) {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// Create ZIP with password from a buffer (not file)
function makeZipFromBuffer(buf, innerName, password) {
  const tmpDir = `/tmp/ziptmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, innerName);
  const zipPath = path.join(tmpDir, 'out.zip');
  try {
    fs.writeFileSync(inputPath, buf);
    const r = spawnSync('zip', ['-P', password, 'out.zip', innerName], { cwd: tmpDir, timeout: 60000 });
    if (r.status !== 0) throw new Error('zip failed: ' + r.stderr?.toString());
    if (!fs.existsSync(zipPath)) throw new Error('zip not created');
    return fs.readFileSync(zipPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function uploadBufToTelegram(botToken, channelId, zipBuf, zipName) {
  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('document', zipBuf, { filename: zipName, knownLength: zipBuf.length });
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendDocument`, form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000 }
  );
  if (res.data.ok) return { fileId: res.data.result.document.file_id, msgId: res.data.result.message_id };
  throw new Error('Telegram upload failed: ' + (res.data.description || ''));
}

async function getTgFileUrl(botToken, tgFileId) {
  const res = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${tgFileId}`, { timeout: 15000 });
  if (res.data.ok) return `https://api.telegram.org/file/bot${botToken}/${res.data.result.file_path}`;
  return null;
}

// ===== AUTH =====
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
    const { data: ex } = await supabase.from('users').select('id').eq('email', email).single();
    if (ex) return res.status(400).json({ error: 'Email already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    let freeBytes = 100 * 1024 * 1024 * 1024;
    try {
      const { data: cfg } = await supabase.from('site_config').select('free_storage_gb').eq('id', 1).single();
      if (cfg?.free_storage_gb) freeBytes = cfg.free_storage_gb * 1024 * 1024 * 1024;
    } catch {}
    const { error } = await supabase.from('users').insert({
      id: userId, email, password: hashed, name, plan: 'free',
      storage_used: 0, storage_limit: freeBytes, created_at: new Date().toISOString()
    });
    if (error) throw error;
    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, email, name, plan: 'free' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, plan_expires_at: user.plan_expires_at } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('id,email,name,plan,plan_expires_at,storage_used,storage_limit,created_at').eq('id', req.user.userId).single();
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claim-bonus', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: cfg } = await supabase.from('site_config').select('login_bonus_enabled,login_bonus_gb,login_bonus_start,login_bonus_end').eq('id', 1).single();
    if (!cfg?.login_bonus_enabled) return res.status(400).json({ error: 'Bonus not active' });
    if (cfg.login_bonus_start && today < cfg.login_bonus_start) return res.status(400).json({ error: 'Bonus not started yet' });
    if (cfg.login_bonus_end && today > cfg.login_bonus_end) return res.status(400).json({ error: 'Bonus period ended' });
    const { data: existing } = await supabase.from('login_bonus_claims').select('id').eq('user_id', req.user.userId).eq('claim_date', today).single();
    if (existing) return res.status(400).json({ error: 'Already claimed today!' });
    const bonusGb = cfg.login_bonus_gb || 2;
    const bonusBytes = bonusGb * 1024 * 1024 * 1024;
    await supabase.from('login_bonus_claims').insert({ user_id: req.user.userId, claim_date: today, bonus_gb: bonusGb });
    const { data: u } = await supabase.from('users').select('storage_limit').eq('id', req.user.userId).single();
    await supabase.from('users').update({ storage_limit: (u?.storage_limit || 0) + bonusBytes }).eq('id', req.user.userId);
    res.json({ success: true, bonusGb, message: `🎉 +${bonusGb}GB bonus added!` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bonus-status', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: cfg } = await supabase.from('site_config').select('login_bonus_enabled,login_bonus_gb,login_bonus_start,login_bonus_end').eq('id', 1).single();
    if (!cfg?.login_bonus_enabled) return res.json({ active: false });
    if (cfg.login_bonus_start && today < cfg.login_bonus_start) return res.json({ active: false });
    if (cfg.login_bonus_end && today > cfg.login_bonus_end) return res.json({ active: false });
    const { data: claimed } = await supabase.from('login_bonus_claims').select('id').eq('user_id', req.user.userId).eq('claim_date', today).single();
    res.json({ active: true, bonusGb: cfg.login_bonus_gb || 2, claimed: !!claimed, endDate: cfg.login_bonus_end });
  } catch { res.json({ active: false }); }
});

// ===== UPLOAD =====
// SIMPLE & RELIABLE:
// Each 10MB chunk → ZIP with password → upload to Telegram → done
// No assembly file, no /tmp persistence needed
// Works perfectly on Render free tier
app.post('/api/chunk/upload', auth, upload.single('chunk'), async (req, res) => {
  let chunkPath = req.file?.path;
  try {
    const { fileId, chunkIndex, totalChunks, fileName, folderId, fileSize, folderPassword } = req.body;
    if (!fileId || !req.file) return res.status(400).json({ error: 'Missing data' });

    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);
    const isLast = (idx === total - 1);
    const zipPw = folderPassword || 'cv_secure';

    // Read chunk into memory (max 10MB)
    const chunkBuf = fs.readFileSync(chunkPath);
    fs.unlinkSync(chunkPath); chunkPath = null;

    // Name inside ZIP: original filename (all chunks have same inner name)
    const innerName = fileName;
    const zipName = `${fileId.slice(-8)}_${String(idx + 1).padStart(4,'0')}of${String(total).padStart(4,'0')}.zip`;

    console.log(`[${fileId}] Chunk ${idx+1}/${total} (${(chunkBuf.length/1024/1024).toFixed(1)}MB) → ${zipName}`);

    // Create ZIP from chunk buffer
    const zipBuf = makeZipFromBuffer(chunkBuf, innerName, zipPw);

    // Upload ZIP to both Telegram bots
    const [tg1, tg2] = await Promise.allSettled([
      uploadBufToTelegram(BOTS[0].token, BOTS[0].channel, zipBuf, zipName),
      uploadBufToTelegram(BOTS[1].token, BOTS[1].channel, zipBuf, zipName),
    ]);

    const tgResults = [
      tg1.status === 'fulfilled' ? { botIndex: 0, ...tg1.value } : null,
      tg2.status === 'fulfilled' ? { botIndex: 1, ...tg2.value } : null,
    ].filter(Boolean);

    if (!tgResults.length) throw new Error('Telegram upload failed');

    console.log(`[${fileId}] Chunk ${idx+1} uploaded ✓`);

    // Save chunk to temp table
    await supabase.from('file_chunks_temp').insert({
      file_id: fileId, chunk_index: idx,
      tg_results: tgResults, chunk_name: zipName,
      chunk_size: chunkBuf.length,
      user_id: req.user.userId,
      created_at: new Date().toISOString()
    });

    // Last chunk: save file record
    if (isLast) {
      const { data: folder } = await supabase.from('folders').select('id').eq('id', folderId).eq('user_id', req.user.userId).single();
      if (!folder) throw new Error('Folder not found');

      await new Promise(r => setTimeout(r, 500));

      const { data: allChunks } = await supabase.from('file_chunks_temp')
        .select('*').eq('file_id', fileId).order('chunk_index');

      console.log(`[${fileId}] All done! ${allChunks?.length} chunks in DB`);

      const { data: existingFile } = await supabase.from('files').select('id').eq('id', fileId).single();
      if (!existingFile) {
        const { error: dbErr } = await supabase.from('files').insert({
          id: fileId, user_id: req.user.userId, folder_id: folderId,
          original_name: fileName, size: parseInt(fileSize) || 0,
          total_chunks: allChunks?.length || total,
          chunks: JSON.stringify((allChunks || []).map(c => ({
            index: c.chunk_index,
            zipName: c.chunk_name,
            size: c.chunk_size,
            telegram: c.tg_results
          }))),
          download_count: 0, created_at: new Date().toISOString()
        });
        if (dbErr) throw dbErr;
        try { await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: parseInt(fileSize) || 0 }); } catch {}
      }

      try { await supabase.from('file_chunks_temp').delete().eq('file_id', fileId); } catch {}
      return res.json({ done: true, fileId, chunks: allChunks?.length });
    }

    res.json({ done: false, received: idx + 1, total });
  } catch (e) {
    if (chunkPath) try { fs.unlinkSync(chunkPath); } catch {}
    console.error(`Upload error [${req.body?.fileId}] chunk ${req.body?.chunkIndex}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== DOWNLOAD =====
// Each chunk ZIP → download from Telegram → unzip → stream to user
// User gets original file seamlessly
app.get('/api/file/:fileId', auth, async (req, res) => {
  try {
    const { password } = req.query;
    const { data: file } = await supabase.from('files').select('*').eq('id', req.params.fileId).single();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const { data: folder } = await supabase.from('folders').select('password_hash').eq('id', file.folder_id).single();
    if (folder?.password_hash) {
      if (!password) return res.status(403).json({ error: 'Password required' });
      const valid = await bcrypt.compare(password, folder.password_hash);
      if (!valid) return res.status(403).json({ error: 'Wrong password' });
    }

    const chunks = JSON.parse(file.chunks || '[]');
    chunks.sort((a, b) => (a.index || 0) - (b.index || 0));
    const zipPw = password || 'cv_secure';

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', file.size);

    // Stream each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const tg = chunk.telegram?.[0];
      if (!tg) throw new Error(`No telegram data for chunk ${i + 1}`);

      const botToken = BOTS[tg.botIndex]?.token;
      const url = await getTgFileUrl(botToken, tg.fileId);
      if (!url) throw new Error(`Cannot get URL for chunk ${i + 1}`);

      // Download ZIP
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
      const zipBuf = Buffer.from(response.data);

      // Unzip in memory using temp dir
      const tmpDir = `/tmp/dl_${file.id}_${i}_${Date.now()}`;
      const tmpZip = `${tmpDir}.zip`;
      try {
        fs.writeFileSync(tmpZip, zipBuf);
        fs.mkdirSync(tmpDir, { recursive: true });
        spawnSync('unzip', ['-P', zipPw, '-o', tmpZip, '-d', tmpDir], { timeout: 30000 });

        const extracted = fs.readdirSync(tmpDir).filter(f => !f.startsWith('.'));
        if (!extracted.length) throw new Error(`Unzip failed for chunk ${i + 1}`);

        const extractedPath = path.join(tmpDir, extracted[0]);
        const data = fs.readFileSync(extractedPath);

        // Write chunk data to response
        await new Promise((resolve, reject) => {
          res.write(data, (err) => err ? reject(err) : resolve());
        });
      } finally {
        try { fs.unlinkSync(tmpZip); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }

    res.end();
    try { await supabase.from('files').update({ download_count: (file.download_count || 0) + 1 }).eq('id', file.id); } catch {}
  } catch (e) {
    console.error('Download error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  }
});

// ===== FOLDERS =====
app.get('/api/folders', auth, async (req, res) => {
  try {
    let q = supabase.from('folders').select('id,name,parent_id,created_at').eq('user_id', req.user.userId);
    q = req.query.parent_id ? q.eq('parent_id', req.query.parent_id) : q.is('parent_id', null);
    const { data, error } = await q.order('name');
    if (error) throw error;
    res.json({ folders: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders', auth, async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const folderId = uuidv4();
    const rawPw = genPassword(14);
    const pwHash = await bcrypt.hash(rawPw, 10);
    const { error } = await supabase.from('folders').insert({
      id: folderId, user_id: req.user.userId, parent_id: parent_id || null,
      name, password_hash: pwHash, created_at: new Date().toISOString()
    });
    if (error) throw error;
    res.json({ folder: { id: folderId, name, parent_id: parent_id || null }, password: rawPw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/folders/:id', auth, async (req, res) => {
  try {
    const { data: f } = await supabase.from('folders').select('id').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    await supabase.from('folders').update({ name: req.body.name }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/folders/:id', auth, async (req, res) => {
  try {
    const { data: f } = await supabase.from('folders').select('id').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    await supabase.from('folders').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders/:id/verify', auth, async (req, res) => {
  try {
    const { data: f } = await supabase.from('folders').select('password_hash').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    const valid = await bcrypt.compare(req.body.password, f.password_hash);
    res.json({ valid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== FILES =====
app.get('/api/files', auth, async (req, res) => {
  try {
    const { folder_id } = req.query;
    if (!folder_id) return res.status(400).json({ error: 'folder_id required' });
    const { data, error } = await supabase.from('files')
      .select('id,original_name,size,total_chunks,download_count,created_at')
      .eq('user_id', req.user.userId).eq('folder_id', folder_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ files: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/files/:id', auth, async (req, res) => {
  try {
    const { data: f } = await supabase.from('files').select('id,size').eq('id', req.params.id).eq('user_id', req.user.userId).single();
    if (!f) return res.status(404).json({ error: 'Not found' });
    await supabase.from('files').delete().eq('id', req.params.id);
    if (f.size > 0) { try { await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: -f.size }); } catch {} }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== PAYMENT =====
app.post('/api/payment', auth, async (req, res) => {
  try {
    const { transactionId, nagadNumber, amount, storageTb, storageGb, months } = req.body;
    if (!transactionId || !nagadNumber) return res.status(400).json({ error: 'All fields required' });
    const { data: ex } = await supabase.from('payments').select('id').eq('transaction_id', transactionId).single();
    if (ex) return res.status(400).json({ error: 'Transaction ID already used' });
    const { data: user } = await supabase.from('users').select('email,name').eq('id', req.user.userId).single();
    await supabase.from('payments').insert({
      user_id: req.user.userId, transaction_id: transactionId,
      amount: parseFloat(amount), bkash_number: nagadNumber,
      storage_tb: parseFloat(storageTb) || 0, months: parseInt(months) || 3,
      status: 'pending', created_at: new Date().toISOString()
    });
    const msg = `💳 Payment!\nUser: ${user?.name} (${user?.email})\nTxn: ${transactionId}\nAmount: ৳${amount}\nNagad: ${nagadNumber}\n${storageGb||'?'}GB × ${months}মাস`;
    try { await axios.post(`https://api.telegram.org/bot${BOTS[0].token}/sendMessage`, { chat_id: ADMIN_TG_ID, text: msg }); } catch {}
    res.json({ success: true, message: '✅ Payment submitted! ১ ঘণ্টার মধ্যে activate হবে।' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ADMIN =====
app.get('/api/admin/stats', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const [{ count: userCount }, { count: fileCount }, { count: pendingCount }, { data: revenue }] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('files').select('*', { count: 'exact', head: true }),
      supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('payments').select('amount').eq('status', 'approved'),
    ]);
    res.json({ userCount, fileCount, pendingCount, totalRevenue: (revenue||[]).reduce((a,p)=>a+(p.amount||0),0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/payments', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('payments').select('*').order('created_at', { ascending: false });
  res.json({ payments: data || [] });
});

app.post('/api/admin/approve', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data: p } = await supabase.from('payments').select('*').eq('transaction_id', req.body.transactionId).single();
  if (!p) return res.status(404).json({ error: 'Not found' });
  const bytes = (p.storage_tb || 0.25) * 1099511627776;
  const exp = new Date(); exp.setMonth(exp.getMonth() + p.months);
  await supabase.from('payments').update({ status: 'approved' }).eq('id', p.id);
  await supabase.from('users').update({ plan: `${p.storage_tb}TB`, plan_expires_at: exp.toISOString(), storage_limit: bytes }).eq('id', p.user_id);
  res.json({ success: true });
});

app.post('/api/admin/reject', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  await supabase.from('payments').update({ status: 'rejected' }).eq('transaction_id', req.body.transactionId);
  res.json({ success: true });
});

app.get('/api/admin/users', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('users').select('id,email,name,plan,storage_used,storage_limit,created_at,plan_expires_at').order('created_at', { ascending: false });
  res.json({ users: data || [] });
});

app.get('/api/admin/user/:userId/folders', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('folders').select('id,name,created_at').eq('user_id', req.params.userId);
  res.json({ folders: data || [] });
});

app.get('/api/admin/config', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try { const { data } = await supabase.from('site_config').select('*').eq('id', 1).single(); res.json({ config: data || {} }); }
  catch { res.json({ config: {} }); }
});

app.post('/api/admin/config', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { key, ...config } = req.body;
  try {
    const { error } = await supabase.from('site_config').upsert({ id: 1, ...config, updated_at: new Date().toISOString() });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/logo', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    await supabase.from('site_config').upsert({ id: 1, logo_base64: req.body.imageBase64, logo_mime: req.body.mimeType || 'image/png', updated_at: new Date().toISOString() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/file-status/:fileId', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('files').select('id').eq('id', req.params.fileId).eq('user_id', req.user.userId).single();
    res.json({ exists: !!data });
  } catch { res.json({ exists: false }); }
});

app.get('/api/config', async (req, res) => {
  try {
    const { data } = await supabase.from('site_config').select('*').eq('id', 1).single();
    res.json({
      nagadNumber: NAGAD_NUMBER,
      siteName: data?.site_name || 'CloudVault',
      logoBase64: data?.logo_base64 || null,
      logoMime: data?.logo_mime || 'image/png',
      notice: data?.notice || null,
      freeStorageGb: data?.free_storage_gb || 100,
      discountPercent: data?.discount_percent || 0,
      heroH1: data?.hero_h1 || 'Your Files.',
      heroH2: data?.hero_h2 || 'Safe Forever.',
      heroSub: data?.hero_sub || null,
      loginBonusEnabled: data?.login_bonus_enabled || false,
      loginBonusGb: data?.login_bonus_gb || 2,
      loginBonusStart: data?.login_bonus_start || null,
      loginBonusEnd: data?.login_bonus_end || null,
      adsEnabled: data?.ads_enabled || false,
      adBanner: data?.ads_enabled ? (data?.ad_banner || null) : null,
      adSocialBar: data?.ads_enabled ? (data?.ad_social_bar || null) : null,
      adPopunder: data?.ads_enabled ? (data?.ad_popunder || null) : null,
      adSmartlink: data?.ad_smartlink || null,
    });
  } catch {
    res.json({ nagadNumber: NAGAD_NUMBER, siteName: 'CloudVault', notice: null, freeStorageGb: 100, discountPercent: 0 });
  }
});

app.get('/', (req, res) => res.json({ status: 'CloudVault API v12 ✅ — Per-chunk ZIP' }));

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`CloudVault API v12 on port ${PORT}`));
server.setTimeout(300000); // 5 min per request
server.keepAliveTimeout = 310000;
server.headersTimeout = 320000;
