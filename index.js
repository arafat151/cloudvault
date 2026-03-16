const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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

// Multer — chunks saved to /tmp/cv_uploads/
const upload = multer({
  dest: '/tmp/cv_uploads/',
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB max per chunk
});

['/tmp/cv_uploads/', '/tmp/cv_zips/'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

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

// Create password-protected ZIP from a buffer
function makeZip(fileBuffer, fileName, zipPassword) {
  const tmpDir = `/tmp/cv_zips/${Date.now()}_${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputFile = path.join(tmpDir, fileName);
  const zipFile = path.join(tmpDir, 'archive.zip');
  try {
    fs.writeFileSync(inputFile, fileBuffer);
    // Create password-protected zip
    execSync(`cd "${tmpDir}" && zip -P "${zipPassword}" archive.zip "${fileName}"`, { timeout: 120000 });
    const zipBuffer = fs.readFileSync(zipFile);
    return zipBuffer;
  } finally {
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function sendToTelegram(botToken, channelId, fileBuffer, zipFileName) {
  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('document', fileBuffer, { filename: zipFileName, knownLength: fileBuffer.length });
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendDocument`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180000 }
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
// Flow: Browser sends 15MB chunk → Server saves to /tmp → wraps in password-ZIP → uploads ZIP to Telegram → deletes /tmp
app.post('/api/chunk/upload', auth, upload.single('chunk'), async (req, res) => {
  let filePath = req.file?.path;
  let zipBuffer = null;
  try {
    const { fileId, chunkIndex, totalChunks, fileName, folderId, fileSize, folderPassword } = req.body;
    if (!fileId || !req.file) return res.status(400).json({ error: 'Missing data' });

    const idx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);

    // Read chunk from disk
    const chunkBuffer = fs.readFileSync(filePath);
    fs.unlinkSync(filePath); filePath = null;

    // ZIP name (shown in Telegram)
    const chunkLabel = total > 1
      ? `${String(idx + 1).padStart(3, '0')}of${String(total).padStart(3, '0')}`
      : '001of001';
    const zipName = `cv_${chunkLabel}_${fileId.slice(-6)}.zip`;
    const innerName = total > 1 ? `${fileName}.part${idx + 1}` : fileName;

    // Use folder password as ZIP password (so Telegram ZIP is locked)
    const zipPw = folderPassword || 'cv_default_2024';
    zipBuffer = makeZip(chunkBuffer, innerName, zipPw);

    // Upload ZIP to both Telegram bots
    const [tg1, tg2] = await Promise.allSettled([
      sendToTelegram(BOTS[0].token, BOTS[0].channel, zipBuffer, zipName),
      sendToTelegram(BOTS[1].token, BOTS[1].channel, zipBuffer, zipName),
    ]);
    zipBuffer = null;

    const tgResults = [
      tg1.status === 'fulfilled' ? { botIndex: 0, ...tg1.value } : null,
      tg2.status === 'fulfilled' ? { botIndex: 1, ...tg2.value } : null,
    ].filter(Boolean);

    if (!tgResults.length) throw new Error('All Telegram uploads failed');

    const chunkMeta = {
      chunk_index: idx,
      tg_results: tgResults,
      chunk_name: innerName,
      zip_name: zipName,
      chunk_size: chunkBuffer?.length || req.file.size
    };

    if (idx === total - 1) {
      // Last chunk — get all previous chunks and save file record
      const { data: prevChunks } = await supabase.from('file_chunks_temp')
        .select('*').eq('file_id', fileId).order('chunk_index');

      const allChunks = [...(prevChunks || []), chunkMeta];
      allChunks.sort((a, b) => a.chunk_index - b.chunk_index);

      const { data: folder } = await supabase.from('folders').select('id').eq('id', folderId).eq('user_id', req.user.userId).single();
      if (!folder) throw new Error('Folder not found');

      // Check if file already exists (prevent duplicate key)
      const { data: existingFile } = await supabase.from('files').select('id').eq('id', fileId).single();
      if (existingFile) {
        await supabase.from('file_chunks_temp').delete().eq('file_id', fileId);
        return res.json({ done: true, fileId, chunkIndex: idx });
      }

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
          zipName: c.zip_name,
          size: c.chunk_size,
          telegram: c.tg_results,
        }))),
        download_count: 0,
        created_at: new Date().toISOString()
      });
      if (dbErr) throw dbErr;

      if (parseInt(fileSize) > 0) {
        try { await supabase.rpc('increment_storage', { p_user_id: req.user.userId, bytes: parseInt(fileSize) }); } catch {}
      }
      try { await supabase.from('file_chunks_temp').delete().eq('file_id', fileId); } catch {}
      return res.json({ done: true, fileId, chunkIndex: idx });
    }

    // Not last chunk — save to temp
    await supabase.from('file_chunks_temp').insert({
      file_id: fileId,
      chunk_index: idx,
      tg_results: tgResults,
      chunk_name: innerName,
      zip_name: zipName,
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
// Downloads the ZIP directly — user extracts with folder password
app.get('/api/file/:fileId', auth, async (req, res) => {
  try {
    const { password } = req.query;
    const { data: file } = await supabase.from('files').select('*').eq('id', req.params.fileId).single();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const { data: folder } = await supabase.from('folders').select('password_hash').eq('id', file.folder_id).single();
    if (folder?.password_hash) {
      if (!password) return res.status(403).json({ error: 'Password required', needPassword: true });
      const valid = await bcrypt.compare(password, folder.password_hash);
      if (!valid) return res.status(403).json({ error: 'Wrong password' });
    }

    const chunks = JSON.parse(file.chunks || '[]');

    if (chunks.length === 1) {
      const chunk = chunks[0];
      const tg = chunk.telegram?.[0];
      if (tg) {
        const botToken = BOTS[tg.botIndex]?.token;
        const url = await getTgFileUrl(botToken, tg.fileId);
        if (url) {
          // Download the ZIP from Telegram and send to user
          const zipName = chunk.zipName || `${file.original_name}.zip`;
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);
          res.setHeader('Content-Type', 'application/zip');
          const stream = await axios.get(url, { responseType: 'stream', timeout: 300000 });
          res.on('error', () => stream.data.destroy());
          stream.data.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
          stream.data.pipe(res);
          try { await supabase.from('files').update({ download_count: (file.download_count || 0) + 1 }).eq('id', req.params.fileId); } catch {}
          return;
        }
      }
    }

    // Multi-part: show download links for each ZIP part
    const parts = chunks.map((chunk, i) => ({
      part: i + 1,
      zipName: chunk.zipName || `part${i+1}.zip`,
      size: chunk.size,
      downloadUrl: `/api/file/${req.params.fileId}/part/${i}?password=${encodeURIComponent(password || '')}`
    }));
    res.json({ multiPart: true, totalParts: chunks.length, fileName: file.original_name, totalSize: file.size, parts });
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

    const chunks = JSON.parse(file.chunks || '[]');
    const chunk = chunks[parseInt(req.params.partIdx)];
    if (!chunk) return res.status(404).json({ error: 'Part not found' });

    const tg = chunk.telegram?.[0];
    if (tg) {
      const botToken = BOTS[tg.botIndex]?.token;
      const url = await getTgFileUrl(botToken, tg.fileId);
      if (url) {
        const zipName = chunk.zipName || `${file.original_name}.part${parseInt(req.params.partIdx)+1}.zip`;
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);
        res.setHeader('Content-Type', 'application/zip');
        const stream = await axios.get(url, { responseType: 'stream', timeout: 300000 });
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
      storage_tb: parseInt(storageTb) || 1, months: parseInt(months) || 6,
      status: 'pending', created_at: new Date().toISOString()
    });
    const msg = `💳 নতুন Payment!\n\nUser: ${user?.name} (${user?.email})\nTxn: ${transactionId}\nAmount: ৳${amount}\nNagad: ${nagadNumber}\n${storageTb}TB × ${months}মাস`;
    await axios.post(`https://api.telegram.org/bot${BOTS[0].token}/sendMessage`, { chat_id: ADMIN_TG_ID, text: msg }).catch(() => {});
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
    const totalRevenue = (revenue || []).reduce((a, p) => a + (p.amount || 0), 0);
    res.json({ userCount, fileCount, pendingCount, totalRevenue });
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
  const bytes = p.storage_tb * 1099511627776;
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
  const { data } = await supabase.from('folders').select('id,name,created_at').eq('user_id', req.params.userId).order('created_at');
  res.json({ folders: data || [] });
});

app.get('/api/admin/config', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('site_config').select('*').eq('id', 1).single();
  res.json({ config: data || {} });
});

