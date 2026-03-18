const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
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
const TG_MAX_BYTES = 1850 * 1024 * 1024; // 1.85GB Telegram limit

const BOTS = [
  { token: process.env.BOT1_TOKEN, channel: process.env.CH1_ID },
  { token: process.env.BOT2_TOKEN, channel: process.env.CH2_ID },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const upload = multer({ dest: '/tmp/cv_up/', limits: { fileSize: 20 * 1024 * 1024 } });
if (!fs.existsSync('/tmp/cv_up/')) fs.mkdirSync('/tmp/cv_up/', { recursive: true });
if (!fs.existsSync('/tmp/cv_zip/')) fs.mkdirSync('/tmp/cv_zip/', { recursive: true });
if (!fs.existsSync('/tmp/cv_asm/')) fs.mkdirSync('/tmp/cv_asm/', { recursive: true });

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

// Create ZIP with password using system zip command
function createZip(inputPath, innerName, password, outputPath) {
  const dir = path.dirname(outputPath);
  const outBase = path.basename(outputPath);
  const renamedPath = path.join(dir, innerName);
  fs.copyFileSync(inputPath, renamedPath);
  try {
    execFileSync('zip', ['-P', password, outBase, innerName], { cwd: dir, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
  } finally {
    try { fs.unlinkSync(renamedPath); } catch {}
  }
  return fs.existsSync(outputPath);
}

async function sendToTelegram(botToken, channelId, filePath, zipName) {
  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('document', fs.createReadStream(filePath), { filename: zipName });
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendDocument`, form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 600000 }
  );
  if (res.data.ok) return { fileId: res.data.result.document.file_id, msgId: res.data.result.message_id };
  throw new Error('Telegram upload failed');
}

async function getTgFileUrl(botToken, fileId) {
  const res = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, { timeout: 15000 });
  if (res.data.ok) return `https://api.telegram.org/file/bot${botToken}/${res.data.result.file_path}`;
  return null;
}

// ========== AUTH ==========
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
    const { data: ex } = await supabase.from('users').select('id').eq('email', email).single();
    if (ex) return res.status(400).json({ error: 'Email already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    // Get free storage from config
    let freeGb = 100;
    try {
      const { data: cfg } = await supabase.from('site_config').select('free_storage_gb').eq('id', 1).single();
      if (cfg?.free_storage_gb) freeGb = cfg.free_storage_gb;
    } catch {}
    const { error } = await supabase.from('users').insert({
      id: userId, email, password: hashed, name, plan: 'free',
      storage_used: 0, storage_limit: freeGb * 1024 * 1024 * 1024,
      created_at: new Date().toISOString()
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

// ========== LOGIN BONUS ==========
app.post('/api/claim-bonus', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    // Check config
    const { data: cfg } = await supabase.from('site_config').select('login_bonus_enabled,login_bonus_gb,login_bonus_start,login_bonus_end').eq('id', 1).single();
    if (!cfg?.login_bonus_enabled) return res.status(400).json({ error: 'Bonus not active' });
    if (cfg.login_bonus_start && today < cfg.login_bonus_start) return res.status(400).json({ error: 'Bonus not started yet' });
    if (cfg.login_bonus_end && today > cfg.login_bonus_end) return res.status(400).json({ error: 'Bonus period ended' });
    // Check already claimed today
    const { data: existing } = await supabase.from('login_bonus_claims').select('id').eq('user_id', req.user.userId).eq('claim_date', today).single();
    if (existing) return res.status(400).json({ error: 'Already claimed today!' });
    const bonusGb = cfg.login_bonus_gb || 2;
    const bonusBytes = bonusGb * 1024 * 1024 * 1024;
    // Add bonus
    await supabase.from('login_bonus_claims').insert({ user_id: req.user.userId, claim_date: today, bonus_gb: bonusGb });
    await supabase.from('users').update({ storage_limit: supabase.raw(`storage_limit + ${bonusBytes}`) }).eq('id', req.user.userId);
    // Simple update via RPC
    try { await supabase.rpc('add_storage_limit', { p_user_id: req.user.userId, bytes: bonusBytes }); } catch {}
    res.json({ success: true, bonusGb, message: `🎉 +${bonusGb}GB bonus added!` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bonus-status', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: cfg } = await supabase.from('site_config').select('login_bonus_enabled,login_bonus_gb,login_bonus_start,login_bonus_end').eq('id', 1).single();
    if (!cfg?.login_bonus_enabled) return res.json({ active: false });
    const todayDate = new Date(today);
    const startDate = cfg.login_bonus_start ? new Date(cfg.login_bonus_start) : null;
    const endDate = cfg.login_bonus_end ? new Date(cfg.login_bonus_end) : null;
    if (startDate && todayDate < startDate) return res.json({ active: false });
    if (endDate && todayDate > endDate) return res.json({ active: false });
    const { data: claimed } = await supabase.from('login_bonus_claims').select('id').eq('user_id', req.user.userId).eq('claim_date', today).single();
    res.json({ active: true, bonusGb: cfg.login_bonus_gb || 2, claimed: !!claimed, endDate: cfg.login_bonus_end });
  } catch (e) { res.json({ active: false }); }
});

// ========== CHUNK UPLOAD ==========
// Browser sends 15MB chunks → server appends to /tmp/cv_asm/fileId
// When all chunks arrive → ZIP the full file → upload ZIP to Telegram → cleanup
// For files > 1.85GB: split assembled file into 1.85GB parts, each gets its own ZIP
app.post('/api/chunk/upload', auth, upload.single('chunk'), async (req, res) => {
  let chunkPath = req.file?.path;
  try {
    const { fileId, chunkIndex, totalChunks, fileName, folderId, fileSize, folderPassword } = req.body;
    if (!fileId || !req.file) return res.status(400).json({ error: 'Missing data' });

    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);
    const asmPath = `/tmp/cv_asm/${fileId}`;

    // Append chunk to assembly file
    const buf = fs.readFileSync(chunkPath);
    fs.unlinkSync(chunkPath); chunkPath = null;
    fs.appendFileSync(asmPath, buf);

    // Not last chunk - just acknowledge
    if (idx < total - 1) {
      return res.json({ done: false, received: idx + 1, total });
    }

    // ===== ALL CHUNKS RECEIVED =====
    console.log(`Assembly complete: ${fileName} (${fileId})`);

    // Check duplicate
    const { data: exists } = await supabase.from('files').select('id').eq('id', fileId).single();
    if (exists) {
      try { fs.unlinkSync(asmPath); } catch {}
      return res.json({ done: true, fileId });
    }

    const { data: folder } = await supabase.from('folders').select('id').eq('id', folderId).eq('user_id', req.user.userId).single();
    if (!folder) { try { fs.unlinkSync(asmPath); } catch {} throw new Error('Folder not found'); }

    const asmSize = fs.statSync(asmPath).size;
    const zipPw = folderPassword || 'cv_default_2024';
    const numParts = Math.ceil(asmSize / TG_MAX_BYTES);
    const tgParts = [];

    for (let p = 0; p < numParts; p++) {
      const partStart = p * TG_MAX_BYTES;
      const partSize = Math.min(TG_MAX_BYTES, asmSize - partStart);
      const innerName = numParts > 1 ? `${fileName}.part${p+1}of${numParts}` : fileName;
      const zipName = numParts > 1
        ? `cv_part${String(p+1).padStart(3,'0')}of${String(numParts).padStart(3,'0')}_${fileId.slice(-6)}.zip`
        : `${fileName.replace(/[^a-zA-Z0-9._-]/g,'_')}_${fileId.slice(-6)}.zip`;
      const partPath = `/tmp/cv_asm/${fileId}_p${p}`;
      const zipPath = `/tmp/cv_zip/${fileId}_p${p}.zip`;

      // Extract part from assembled file
      const fd = fs.openSync(asmPath, 'r');
      const partBuf = Buffer.allocUnsafe(partSize);
      fs.readSync(fd, partBuf, 0, partSize, partStart);
      fs.closeSync(fd);
      fs.writeFileSync(partPath, partBuf);

      // Create password-protected ZIP
      const zipOk = createZip(partPath, innerName, zipPw, zipPath);
      try { fs.unlinkSync(partPath); } catch {}
      if (!zipOk) throw new Error(`ZIP failed for part ${p+1}`);

      console.log(`Uploading part ${p+1}/${numParts} to Telegram...`);

      const [tg1, tg2] = await Promise.allSettled([
        sendToTelegram(BOTS[0].token, BOTS[0].channel, zipPath, zipName),
        sendToTelegram(BOTS[1].token, BOTS[1].channel, zipPath, zipName),
      ]);
      try { fs.unlinkSync(zipPath); } catch {}

      const tgResults = [
        tg1.status === 'fulfilled' ? { botIndex: 0, ...tg1.value } : null,
        tg2.status === 'fulfilled' ? { botIndex: 1, ...tg2.value } : null,
      ].filter(Boolean);

      if (!tgResults.length) throw new Error(`Telegram upload failed for part ${p+1}`);
      tgParts.push({ index: p, fileName: innerName, zipName, size: partSize, telegram: tgResults });
    }

    try { fs.unlinkSync(asmPath); } catch {}

    const { error: dbErr } = await supabase.from('files').insert({
      id: fileId, user_id: req.user.userId, folder_id: folderId,
      original_name: fileName, size: parseInt(fileSize) || asmSize,
      total_chunks: numParts,
      chunks: JSON.stringify(tgParts),
      download_count: 0, created_at: new Date().toISOString()
    });
    if (dbErr) throw dbErr;

    try { await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: parseInt(fileSize) || asmSize }); } catch {}

    console.log(`Upload done: ${fileName} → ${numParts} Telegram ZIP(s)`);
    res.json({ done: true, fileId, parts: numParts });

  } catch (e) {
    if (chunkPath) try { fs.unlinkSync(chunkPath); } catch {}
    const asmPath = `/tmp/cv_asm/${req.body?.fileId}`;
    if (req.body?.fileId && fs.existsSync(asmPath)) try { fs.unlinkSync(asmPath); } catch {}
    console.error('Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========== DOWNLOAD ==========
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

    const parts = JSON.parse(file.chunks || '[]');

    if (parts.length === 1) {
      const part = parts[0];
      const tg = part.telegram?.[0];
      if (tg) {
        const url = await getTgFileUrl(BOTS[tg.botIndex]?.token, tg.fileId);
        if (url) {
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(part.zipName||file.original_name+'.zip')}"`);
          res.setHeader('Content-Type', 'application/zip');
          const stream = await axios.get(url, { responseType: 'stream', timeout: 600000 });
          res.on('close', () => stream.data.destroy());
          stream.data.on('error', () => {});
          stream.data.pipe(res);
          try { await supabase.from('files').update({ download_count: (file.download_count||0)+1 }).eq('id', file.id); } catch {}
          return;
        }
      }
    }

    res.json({
      multiPart: true, totalParts: parts.length,
      fileName: file.original_name, totalSize: file.size,
      parts: parts.map((p, i) => ({
        part: i+1, zipName: p.zipName||`part${i+1}.zip`, size: p.size,
        downloadUrl: `/api/file/${file.id}/part/${i}?password=${encodeURIComponent(password||'')}`
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/file/:fileId/part/:partIdx', auth, async (req, res) => {
  try {
    const { password } = req.query;
    const { data: file } = await supabase.from('files').select('*').eq('id', req.params.fileId).single();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const { data: folder } = await supabase.from('folders').select('password_hash').eq('id', file.folder_id).single();
    if (folder?.password_hash && password) {
      const valid = await bcrypt.compare(password, folder.password_hash);
      if (!valid) return res.status(403).json({ error: 'Wrong password' });
    }

    const parts = JSON.parse(file.chunks || '[]');
    const part = parts[parseInt(req.params.partIdx)];
    if (!part) return res.status(404).json({ error: 'Part not found' });

    const tg = part.telegram?.[0];
    if (tg) {
      const url = await getTgFileUrl(BOTS[tg.botIndex]?.token, tg.fileId);
      if (url) {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(part.zipName||'part.zip')}"`);
        res.setHeader('Content-Type', 'application/zip');
        const stream = await axios.get(url, { responseType: 'stream', timeout: 600000 });
        res.on('close', () => stream.data.destroy());
        stream.data.on('error', () => {});
        stream.data.pipe(res);
        return;
      }
    }
    res.status(500).json({ error: 'No source available' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== FOLDERS ==========
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
      id: folderId, user_id: req.user.userId,
      parent_id: parent_id||null, name, password_hash: pwHash,
      created_at: new Date().toISOString()
    });
    if (error) throw error;
    res.json({ folder: { id: folderId, name, parent_id: parent_id||null }, password: rawPw });
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

// ========== FILES ==========
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

// ========== PAYMENT ==========
app.post('/api/payment', auth, async (req, res) => {
  try {
    const { transactionId, nagadNumber, amount, storageTb, storageGb, months } = req.body;
    if (!transactionId || !nagadNumber) return res.status(400).json({ error: 'All fields required' });
    const { data: ex } = await supabase.from('payments').select('id').eq('transaction_id', transactionId).single();
    if (ex) return res.status(400).json({ error: 'Transaction ID already used' });
    const { data: user } = await supabase.from('users').select('email,name').eq('id', req.user.userId).single();
    const gb = storageGb || (storageTb * 1024);
    await supabase.from('payments').insert({
      user_id: req.user.userId, transaction_id: transactionId,
      amount: parseFloat(amount), bkash_number: nagadNumber,
      storage_tb: parseFloat(storageTb)||0, months: parseInt(months)||3,
      status: 'pending', created_at: new Date().toISOString()
    });
    const msg = `💳 নতুন Payment!\n\nUser: ${user?.name} (${user?.email})\nTxn: ${transactionId}\nAmount: ৳${amount}\nNagad: ${nagadNumber}\n${gb}GB × ${months}মাস`;
    try { await axios.post(`https://api.telegram.org/bot${BOTS[0].token}/sendMessage`, { chat_id: ADMIN_TG_ID, text: msg }); } catch {}
    res.json({ success: true, message: 'Payment submitted! ১ ঘণ্টার মধ্যে activate হবে।' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== ADMIN ==========
app.get('/api/admin/stats', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const [{ count: userCount }, { count: fileCount }, { count: pendingCount }, { data: revenue }] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('files').select('*', { count: 'exact', head: true }),
      supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('payments').select('amount').eq('status', 'approved'),
    ]);
    const totalRevenue = (revenue||[]).reduce((a,p)=>a+(p.amount||0),0);
    res.json({ userCount, fileCount, pendingCount, totalRevenue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/payments', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('payments').select('*').order('created_at', { ascending: false });
  res.json({ payments: data||[] });
});

app.post('/api/admin/approve', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data: p } = await supabase.from('payments').select('*').eq('transaction_id', req.body.transactionId).single();
  if (!p) return res.status(404).json({ error: 'Not found' });
  const gb = req.body.customGb || (p.storage_tb >= 1 ? p.storage_tb * 1024 : p.storage_tb * 1024);
  const bytes = (p.storage_tb || 0.25) * 1099511627776;
  const exp = new Date(); exp.setMonth(exp.getMonth()+p.months);
  await supabase.from('payments').update({ status: 'approved' }).eq('id', p.id);
  await supabase.from('users').update({
    plan: `${p.storage_tb}TB`, plan_expires_at: exp.toISOString(), storage_limit: bytes
  }).eq('id', p.user_id);
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
  res.json({ users: data||[] });
});

app.get('/api/admin/user/:userId/folders', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('folders').select('id,name,created_at').eq('user_id', req.params.userId);
  res.json({ folders: data||[] });
});

app.get('/api/admin/config', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const { data } = await supabase.from('site_config').select('*').eq('id', 1).single();
    res.json({ config: data||{} });
  } catch { res.json({ config: {} }); }
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
    const { imageBase64, mimeType } = req.body;
    await supabase.from('site_config').upsert({ id: 1, logo_base64: imageBase64, logo_mime: mimeType||'image/png', updated_at: new Date().toISOString() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config', async (req, res) => {
  try {
    const { data } = await supabase.from('site_config').select('*').eq('id', 1).single();
    res.json({
      nagadNumber: NAGAD_NUMBER,
      siteName: data?.site_name||'CloudVault',
      logoBase64: data?.logo_base64||null,
      logoMime: data?.logo_mime||'image/png',
      notice: data?.notice||null,
      freeStorageGb: data?.free_storage_gb||100,
      pricePerTb: data?.price_per_tb||5,
      discountPercent: data?.discount_percent||0,
      heroH1: data?.hero_h1||'Your Files.',
      heroH2: data?.hero_h2||'Safe Forever.',
      heroSub: data?.hero_sub||null,
      loginBonusEnabled: data?.login_bonus_enabled||false,
      loginBonusGb: data?.login_bonus_gb||2,
      loginBonusStart: data?.login_bonus_start||null,
      loginBonusEnd: data?.login_bonus_end||null,
      adScript: data?.ads_enabled ? (data?.ad_script||null) : null,
      adsEnabled: data?.ads_enabled||false,
    });
  } catch {
    res.json({ nagadNumber: NAGAD_NUMBER, siteName: 'CloudVault', notice: null, freeStorageGb: 100, pricePerTb: 5, discountPercent: 0 });
  }
});

app.get('/', (req, res) => res.json({ status: 'CloudVault API v8 ✅' }));

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`CloudVault API v8 on port ${PORT}`));
server.setTimeout(1800000);
server.keepAliveTimeout = 1810000;
server.headersTimeout = 1820000;
