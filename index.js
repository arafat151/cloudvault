const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
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

// 20MB max per chunk request
const upload = multer({
  dest: '/tmp/cv_up/',
  limits: { fileSize: 20 * 1024 * 1024 }
});

if (!fs.existsSync('/tmp/cv_up/')) fs.mkdirSync('/tmp/cv_up/', { recursive: true });

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

// Upload chunk buffer directly to Telegram (no ZIP, no disk assembly)
async function sendChunkToTelegram(botToken, channelId, buffer, fileName) {
  const form = new FormData();
  form.append('chat_id', channelId);
  // Obscured name in Telegram
  const tgName = `cv_${Date.now()}_${Math.random().toString(36).slice(2,7)}.dat`;
  form.append('document', buffer, { filename: tgName, knownLength: buffer.length });
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendDocument`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180000 }
  );
  if (res.data.ok) return { fileId: res.data.result.document.file_id, msgId: res.data.result.message_id };
  throw new Error('Telegram upload failed');
}

async function getTgFileUrl(botToken, fileId) {
  const res = await axios.get(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
    { timeout: 15000 }
  );
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
    const { error } = await supabase.from('users').insert({
      id: userId, email, password: hashed, name,
      plan: 'free', storage_used: 0, storage_limit: 107374182400,
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

// ========== CHUNK UPLOAD ==========
// Each 15MB chunk: receive → upload to Telegram → delete from disk
// No disk assembly needed! Works within Render free tier limits
app.post('/api/chunk/upload', auth, upload.single('chunk'), async (req, res) => {
  let filePath = req.file?.path;
  try {
    const { fileId, chunkIndex, totalChunks, fileName, folderId, fileSize } = req.body;
    if (!fileId || !req.file) return res.status(400).json({ error: 'Missing data' });

    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);

    // Read chunk (15MB max) and immediately delete from disk
    const chunkBuffer = fs.readFileSync(filePath);
    fs.unlinkSync(filePath); filePath = null;

    // Upload to both Telegram bots simultaneously
    const [tg1, tg2] = await Promise.allSettled([
      sendChunkToTelegram(BOTS[0].token, BOTS[0].channel, chunkBuffer, fileName),
      sendChunkToTelegram(BOTS[1].token, BOTS[1].channel, chunkBuffer, fileName),
    ]);

    const tgResults = [
      tg1.status === 'fulfilled' ? { botIndex: 0, ...tg1.value } : null,
      tg2.status === 'fulfilled' ? { botIndex: 1, ...tg2.value } : null,
    ].filter(Boolean);

    if (!tgResults.length) throw new Error('All Telegram uploads failed');

    const chunkMeta = {
      chunk_index: idx,
      tg_results: tgResults,
      chunk_size: chunkBuffer.length,
      chunk_name: `chunk_${idx}_${fileName}`
    };

    // Last chunk — save file record
    if (idx === total - 1) {
      // Get all previous chunks
      const { data: prevChunks } = await supabase
        .from('file_chunks_temp')
        .select('*')
        .eq('file_id', fileId)
        .order('chunk_index');

      const allChunks = [...(prevChunks || []), chunkMeta];
      allChunks.sort((a, b) => a.chunk_index - b.chunk_index);

      // Check folder ownership
      const { data: folder } = await supabase.from('folders')
        .select('id').eq('id', folderId).eq('user_id', req.user.userId).single();
      if (!folder) throw new Error('Folder not found');

      // Check duplicate
      const { data: existingFile } = await supabase.from('files').select('id').eq('id', fileId).single();
      if (!existingFile) {
        const { error: dbErr } = await supabase.from('files').insert({
          id: fileId,
          user_id: req.user.userId,
          folder_id: folderId,
          original_name: fileName,
          size: parseInt(fileSize) || 0,
          total_chunks: total,
          chunks: JSON.stringify(allChunks.map(c => ({
            index: c.chunk_index,
            fileName: c.chunk_name,
            size: c.chunk_size,
            telegram: c.tg_results,
          }))),
          download_count: 0,
          created_at: new Date().toISOString()
        });
        if (dbErr) throw dbErr;

        try { await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: parseInt(fileSize) || 0 }); } catch {}
      }

      // Clean temp
      try { await supabase.from('file_chunks_temp').delete().eq('file_id', fileId); } catch {}
      return res.json({ done: true, fileId, chunkIndex: idx });
    }

    // Save chunk to temp table
    await supabase.from('file_chunks_temp').insert({
      file_id: fileId,
      chunk_index: idx,
      tg_results: tgResults,
      chunk_name: chunkMeta.chunk_name,
      chunk_size: chunkMeta.chunk_size,
      user_id: req.user.userId,
      created_at: new Date().toISOString()
    });

    res.json({ done: false, chunkIndex: idx, received: idx + 1, total });
  } catch (e) {
    if (filePath) try { fs.unlinkSync(filePath); } catch {}
    console.error('Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========== DOWNLOAD ==========
// Streams chunks from Telegram and reassembles them for the user
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
    
    // Set download headers
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', file.size);

    // Stream all chunks in order
    for (const chunk of chunks) {
      const tg = chunk.telegram?.[0];
      if (!tg) throw new Error('No telegram data for chunk ' + chunk.index);
      const botToken = BOTS[tg.botIndex]?.token;
      const url = await getTgFileUrl(botToken, tg.fileId);
      if (!url) throw new Error('Could not get Telegram URL for chunk ' + chunk.index);
      
      await new Promise((resolve, reject) => {
        axios.get(url, { responseType: 'stream', timeout: 300000 })
          .then(stream => {
            stream.data.on('end', resolve);
            stream.data.on('error', reject);
            stream.data.pipe(res, { end: false });
          })
          .catch(reject);
      });
    }

    res.end();
    try { await supabase.from('files').update({ download_count: (file.download_count||0)+1 }).eq('id', req.params.fileId); } catch {}
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  }
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
      parent_id: parent_id || null, name,
      password_hash: pwHash, created_at: new Date().toISOString()
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
    const { transactionId, nagadNumber, amount, storageTb, months } = req.body;
    if (!transactionId || !nagadNumber) return res.status(400).json({ error: 'All fields required' });
    const { data: ex } = await supabase.from('payments').select('id').eq('transaction_id', transactionId).single();
    if (ex) return res.status(400).json({ error: 'Transaction ID already used' });
    const { data: user } = await supabase.from('users').select('email,name').eq('id', req.user.userId).single();
    await supabase.from('payments').insert({
      user_id: req.user.userId, transaction_id: transactionId,
      amount: parseFloat(amount), bkash_number: nagadNumber,
      storage_tb: parseInt(storageTb)||1, months: parseInt(months)||6,
      status: 'pending', created_at: new Date().toISOString()
    });
    const msg = `💳 নতুন Payment!\n\nUser: ${user?.name} (${user?.email})\nTxn: ${transactionId}\nAmount: ৳${amount}\nNagad: ${nagadNumber}\n${storageTb}TB × ${months}মাস`;
    try { await axios.post(`https://api.telegram.org/bot${BOTS[0].token}/sendMessage`, { chat_id: ADMIN_TG_ID, text: msg }); } catch {}
    res.json({ success: true, message: 'Payment submitted! ১ ঘণ্টার মধ্যে activate হবে।' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== ADMIN ==========
app.get('/api/admin/stats', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const { count: userCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: fileCount } = await supabase.from('files').select('*', { count: 'exact', head: true });
    const { count: pendingCount } = await supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'pending');
    const { data: revenue } = await supabase.from('payments').select('amount').eq('status', 'approved');
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
  const bytes = p.storage_tb * 1099511627776;
  const exp = new Date(); exp.setMonth(exp.getMonth()+p.months);
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

// Upload logo image to Supabase (base64)
app.post('/api/admin/logo', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image data' });
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
      logoEmoji: data?.logo_emoji||'☁️',
      logoBase64: data?.logo_base64||null,
      logoMime: data?.logo_mime||null,
      notice: data?.notice||null,
      freeStorageGb: data?.free_storage_gb||100,
      pricePerTb: data?.price_per_tb||5,
      heroH1: data?.hero_h1||'Your Files.',
      heroH2: data?.hero_h2||'Safe Forever.',
      heroSub: data?.hero_sub||null,
    });
  } catch {
    res.json({ nagadNumber: NAGAD_NUMBER, siteName: 'CloudVault', logoEmoji: '☁️', notice: null, freeStorageGb: 100, pricePerTb: 5 });
  }
});

app.get('/', (req, res) => res.json({ status: 'CloudVault API v7 ✅' }));

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`CloudVault API v7 on port ${PORT}`));
server.setTimeout(600000);
server.keepAliveTimeout = 610000;
server.headersTimeout = 620000;