app.post('/api/admin/config', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { key, ...config } = req.body;
  const { error } = await supabase.from('site_config').upsert({ id: 1, ...config, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ========== PUBLIC CONFIG ==========
app.get('/api/config', async (req, res) => {
  try {
    const { data } = await supabase.from('site_config').select('*').eq('id', 1).single();
    res.json({
      nagadNumber: NAGAD_NUMBER,
      siteName: data?.site_name || 'CloudVault',
      logoEmoji: data?.logo_emoji || '☁️',
      notice: data?.notice || null,
      freeStorageGb: data?.free_storage_gb || 100,
      pricePerTb: data?.price_per_tb || 5,
      heroH1: data?.hero_h1 || 'Your Files.',
      heroH2: data?.hero_h2 || 'Safe Forever.',
      heroSub: data?.hero_sub || null,
    });
  } catch {
    res.json({ nagadNumber: NAGAD_NUMBER, siteName: 'CloudVault', logoEmoji: '☁️', notice: null, freeStorageGb: 100, pricePerTb: 5 });
  }
});

app.get('/', (req, res) => res.json({ status: 'CloudVault API v5 ✅' }));

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`CloudVault API v5 on port ${PORT}`));
server.setTimeout(600000);
server.keepAliveTimeout = 620000;
server.headersTimeout = 630000;
